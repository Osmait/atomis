/* ZigLive session runtime for C. Injected with `-include` when compiling the
 * generated mirror, so user sources never change. Probe values flow as
 * NDJSON on fd 3; log markers ride the same stdio streams printf uses. The
 * `_Generic` dispatch selects a function designator, so unselected branches
 * never type-check their arguments and struct values fall back safely. */
#ifndef ZIGLIVE_RUNTIME_H
#define ZIGLIVE_RUNTIME_H

#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define __ZIGLIVE_MAX_PREVIEW 512

static void __ziglive_unbuffer(void) __attribute__((constructor));
static void __ziglive_unbuffer(void) {
	setvbuf(stdout, NULL, _IONBF, 0);
	setvbuf(stderr, NULL, _IONBF, 0);
}

static void __ziglive_json_escape(char *out, size_t cap, const char *in) {
	size_t used = 0;
	for (const unsigned char *p = (const unsigned char *)in; *p; p++) {
		if (used + 8 >= cap) break;
		switch (*p) {
		case '"': out[used++] = '\\'; out[used++] = '"'; break;
		case '\\': out[used++] = '\\'; out[used++] = '\\'; break;
		case '\n': out[used++] = '\\'; out[used++] = 'n'; break;
		case '\r': out[used++] = '\\'; out[used++] = 'r'; break;
		case '\t': out[used++] = '\\'; out[used++] = 't'; break;
		default:
			if (*p < 0x20)
				used += (size_t)snprintf(out + used, cap - used, "\\u%04x", *p);
			else out[used++] = (char)*p;
		}
	}
	out[used] = '\0';
}

/* size/align describe the declared type at the probe site (the macro passes
 * sizeof/_Alignof before _Generic widens the value); bits > 0 marks integer
 * probes so the editor can re-format them in hex/bin/oct. */
static void __ziglive_emit(const char *id, int line, int col, const char *name,
                           const char *type, const char *preview,
                           int size, int align, int bits) {
	static int sequence;
	char escaped[__ZIGLIVE_MAX_PREVIEW * 2];
	char record[__ZIGLIVE_MAX_PREVIEW * 2 + 256];
	char layout[96];
	__ziglive_json_escape(escaped, sizeof escaped, preview);
	layout[0] = '\0';
	if (size > 0) {
		int used = snprintf(layout, sizeof layout,
			",\"sizeBytes\":%d,\"alignBytes\":%d", size, align);
		if (bits > 0 && used > 0)
			snprintf(layout + used, sizeof layout - (size_t)used,
				",\"bits\":%d", bits);
	}
	int n = snprintf(record, sizeof record,
		"{\"protocolVersion\":1,\"kind\":\"probe_value\",\"probeId\":\"%s\","
		"\"name\":\"%s\",\"line\":%d,\"column\":%d,\"typeName\":\"%s\","
		"\"preview\":\"%s\"%s,\"truncated\":false,\"sequence\":%d}\n",
		id, name, line, col, type, escaped, layout, sequence++);
	if (n > 0) {
		ssize_t written = write(3, record, (size_t)n);
		(void)written;
	}
}

static void __ziglive_probe_long(const char *id, int line, int col,
                                 const char *name, const char *type,
                                 int size, int align, long value) {
	char preview[32];
	snprintf(preview, sizeof preview, "%ld", value);
	__ziglive_emit(id, line, col, name, type, preview, size, align, size * 8);
}

static void __ziglive_probe_ulong(const char *id, int line, int col,
                                  const char *name, const char *type,
                                  int size, int align, unsigned long value) {
	char preview[32];
	snprintf(preview, sizeof preview, "%lu", value);
	__ziglive_emit(id, line, col, name, type, preview, size, align, size * 8);
}

static void __ziglive_probe_double(const char *id, int line, int col,
                                   const char *name, const char *type,
                                   int size, int align, double value) {
	char preview[48];
	snprintf(preview, sizeof preview, "%g", value);
	__ziglive_emit(id, line, col, name, type, preview, size, align, 0);
}

static void __ziglive_probe_str(const char *id, int line, int col,
                                const char *name, const char *type,
                                int size, int align, const char *value) {
	char preview[__ZIGLIVE_MAX_PREVIEW];
	if (value == NULL) {
		__ziglive_emit(id, line, col, name, type, "NULL", size, align, 0);
		return;
	}
	snprintf(preview, sizeof preview, "\"%.500s\"", value);
	__ziglive_emit(id, line, col, name, type, preview, size, align, 0);
}

static void __ziglive_probe_ptr(const char *id, int line, int col,
                                const char *name, const char *type,
                                int size, int align, const void *value) {
	char preview[32];
	snprintf(preview, sizeof preview, "%p", value);
	__ziglive_emit(id, line, col, name, type, preview, size, align, 0);
}

static void __ziglive_probe_any(const char *id, int line, int col,
                                const char *name, const char *type,
                                int size, int align, ...) {
	__ziglive_emit(id, line, col, name, "?", "<sin preview>", size, align, 0);
	(void)type;
}

#define __ziglive_typename(v) _Generic((v), \
	_Bool: "bool", \
	char: "char", signed char: "signed char", \
	short: "short", int: "int", \
	long: "long", long long: "long long", \
	unsigned char: "unsigned char", unsigned short: "unsigned short", \
	unsigned int: "unsigned int", unsigned long: "unsigned long", \
	unsigned long long: "unsigned long long", \
	float: "float", double: "double", \
	char *: "char*", const char *: "char*", \
	void *: "void*", \
	default: "?")

#define __ziglive_probe(id, line, col, name, v) _Generic((v), \
	_Bool: __ziglive_probe_long, \
	char: __ziglive_probe_long, signed char: __ziglive_probe_long, \
	short: __ziglive_probe_long, int: __ziglive_probe_long, \
	long: __ziglive_probe_long, long long: __ziglive_probe_long, \
	unsigned char: __ziglive_probe_ulong, unsigned short: __ziglive_probe_ulong, \
	unsigned int: __ziglive_probe_ulong, unsigned long: __ziglive_probe_ulong, \
	unsigned long long: __ziglive_probe_ulong, \
	float: __ziglive_probe_double, double: __ziglive_probe_double, \
	char *: __ziglive_probe_str, const char *: __ziglive_probe_str, \
	void *: __ziglive_probe_ptr, \
	default: __ziglive_probe_any)(id, line, col, name, \
		__ziglive_typename(v), (int)sizeof(v), \
		(int)_Alignof(__typeof__(v)), (v))

static void __ziglive_log(int fd, int file_id, int line, int col) {
	fprintf(fd == 1 ? stdout : stderr, "\x1eZIGLIVE_LOG:%d:%d:%d\x1f",
	        file_id, line, col);
}

static void __ziglive_log_loop_long(int fd, int file_id, int line, int col,
                                    int loop_line, int loop_col,
                                    const char *variable, long value) {
	fprintf(fd == 1 ? stdout : stderr,
	        "\x1eZIGLIVE_LOG:%d:%d:%d:%d:%d:%s:%ld\x1f",
	        file_id, line, col, loop_line, loop_col, variable, value);
}

static void __ziglive_log_loop_any(int fd, int file_id, int line, int col,
                                   int loop_line, int loop_col,
                                   const char *variable, ...) {
	fprintf(fd == 1 ? stdout : stderr,
	        "\x1eZIGLIVE_LOG:%d:%d:%d:%d:%d:%s:?\x1f",
	        file_id, line, col, loop_line, loop_col, variable);
}

#define __ziglive_log_loop(fd, file_id, line, col, lline, lcol, var, v) \
	_Generic((v), \
		_Bool: __ziglive_log_loop_long, char: __ziglive_log_loop_long, \
		short: __ziglive_log_loop_long, int: __ziglive_log_loop_long, \
		long: __ziglive_log_loop_long, long long: __ziglive_log_loop_long, \
		unsigned char: __ziglive_log_loop_long, \
		unsigned short: __ziglive_log_loop_long, \
		unsigned int: __ziglive_log_loop_long, \
		unsigned long: __ziglive_log_loop_long, \
		default: __ziglive_log_loop_any)(fd, file_id, line, col, lline, lcol, var, (v))

#endif /* ZIGLIVE_RUNTIME_H */
