// ZigLive session runtime for Go: probe values as NDJSON on fd 3 and stderr/
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

const __zigliveMaxPreview = 512

var (
	__zigliveSequence atomic.Uint64
	__zigliveLock     sync.Mutex
	__zigliveFd1      = os.Stdout
	__zigliveFd2      = os.Stderr
	__zigliveFd3      = os.NewFile(3, "ziglive-probes")
)

func __zigliveEscape(builder *strings.Builder, value string) {
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

func __zigliveTruncate(preview string) (string, bool) {
	if len(preview) <= __zigliveMaxPreview {
		return preview, false
	}
	end := __zigliveMaxPreview
	for end > 0 && !__zigliveIsBoundary(preview, end) {
		end--
	}
	return preview[:end] + "…", true
}

func __zigliveIsBoundary(value string, index int) bool {
	if index <= 0 || index >= len(value) {
		return true
	}
	return value[index]&0xC0 != 0x80
}

// __zigliveLayout reports size/align (all sized types) plus bit width for
// integer kinds, so the editor's peek panel can show real memory layout.
func __zigliveLayout(value any) string {
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

func __ziglive_probe(probeID string, line int, column int, name string, value any) {
	sequence := __zigliveSequence.Add(1) - 1
	preview, truncated := __zigliveTruncate(fmt.Sprintf("%#v", value))
	typeName := fmt.Sprintf("%T", value)
	var record strings.Builder
	record.WriteString(`{"protocolVersion":1,"kind":"probe_value","probeId":"`)
	__zigliveEscape(&record, probeID)
	record.WriteString(`","name":"`)
	__zigliveEscape(&record, name)
	fmt.Fprintf(&record, `","line":%d,"column":%d,"typeName":"`, line, column)
	__zigliveEscape(&record, typeName)
	record.WriteString(`","preview":"`)
	__zigliveEscape(&record, preview)
	record.WriteString(`"`)
	record.WriteString(__zigliveLayout(value))
	fmt.Fprintf(&record, `,"truncated":%t,"sequence":%d}`, truncated, sequence)
	record.WriteString("\n")
	__zigliveLock.Lock()
	defer __zigliveLock.Unlock()
	if __zigliveFd3 != nil {
		_, _ = __zigliveFd3.WriteString(record.String())
	}
}

func __zigliveMarkerTarget(fd int) *os.File {
	if fd == 1 {
		return __zigliveFd1
	}
	return __zigliveFd2
}

func __ziglive_log(fd int, fileID int, line int, column int) {
	marker := fmt.Sprintf("\x1eZIGLIVE_LOG:%d:%d:%d\x1f", fileID, line, column)
	__zigliveLock.Lock()
	defer __zigliveLock.Unlock()
	_, _ = __zigliveMarkerTarget(fd).WriteString(marker)
}

func __ziglive_log_loop(fd int, fileID int, line int, column int, loopLine int, loopColumn int, variable string, value any) {
	preview, _ := __zigliveTruncate(fmt.Sprintf("%#v", value))
	marker := fmt.Sprintf(
		"\x1eZIGLIVE_LOG:%d:%d:%d:%d:%d:%s:%s\x1f",
		fileID, line, column, loopLine, loopColumn, variable, preview,
	)
	__zigliveLock.Lock()
	defer __zigliveLock.Unlock()
	_, _ = __zigliveMarkerTarget(fd).WriteString(marker)
}
