package main

import (
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

const sample = `package main

import "fmt"

func main() {
	price := 40
	var tax int = 3
	total := applyTax(price, tax)
	a, b := 1, 2
	for i := 0; i < 3; i++ {
		fmt.Println("iter", i)
	}
	for _, v := range []int{1, 2} {
		fmt.Println("v", v)
	}
	log := total
	_ = log
	_ = a
	_ = b
}

func applyTax(price int, tax int) int {
	return price + tax
}
`

func TestProbesSimpleDeclarations(t *testing.T) {
	result := Instrument(sample, "file:///main.go", true, nil, 1)
	if !result.HasGenerated {
		t.Fatalf("expected generated output: %+v", result.ParseDiagnostics)
	}
	if strings.Count(sample, "\n") != strings.Count(result.Generated, "\n") {
		t.Fatal("line count changed")
	}
	if !strings.Contains(result.Generated, `price := 40; __atomis_probe(`) {
		t.Fatalf("price probe missing:\n%s", result.Generated)
	}
	if !strings.Contains(result.Generated, `"price", price)`) {
		t.Fatal("probe arguments missing")
	}
	if !strings.Contains(result.Generated, `var tax int = 3; __atomis_probe(`) {
		t.Fatal("var probe missing")
	}
	supported := 0
	unsupported := 0
	for _, probe := range result.Probes {
		if probe.Supported {
			supported++
		} else {
			unsupported++
		}
	}
	// price, tax, total, log (a,b multi-assign is unsupported; loop i is an
	// init statement and must be skipped entirely)
	if supported != 4 {
		t.Fatalf("expected 4 supported probes, got %d", supported)
	}
	if unsupported != 1 {
		t.Fatalf("expected 1 unsupported probe, got %d", unsupported)
	}
	if strings.Contains(result.Generated, "i := 0; __atomis_probe") {
		t.Fatal("for-init must not be probed")
	}
}

func TestLogMarkersTrackLoops(t *testing.T) {
	result := Instrument(sample, "file:///main.go", true, nil, 7)
	if !strings.Contains(result.Generated, `__atomis_log_loop(1, 7, 11, 3, 10, 2, "i", i)`) {
		t.Fatalf("for-loop marker missing:\n%s", result.Generated)
	}
	if !strings.Contains(result.Generated, `"v", v)`) {
		t.Fatal("range value marker missing")
	}
}

func TestManualModeInsertsOnlySelected(t *testing.T) {
	all := Instrument(sample, "file:///main.go", true, nil, 1)
	var priceID string
	for _, probe := range all.Probes {
		if probe.Name == "price" {
			priceID = probe.ProbeID
		}
	}
	none := Instrument(sample, "file:///main.go", false, nil, 1)
	if strings.Contains(none.Generated, "__atomis_probe") {
		t.Fatal("no probes expected with auto-inspect off")
	}
	selected := Instrument(sample, "file:///main.go", false, []string{priceID}, 1)
	if !strings.Contains(selected.Generated, `"price", price)`) {
		t.Fatal("manual probe missing")
	}
}

func TestParseErrorsCarryPositions(t *testing.T) {
	result := Instrument("package main\n\nfunc main() {\n\tx :=\n}\n", "file:///main.go", true, nil, 1)
	if result.HasGenerated {
		t.Fatal("expected parse failure")
	}
	if len(result.ParseDiagnostics) == 0 || result.ParseDiagnostics[0].Line < 4 {
		t.Fatalf("expected diagnostics at line 4+: %+v", result.ParseDiagnostics)
	}
}

func TestInstrumentedSourcePassesThrough(t *testing.T) {
	source := "package main\n\nfunc main() { x := 1; __atomis_probe(\"a\", 1, 1, \"x\", x) }\n"
	result := Instrument(source, "file:///main.go", true, nil, 1)
	if result.Generated != source || len(result.Probes) != 0 {
		t.Fatal("expected passthrough")
	}
}

func TestTypeSwitchAndSelectHeadersStayUntouched(t *testing.T) {
	source := `package main

import "fmt"

func describe(x any) {
	switch v := x.(type) {
	case int:
		fmt.Println(v)
	}
}

func pick(ch chan int) {
	select {
	case v := <-ch:
		fmt.Println(v)
	default:
	}
}
`
	result := Instrument(source, "file:///main.go", true, nil, 1)
	if !result.HasGenerated {
		t.Fatalf("expected generated output: %+v", result.ParseDiagnostics)
	}
	if strings.Contains(result.Generated, "x.(type); __atomis_probe") {
		t.Fatalf("probe spliced into the type switch guard:\n%s", result.Generated)
	}
	if strings.Contains(result.Generated, "<-ch; __atomis_probe") {
		t.Fatalf("probe spliced into the select comm clause:\n%s", result.Generated)
	}
	mustParse(t, result.Generated)
}

// The assertion every instrumenter needs most: whatever was spliced in,
// the output is still a Go program.
func mustParse(t *testing.T, generated string) {
	t.Helper()
	fset := token.NewFileSet()
	if _, err := parser.ParseFile(fset, "generated.go", generated, 0); err != nil {
		t.Fatalf("generated output does not parse: %v\n%s", err, generated)
	}
}

func TestEveryGeneratedSampleParses(t *testing.T) {
	for _, source := range []string{sample} {
		result := Instrument(source, "file:///main.go", true, nil, 1)
		if !result.HasGenerated {
			t.Fatalf("expected generated output: %+v", result.ParseDiagnostics)
		}
		mustParse(t, result.Generated)
	}
}
