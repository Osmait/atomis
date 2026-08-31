// Package main implements golive-instrument: the Atomis source instrumenter
// for Go. It mirrors the runzig/rustlive contract — parse one file, record
// probe insertion points for simple short/var declarations and source markers
// for direct fmt/log statements, then splice the calls into the ORIGINAL text
// so the generated copy keeps every byte and the exact newline count.
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"hash/fnv"
	"sort"
	"strings"
)

type Range struct {
	StartLine   int
	StartColumn int
	EndLine     int
	EndColumn   int
	StartByte   int
	EndByte     int
}

type Probe struct {
	ProbeID       string
	Name          string
	Supported     bool
	Reason        string
	Range         Range
	InsertionByte int // -1 when inactive
	Mode          string
}

type ParseDiagnostic struct {
	Message string
	Line    int
	Column  int
}

type Output struct {
	Generated        string
	HasGenerated     bool
	Probes           []Probe
	ParseDiagnostics []ParseDiagnostic
}

type insertion struct {
	offset int
	text   string
}

type loopMeta struct {
	line     int
	column   int
	variable string
}

func probeID(uri string, r Range, name string) string {
	key := fmt.Sprintf("golive-v1|%s|%d-%d|%s", uri, r.StartByte, r.EndByte, name)
	first := fnv.New64a()
	_, _ = first.Write([]byte(key))
	second := fnv.New64a()
	_, _ = second.Write([]byte(key + "|2"))
	return fmt.Sprintf("%016x%016x", first.Sum64(), second.Sum64())
}

func spanRange(fset *token.FileSet, from token.Pos, to token.Pos) Range {
	start := fset.Position(from)
	end := fset.Position(to)
	return Range{
		StartLine:   start.Line,
		StartColumn: start.Column,
		EndLine:     end.Line,
		EndColumn:   end.Column,
		StartByte:   start.Offset,
		EndByte:     end.Offset,
	}
}

var logTargets = map[string]int{
	"fmt.Print": 1, "fmt.Println": 1, "fmt.Printf": 1,
	"log.Print": 2, "log.Println": 2, "log.Printf": 2,
}

type collector struct {
	fset        *token.FileSet
	uri         string
	fileID      int
	autoInspect bool
	manualIDs   map[string]bool
	initStmts   map[ast.Stmt]bool
	probes      []Probe
	insertions  []insertion
	loops       []loopMeta
}

func (c *collector) active(id string) bool {
	return c.autoInspect || c.manualIDs[id]
}

func (c *collector) recordProbe(ident *ast.Ident, end token.Pos, unsupported string) {
	r := spanRange(c.fset, ident.Pos(), ident.End())
	id := probeID(c.uri, r, ident.Name)
	probe := Probe{
		ProbeID:       id,
		Name:          ident.Name,
		Supported:     unsupported == "",
		Reason:        unsupported,
		Range:         r,
		InsertionByte: -1,
		Mode:          "auto",
	}
	if !c.autoInspect {
		probe.Mode = "manual"
	}
	if unsupported == "" && c.active(id) {
		offset := c.fset.Position(end).Offset
		probe.InsertionByte = offset
		c.insertions = append(c.insertions, insertion{
			offset: offset,
			text: fmt.Sprintf(
				"; __atomis_probe(%q, %d, %d, %q, %s)",
				id, r.StartLine, r.StartColumn, ident.Name, ident.Name,
			),
		})
	}
	c.probes = append(c.probes, probe)
}

func (c *collector) visitStmt(stmt ast.Stmt) {
	switch node := stmt.(type) {
	case *ast.AssignStmt:
		if node.Tok != token.DEFINE || c.initStmts[stmt] {
			return
		}
		if len(node.Lhs) != 1 {
			ident, ok := node.Lhs[0].(*ast.Ident)
			if ok && ident.Name != "_" {
				c.recordProbe(ident, node.End(), "multiple declaration")
			}
			return
		}
		ident, ok := node.Lhs[0].(*ast.Ident)
		if !ok || ident.Name == "_" {
			return
		}
		c.recordProbe(ident, node.End(), "")
	case *ast.DeclStmt:
		decl, ok := node.Decl.(*ast.GenDecl)
		if !ok || decl.Tok != token.VAR {
			return
		}
		for _, spec := range decl.Specs {
			value, ok := spec.(*ast.ValueSpec)
			if !ok || len(value.Names) != 1 {
				continue
			}
			ident := value.Names[0]
			if ident.Name == "_" {
				continue
			}
			if len(value.Values) == 0 {
				c.recordProbe(ident, node.End(), "declaration without initializer")
				continue
			}
			c.recordProbe(ident, node.End(), "")
		}
	case *ast.ExprStmt:
		call, ok := node.X.(*ast.CallExpr)
		if !ok {
			return
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return
		}
		pkg, ok := selector.X.(*ast.Ident)
		if !ok {
			return
		}
		fd, ok := logTargets[pkg.Name+"."+selector.Sel.Name]
		if !ok {
			return
		}
		position := c.fset.Position(node.Pos())
		end := c.fset.Position(node.End()).Offset
		if len(c.loops) > 0 && c.loops[len(c.loops)-1].variable != "" {
			loop := c.loops[len(c.loops)-1]
			c.insertions = append(c.insertions, insertion{
				offset: end,
				text: fmt.Sprintf(
					"; __atomis_log_loop(%d, %d, %d, %d, %d, %d, %q, %s)",
					fd, c.fileID, position.Line, position.Column,
					loop.line, loop.column, loop.variable, loop.variable,
				),
			})
			return
		}
		c.insertions = append(c.insertions, insertion{
			offset: end,
			text: fmt.Sprintf(
				"; __atomis_log(%d, %d, %d, %d)",
				fd, c.fileID, position.Line, position.Column,
			),
		})
	}
}

func firstIdent(expr ast.Expr) string {
	name := ""
	ast.Inspect(expr, func(node ast.Node) bool {
		if name != "" {
			return false
		}
		if ident, ok := node.(*ast.Ident); ok {
			name = ident.Name
			return false
		}
		return true
	})
	return name
}

func (c *collector) walk(node ast.Node) {
	switch typed := node.(type) {
	case *ast.IfStmt:
		if typed.Init != nil {
			c.initStmts[typed.Init] = true
		}
	case *ast.SwitchStmt:
		if typed.Init != nil {
			c.initStmts[typed.Init] = true
		}
	case *ast.TypeSwitchStmt:
		if typed.Init != nil {
			c.initStmts[typed.Init] = true
		}
		// `switch v := x.(type)` — the assign lives in the header; a probe
		// spliced after it lands inside the guard and nothing compiles.
		if typed.Assign != nil {
			c.initStmts[typed.Assign] = true
		}
	case *ast.CommClause:
		// `case v := <-ch:` in a select: same story, the receive is the
		// clause's header, not a body statement.
		if typed.Comm != nil {
			c.initStmts[typed.Comm] = true
		}
	case *ast.ForStmt:
		if typed.Init != nil {
			c.initStmts[typed.Init] = true
		}
		if typed.Post != nil {
			c.initStmts[typed.Post] = true
		}
	}

	switch typed := node.(type) {
	case *ast.ForStmt:
		position := c.fset.Position(typed.For)
		variable := ""
		if typed.Cond != nil {
			variable = firstIdent(typed.Cond)
		}
		c.loops = append(c.loops, loopMeta{position.Line, position.Column, variable})
		c.walkChildren(node)
		c.loops = c.loops[:len(c.loops)-1]
		return
	case *ast.RangeStmt:
		position := c.fset.Position(typed.For)
		variable := ""
		if key, ok := typed.Key.(*ast.Ident); ok && key.Name != "_" {
			variable = key.Name
		} else if value, ok := typed.Value.(*ast.Ident); ok && value.Name != "_" {
			variable = value.Name
		}
		c.loops = append(c.loops, loopMeta{position.Line, position.Column, variable})
		c.walkChildren(node)
		c.loops = c.loops[:len(c.loops)-1]
		return
	}

	if stmt, ok := node.(ast.Stmt); ok {
		c.visitStmt(stmt)
	}
	c.walkChildren(node)
}

func (c *collector) walkChildren(node ast.Node) {
	ast.Inspect(node, func(child ast.Node) bool {
		if child == nil || child == node {
			return child == node
		}
		c.walk(child)
		return false
	})
}

// Instrument parses source and splices probe/log calls into the original
// text, preserving byte order and the newline count.
func Instrument(source string, uri string, autoInspect bool, manualIDs []string, fileID int) Output {
	if strings.Contains(source, "__atomis_probe(") ||
		strings.Contains(source, "__atomis_log") {
		return Output{Generated: source, HasGenerated: true}
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "input.go", source, parser.SkipObjectResolution)
	if err != nil {
		var diagnostics []ParseDiagnostic
		if list, ok := err.(scanner.ErrorList); ok {
			for _, item := range list {
				diagnostics = append(diagnostics, ParseDiagnostic{
					Message: item.Msg,
					Line:    item.Pos.Line,
					Column:  item.Pos.Column,
				})
			}
		} else {
			diagnostics = append(diagnostics, ParseDiagnostic{
				Message: err.Error(), Line: 1, Column: 1,
			})
		}
		return Output{ParseDiagnostics: diagnostics}
	}
	manual := make(map[string]bool, len(manualIDs))
	for _, id := range manualIDs {
		manual[id] = true
	}
	c := &collector{
		fset:        fset,
		uri:         uri,
		fileID:      fileID,
		autoInspect: autoInspect,
		manualIDs:   manual,
		initStmts:   map[ast.Stmt]bool{},
	}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		c.walk(fn.Body)
	}
	sort.Slice(c.insertions, func(a, b int) bool {
		return c.insertions[a].offset > c.insertions[b].offset
	})
	generated := source
	for _, item := range c.insertions {
		if item.offset <= len(generated) {
			generated = generated[:item.offset] + item.text + generated[item.offset:]
		}
	}
	if strings.Count(source, "\n") != strings.Count(generated, "\n") {
		return Output{
			ParseDiagnostics: []ParseDiagnostic{{
				Message: "instrumentation would change the line count",
				Line:    1,
				Column:  1,
			}},
		}
	}
	return Output{Generated: generated, HasGenerated: true, Probes: c.probes}
}
