package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

const maxSourceBytes = 1024 * 1024

type manualFlags []string

func (m *manualFlags) String() string { return strings.Join(*m, ",") }
func (m *manualFlags) Set(value string) error {
	*m = append(*m, value)
	return nil
}

func jsonString(builder *strings.Builder, value string) {
	builder.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			builder.WriteString("\\\"")
		case '\\':
			builder.WriteString("\\\\")
		case '\n':
			builder.WriteString("\\n")
		case '\r':
			builder.WriteString("\\r")
		case '\t':
			builder.WriteString("\\t")
		default:
			if r < 0x20 {
				fmt.Fprintf(builder, "\\u%04x", r)
			} else {
				builder.WriteRune(r)
			}
		}
	}
	builder.WriteByte('"')
}

func render(result Output, output string, sourceMap string, version uint64) string {
	var out strings.Builder
	fmt.Fprintf(&out, `{"protocolVersion":1,"documentVersion":%d`, version)
	if result.HasGenerated {
		out.WriteString(`,"generatedPath":`)
		jsonString(&out, output)
		out.WriteString(`,"sourceMapPath":`)
		jsonString(&out, sourceMap)
	}
	out.WriteString(`,"probes":[`)
	for index, probe := range result.Probes {
		if index != 0 {
			out.WriteByte(',')
		}
		out.WriteString(`{"probeId":`)
		jsonString(&out, probe.ProbeID)
		out.WriteString(`,"name":`)
		jsonString(&out, probe.Name)
		fmt.Fprintf(&out, `,"supported":%t`, probe.Supported)
		if probe.Reason != "" {
			out.WriteString(`,"reason":`)
			jsonString(&out, probe.Reason)
		}
		fmt.Fprintf(&out,
			`,"originalRange":{"startLine":%d,"startColumn":%d,"endLine":%d,"endColumn":%d,"startByte":%d,"endByte":%d}`,
			probe.Range.StartLine, probe.Range.StartColumn,
			probe.Range.EndLine, probe.Range.EndColumn,
			probe.Range.StartByte, probe.Range.EndByte,
		)
		if probe.InsertionByte >= 0 {
			fmt.Fprintf(&out, `,"insertionByte":%d`, probe.InsertionByte)
		}
		fmt.Fprintf(&out, `,"mode":"%s"}`, probe.Mode)
	}
	out.WriteString(`],"parseDiagnostics":[`)
	for index, diagnostic := range result.ParseDiagnostics {
		if index != 0 {
			out.WriteByte(',')
		}
		out.WriteString(`{"message":`)
		jsonString(&out, diagnostic.Message)
		fmt.Fprintf(&out, `,"severity":"error","line":%d,"column":%d}`,
			diagnostic.Line, diagnostic.Column)
	}
	out.WriteString(`]}`)
	return out.String()
}

func main() {
	input := flag.String("input", "", "input file")
	output := flag.String("output", "", "output file")
	sourceMap := flag.String("source-map", "", "source map file")
	uri := flag.String("uri", "file:///main.go", "document uri")
	version := flag.Uint64("version", 1, "document version")
	fileID := flag.Int("file-id", 0, "file id")
	noAutoInspect := flag.Bool("no-auto-inspect", false, "disable auto probes")
	entry := flag.Bool("entry", false, "entry file (accepted for CLI parity)")
	var manual manualFlags
	flag.Var(&manual, "manual", "manual probe id (repeatable)")
	flag.Parse()
	_ = entry
	if *input == "" || *output == "" || *sourceMap == "" {
		fmt.Fprintln(os.Stderr, "golive-instrument: missing --input/--output/--source-map")
		os.Exit(1)
	}
	info, err := os.Stat(*input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "golive-instrument: %v\n", err)
		os.Exit(1)
	}
	if info.Size() > maxSourceBytes {
		fmt.Fprintf(os.Stderr, "golive-instrument: %s exceeds 1 MiB\n", *input)
		os.Exit(1)
	}
	source, err := os.ReadFile(*input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "golive-instrument: %v\n", err)
		os.Exit(1)
	}
	result := Instrument(string(source), *uri, !*noAutoInspect, manual, *fileID)
	json := render(result, *output, *sourceMap, *version)
	if result.HasGenerated {
		if err := os.WriteFile(*output, []byte(result.Generated), 0o600); err != nil {
			fmt.Fprintf(os.Stderr, "golive-instrument: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(*sourceMap, []byte(json), 0o600); err != nil {
			fmt.Fprintf(os.Stderr, "golive-instrument: %v\n", err)
			os.Exit(1)
		}
	}
	fmt.Println(json)
}
