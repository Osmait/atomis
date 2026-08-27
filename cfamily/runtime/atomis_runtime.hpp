// Atomis session runtime for C++. Injected with `-include` when compiling
// the generated mirror. The template probe streams any value with an
// `operator<<` (detected via a C++20 requires-expression) and reports the
// readable type name extracted from __PRETTY_FUNCTION__.
#pragma once

#include <cstdio>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <unistd.h>

namespace __atomis {

constexpr std::size_t max_preview = 512;

struct Unbuffer {
	Unbuffer() {
		std::setvbuf(stdout, nullptr, _IONBF, 0);
		std::setvbuf(stderr, nullptr, _IONBF, 0);
	}
};
inline Unbuffer unbuffer_streams{};

template <class T> constexpr std::string_view type_name() {
	std::string_view pretty = __PRETTY_FUNCTION__;
	const auto start = pretty.find("T = ") + 4;
	return pretty.substr(start, pretty.find_first_of(";]", start) - start);
}

inline void json_escape(std::string &out, std::string_view in) {
	for (const char raw : in) {
		const auto ch = static_cast<unsigned char>(raw);
		switch (ch) {
		case '"': out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		default:
			if (ch < 0x20) {
				char buffer[8];
				std::snprintf(buffer, sizeof buffer, "\\u%04x", ch);
				out += buffer;
			} else out += static_cast<char>(ch);
		}
	}
}

inline void emit(const char *id, int line, int col, const char *name,
                 std::string_view type, std::string_view preview,
                 bool truncated, int size, int align, int bits) {
	static int sequence = 0;
	std::string record = "{\"protocolVersion\":1,\"kind\":\"probe_value\","
	                     "\"probeId\":\"";
	record += id;
	record += "\",\"name\":\"";
	record += name;
	record += "\",\"line\":" + std::to_string(line);
	record += ",\"column\":" + std::to_string(col);
	record += ",\"typeName\":\"";
	json_escape(record, type);
	record += "\",\"preview\":\"";
	json_escape(record, preview);
	if (size > 0) {
		record += "\",\"sizeBytes\":" + std::to_string(size);
		record += ",\"alignBytes\":" + std::to_string(align);
		if (bits > 0) record += ",\"bits\":" + std::to_string(bits);
		record += ",\"truncated\":";
	} else record += "\",\"truncated\":";
	record += truncated ? "true" : "false";
	record += ",\"sequence\":" + std::to_string(sequence++) + "}\n";
	const auto written = write(3, record.data(), record.size());
	(void)written;
}

template <class T> std::string preview_of(const T &value, bool &truncated) {
	std::ostringstream out;
	// Chars stream as digits (+value promotes) so the editor can re-format
	// them as hex/bin; bool keeps its 1/0 rendering via the generic branch.
	if constexpr (std::is_integral_v<T> && !std::is_same_v<T, bool>)
		out << +value;
	else if constexpr (requires(std::ostream &os) { os << value; }) out << value;
	else out << "<sin operator<<>";
	std::string text = out.str();
	if (text.size() > max_preview) {
		text.resize(max_preview);
		text += "…";
		truncated = true;
	}
	return text;
}

} // namespace __atomis

template <class T>
void __atomis_probe(const char *id, int line, int col, const char *name,
                     const T &value) {
	bool truncated = false;
	const std::string preview = __atomis::preview_of(value, truncated);
	constexpr int bits =
	    (std::is_integral_v<T> || std::is_enum_v<T>) ? int(sizeof(T)) * 8 : 0;
	__atomis::emit(id, line, col, name, __atomis::type_name<T>(), preview,
	                truncated, int(sizeof(T)), int(alignof(T)), bits);
}

inline void __atomis_log(int fd, int file_id, int line, int col) {
	std::fprintf(fd == 1 ? stdout : stderr, "\x1e" "ATOMIS_LOG:%d:%d:%d\x1f",
	             file_id, line, col);
}

template <class T>
void __atomis_log_loop(int fd, int file_id, int line, int col, int loop_line,
                        int loop_col, const char *variable, const T &value) {
	bool truncated = false;
	const std::string preview = __atomis::preview_of(value, truncated);
	std::fprintf(fd == 1 ? stdout : stderr,
	             "\x1e" "ATOMIS_LOG:%d:%d:%d:%d:%d:%s:%s\x1f", file_id, line,
	             col, loop_line, loop_col, variable, preview.c_str());
}
