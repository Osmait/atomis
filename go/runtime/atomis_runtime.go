// Atomis session runtime for Go: probe values as NDJSON on fd 3 and stderr/
// stdout source markers for instrumented log statements, mirroring the Zig
// and Rust runtimes. Lives in the generated mirror as part of package main.
package main

import (
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
)

const __atomisMaxPreview = 512

var (
	__atomisSequence atomic.Uint64
	__atomisLock     sync.Mutex
	__atomisFd1      = os.Stdout
	__atomisFd2      = os.Stderr
	__atomisFd3      = os.NewFile(3, "atomis-probes")
)

func __atomisEscape(builder *strings.Builder, value string) {
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
}

// __atomisPreview formats a value WITHOUT materializing all of it first: a
// hundred-million element slice rendered with %#v is gigabytes of string
// built inside the user's own program just to keep 512 bytes of it.
func __atomisPreview(value any) string {
	v := reflect.ValueOf(value)
	if !v.IsValid() {
		return fmt.Sprintf("%#v", value)
	}
	switch v.Kind() {
	case reflect.String:
		s := v.String()
		if len(s) > __atomisMaxPreview*2 {
			end := __atomisMaxPreview * 2
			for end > 0 && !__atomisIsBoundary(s, end) {
				end--
			}
			return fmt.Sprintf("%q…", s[:end])
		}
	case reflect.Slice:
		if v.Len() > 64 {
			return fmt.Sprintf("%#v… (len %d)", v.Slice(0, 64).Interface(), v.Len())
		}
	case reflect.Array, reflect.Map:
		if v.Len() > 64 {
			return fmt.Sprintf("%T (len %d)", value, v.Len())
		}
	}
	return fmt.Sprintf("%#v", value)
}

func __atomisTruncate(preview string) (string, bool) {
	if len(preview) <= __atomisMaxPreview {
		return preview, false
	}
	end := __atomisMaxPreview
	for end > 0 && !__atomisIsBoundary(preview, end) {
		end--
	}
	return preview[:end] + "…", true
}

func __atomisIsBoundary(value string, index int) bool {
	if index <= 0 || index >= len(value) {
		return true
	}
	return value[index]&0xC0 != 0x80
}

// __atomisLayout reports size/align (all sized types) plus bit width for
// integer kinds, so the editor's peek panel can show real memory layout.
func __atomisLayout(value any) string {
	if value == nil {
		return ""
	}
	kind := reflect.TypeOf(value)
	layout := fmt.Sprintf(`,"sizeBytes":%d,"alignBytes":%d`, kind.Size(), kind.Align())
	switch kind.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Uintptr:
		layout += fmt.Sprintf(`,"bits":%d`, kind.Size()*8)
	case reflect.Bool:
		layout += `,"bits":1`
	}
	return layout
}

func __atomis_probe(probeID string, line int, column int, name string, value any) {
	sequence := __atomisSequence.Add(1) - 1
	preview, truncated := __atomisTruncate(__atomisPreview(value))
	typeName := fmt.Sprintf("%T", value)
	var record strings.Builder
	record.WriteString(`{"protocolVersion":1,"kind":"probe_value","probeId":"`)
	__atomisEscape(&record, probeID)
	record.WriteString(`","name":"`)
	__atomisEscape(&record, name)
	fmt.Fprintf(&record, `","line":%d,"column":%d,"typeName":"`, line, column)
	__atomisEscape(&record, typeName)
	record.WriteString(`","preview":"`)
	__atomisEscape(&record, preview)
	record.WriteString(`"`)
	record.WriteString(__atomisLayout(value))
	fmt.Fprintf(&record, `,"truncated":%t,"sequence":%d}`, truncated, sequence)
	record.WriteString("\n")
	__atomisLock.Lock()
	defer __atomisLock.Unlock()
	if __atomisFd3 != nil {
		_, _ = __atomisFd3.WriteString(record.String())
	}
}

func __atomisMarkerTarget(fd int) *os.File {
	if fd == 1 {
		return __atomisFd1
	}
	return __atomisFd2
}

func __atomis_log(fd int, fileID int, line int, column int) {
	marker := fmt.Sprintf("\x1eATOMIS_LOG:%d:%d:%d\x1f", fileID, line, column)
	__atomisLock.Lock()
	defer __atomisLock.Unlock()
	_, _ = __atomisMarkerTarget(fd).WriteString(marker)
}

func __atomis_log_loop(fd int, fileID int, line int, column int, loopLine int, loopColumn int, variable string, value any) {
	preview, _ := __atomisTruncate(__atomisPreview(value))
	// The marker travels in-band: its own delimiters (or a newline) inside
	// the preview would cut the frame short.
	preview = strings.NewReplacer("\x1e", "?", "\x1f", "?", "\n", "\\n").Replace(preview)
	marker := fmt.Sprintf(
		"\x1eATOMIS_LOG:%d:%d:%d:%d:%d:%s:%s\x1f",
		fileID, line, column, loopLine, loopColumn, variable, preview,
	)
	__atomisLock.Lock()
	defer __atomisLock.Unlock()
	_, _ = __atomisMarkerTarget(fd).WriteString(marker)
}
