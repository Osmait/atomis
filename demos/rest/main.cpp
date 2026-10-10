// A REST API for a todo list, on POSIX sockets and the standard library
// alone, so the HTTP parsing and the JSON a framework hides are here.
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.
#include <netdb.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>

struct Todo {
    long id;
    std::string title;
    bool done = false;
};

// ---- JSON out --------------------------------------------------------------

// A JSON string: quoted, with " and \ escaped, and control characters as \u00XX.
std::string quote(std::string_view text) {
    static constexpr std::string_view HEX = "0123456789abcdef";
    std::string out = "\"";
    for (char c : text) {
        auto byte = static_cast<unsigned char>(c);
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (byte < 0x20) {
            out += "\\u00";
            out += HEX[byte >> 4];
            out += HEX[byte & 0xF];
        } else {
            out += c;
        }
    }
    return out + '"';
}

std::string to_json(const Todo &todo) {
    return "{\"id\":" + std::to_string(todo.id) + ",\"title\":" + quote(todo.title) +
           ",\"done\":" + (todo.done ? "true" : "false") + "}";
}

// ---- JSON in: just enough to read {"title": "…"} and {"done": true} -------

// What a request body says, of what this API reads: each field is set only
// when the body has it with the right type.
struct Fields {
    std::optional<std::string> title;
    std::optional<bool> done;
};

// A cursor over a body that must be one JSON object. Every read_* consumes
// what it read, and returns std::nullopt (or false) when it is not valid JSON.
class JsonReader {
  public:
    explicit JsonReader(std::string_view text) : rest_(text) {}

    // Keeps "title" when it is a string and "done" when it is a boolean, and
    // skips every other member.
    std::optional<Fields> read_fields() {
        Fields fields;
        if (!eat('{')) return std::nullopt;
        if (!eat('}')) {
            do {
                auto key = read_string();
                if (!key || !eat(':')) return std::nullopt;
                if (*key == "title" && peek() == '"') {
                    if (!(fields.title = read_string())) return std::nullopt;
                } else if (*key == "done" && (peek() == 't' || peek() == 'f')) {
                    if (!(fields.done = read_bool())) return std::nullopt;
                } else if (!skip_value()) {
                    return std::nullopt;
                }
            } while (eat(','));
            if (!eat('}')) return std::nullopt;
        }
        skip_space();
        if (!rest_.empty()) return std::nullopt; // nothing may follow the object
        return fields;
    }

  private:
    std::string_view rest_;

    void skip_space() {
        auto space = std::min(rest_.find_first_not_of(" \t\r\n"), rest_.size());
        rest_.remove_prefix(space);
    }

    char peek() {
        skip_space();
        return rest_.empty() ? '\0' : rest_.front();
    }

    bool eat(std::string_view token) {
        skip_space();
        if (!rest_.starts_with(token)) return false;
        rest_.remove_prefix(token.size());
        return true;
    }

    bool eat(char c) { return eat(std::string_view(&c, 1)); }

    std::optional<bool> read_bool() {
        if (eat("true")) return true;
        if (eat("false")) return false;
        return std::nullopt;
    }

    // Four hex digits, after a \u.
    std::optional<unsigned> read_hex4() {
        unsigned value = 0;
        if (rest_.size() < 4) return std::nullopt;
        auto [end, error] = std::from_chars(rest_.data(), rest_.data() + 4, value, 16);
        if (error != std::errc{} || end != rest_.data() + 4) return std::nullopt;
        rest_.remove_prefix(4);
        return value;
    }

    // The code point a \uXXXX escape names: two escapes for a surrogate pair.
    std::optional<char32_t> read_escaped_code_point() {
        auto unit = read_hex4();
        if (!unit || (*unit >= 0xDC00 && *unit <= 0xDFFF)) return std::nullopt;
        if (*unit < 0xD800 || *unit > 0xDBFF) return *unit;
        if (!rest_.starts_with("\\u")) return std::nullopt;
        rest_.remove_prefix(2);
        auto low = read_hex4();
        if (!low || *low < 0xDC00 || *low > 0xDFFF) return std::nullopt;
        return 0x10000 + ((*unit - 0xD800) << 10) + (*low - 0xDC00);
    }

    static void append_utf8(std::string &out, char32_t code) {
        auto byte = [&out](char32_t bits) { out += static_cast<char>(bits); };
        if (code < 0x80) {
            byte(code);
        } else if (code < 0x800) {
            byte(0xC0 | code >> 6);
            byte(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
            byte(0xE0 | code >> 12);
            byte(0x80 | (code >> 6 & 0x3F));
            byte(0x80 | (code & 0x3F));
        } else {
            byte(0xF0 | code >> 18);
            byte(0x80 | (code >> 12 & 0x3F));
            byte(0x80 | (code >> 6 & 0x3F));
            byte(0x80 | (code & 0x3F));
        }
    }

    std::optional<std::string> read_string() {
        if (!eat('"')) return std::nullopt;
        std::string out;
        while (!rest_.empty() && rest_.front() != '"') {
            char c = rest_.front();
            rest_.remove_prefix(1);
            if (static_cast<unsigned char>(c) < 0x20) return std::nullopt; // a raw control character
            if (c != '\\') {
                out += c;
                continue;
            }
            if (rest_.empty()) return std::nullopt;
            char escape = rest_.front();
            rest_.remove_prefix(1);
            switch (escape) {
            case '"': case '\\': case '/': out += escape; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'u': {
                auto code = read_escaped_code_point();
                if (!code) return std::nullopt;
                append_utf8(out, *code);
                break;
            }
            default: return std::nullopt;
            }
        }
        if (rest_.empty()) return std::nullopt; // the body ended inside the string
        rest_.remove_prefix(1);
        return out;
    }

    // Any value, skipped: strings, objects and arrays (nested), true, false,
    // null and numbers (checked loosely: a run of the characters numbers use).
    bool skip_value() {
        char first = peek();
        if (first == '"') return read_string().has_value();
        if (first == '{' || first == '[') {
            char close = first == '{' ? '}' : ']';
            rest_.remove_prefix(1);
            if (eat(close)) return true;
            do {
                if (close == '}' && !(read_string() && eat(':'))) return false; // a member starts with "key":
                if (!skip_value()) return false;
            } while (eat(','));
            return eat(close);
        }
        if (eat("true") || eat("false") || eat("null")) return true;
        auto number = std::min(rest_.find_first_not_of("0123456789+-.eE"), rest_.size());
        rest_.remove_prefix(number);
        return number > 0;
    }
};

// ---- HTTP: one request in, one response out --------------------------------

// Owns a socket and closes it when it goes out of scope.
class Socket {
  public:
    explicit Socket(int fd) : fd_(fd) {}
    Socket(const Socket &) = delete;
    Socket &operator=(const Socket &) = delete;
    ~Socket() {
        if (fd_ >= 0) ::close(fd_);
    }

    int fd() const { return fd_; }

    // Appends what the peer has sent so far; false once it closed, failed or timed out.
    bool receive(std::string &into) {
        char chunk[4096];
        auto n = ::recv(fd_, chunk, sizeof chunk, 0);
        if (n <= 0) return false;
        into.append(chunk, static_cast<std::size_t>(n));
        return true;
    }

    void send_all(std::string_view data) {
        while (!data.empty()) {
            auto sent = ::send(fd_, data.data(), data.size(), 0);
            if (sent <= 0) return;
            data.remove_prefix(static_cast<std::size_t>(sent));
        }
    }

  private:
    int fd_;
};

struct Request {
    std::string method;
    std::string path;
    std::map<std::string, std::string> headers; // names in lower case: they ignore case
    std::string body;
};

struct Response {
    int status;
    std::string body; // JSON, or empty for 204
};

Response error(int status, std::string_view message) { return {status, "{\"error\":" + quote(message) + "}"}; }

std::string lowercase(std::string text) {
    std::ranges::transform(text, text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

// An HTTP/1.1 request is a request line, header lines, a blank line, then as
// many body bytes as the Content-Length header says:
//
//   POST /todos HTTP/1.1\r\n
//   Content-Type: application/json\r\n
//   Content-Length: 22\r\n
//   \r\n
//   {"title":"Learn HTTP"}
std::optional<Request> read_request(Socket &client) {
    constexpr std::size_t LIMIT = 1 << 20;

    // 1. Read until the blank line that ends the headers.
    std::string data;
    std::size_t blank;
    while ((blank = data.find("\r\n\r\n")) == std::string::npos)
        if (data.size() > LIMIT || !client.receive(data)) return std::nullopt;

    // 2. The request line: "PATCH /todos/1 HTTP/1.1".
    Request request;
    std::istringstream head(data.substr(0, blank));
    std::string line, version;
    std::getline(head, line);
    std::istringstream(line) >> request.method >> request.path >> version;
    if (!version.starts_with("HTTP/1.")) return std::nullopt;

    // 3. The headers, one "Name: value" per line (a chunked body is not supported).
    while (std::getline(head, line)) {
        auto colon = line.find(':');
        if (colon == std::string::npos) continue;
        auto value = line.substr(colon + 1);
        value.erase(0, value.find_first_not_of(" \t"));
        if (!value.empty() && value.back() == '\r') value.pop_back();
        request.headers[lowercase(line.substr(0, colon))] = value;
    }

    // 4. The body: exactly Content-Length bytes after the blank line.
    std::size_t length = 0;
    if (auto found = request.headers.find("content-length"); found != request.headers.end()) {
        const std::string &text = found->second;
        auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), length);
        if (error != std::errc{} || length > LIMIT) return std::nullopt;
    }
    std::size_t start = blank + 4;
    while (data.size() < start + length)
        if (!client.receive(data)) return std::nullopt;
    request.body = data.substr(start, length);
    return request;
}

// The status line and headers, then the body. 204 has no body, so no
// Content-Type or Content-Length either.
void respond(Socket &client, const Response &response) {
    static const std::map<int, std::string> REASONS = {
        {200, "OK"}, {201, "Created"}, {204, "No Content"}, {400, "Bad Request"}, {404, "Not Found"}};
    std::string out = "HTTP/1.1 " + std::to_string(response.status) + " " + REASONS.at(response.status) + "\r\n";
    if (response.status != 204)
        out += "Content-Type: application/json\r\nContent-Length: " + std::to_string(response.body.size()) + "\r\n";
    out += "Connection: close\r\n\r\n";
    out += response.body;
    client.send_all(out);
}

// ---- The API: one handler per endpoint -----------------------------------
// A handler gets the request and the id its path captured ({id}, or 0 when
// the route has none), and returns the response.

class TodoApi {
  public:
    Response health(const Request &, long) { return {200, R"({"ok":true})"}; }

    Response list_todos(const Request &, long) {
        std::string list;
        for (const auto &[id, todo] : todos_) list += (list.empty() ? "" : ",") + to_json(todo);
        return {200, "[" + list + "]"};
    }

    Response create_todo(const Request &request, long) {
        auto fields = JsonReader(request.body).read_fields();
        if (!fields || !fields->title || fields->title->empty()) return error(400, "title is required");
        Todo todo{next_id_++, *fields->title};
        todos_.emplace(todo.id, todo);
        return {201, to_json(todo)};
    }

    Response get_todo(const Request &, long id) {
        auto found = todos_.find(id);
        if (found == todos_.end()) return error(404, "not found");
        return {200, to_json(found->second)};
    }

    Response update_todo(const Request &request, long id) {
        auto found = todos_.find(id);
        if (found == todos_.end()) return error(404, "not found");
        auto fields = JsonReader(request.body).read_fields();
        if (fields && fields->done) found->second.done = *fields->done; // only a boolean counts
        return {200, to_json(found->second)};
    }

    Response delete_todo(const Request &, long id) {
        if (todos_.erase(id) == 0) return error(404, "not found");
        return {204, ""}; // no body
    }

  private:
    std::map<long, Todo> todos_; // sorted by id, which is creation order
    long next_id_ = 1;
};

// ---- The router: what a framework's app.get("/todos/{id}", …) builds -------

struct Route {
    std::string_view method;
    std::string_view pattern;                         // "{id}" stands for a number in the path
    Response (TodoApi::*handler)(const Request &, long); // a pointer to one of TodoApi's handlers
};

constexpr std::array<Route, 6> ROUTES = {{
    {"GET", "/health", &TodoApi::health},
    {"GET", "/todos", &TodoApi::list_todos},
    {"POST", "/todos", &TodoApi::create_todo},
    {"GET", "/todos/{id}", &TodoApi::get_todo},
    {"PATCH", "/todos/{id}", &TodoApi::update_todo},
    {"DELETE", "/todos/{id}", &TodoApi::delete_todo},
}};

// Walks pattern and path together: plain characters must be equal, and
// "{id}" takes a run of digits. Returns the id captured (0 when the pattern
// has none), or std::nullopt when the path does not fit the pattern.
std::optional<long> match(std::string_view pattern, std::string_view path) {
    long id = 0;
    while (!pattern.empty() && !path.empty()) {
        if (pattern.starts_with("{id}")) {
            auto digits = std::min(path.find_first_not_of("0123456789"), path.size());
            if (digits == 0) return std::nullopt;
            auto [end, error] = std::from_chars(path.data(), path.data() + digits, id);
            if (error != std::errc{}) id = -1; // too large to be any todo's id
            pattern.remove_prefix(4);
            path.remove_prefix(digits);
        } else if (pattern.front() == path.front()) {
            pattern.remove_prefix(1);
            path.remove_prefix(1);
        } else {
            return std::nullopt;
        }
    }
    if (!pattern.empty() || !path.empty()) return std::nullopt;
    return id;
}

// The first route whose method and pattern fit answers; none fit → 404.
Response route(TodoApi &api, const Request &request) {
    for (const Route &route : ROUTES) {
        if (route.method != request.method) continue;
        if (auto id = match(route.pattern, request.path)) return (api.*route.handler)(request, *id);
    }
    return error(404, "not found");
}

int main() {
    const char *port = std::getenv("PORT");
    const char *host = std::getenv("HOST");
    if (!host) host = "127.0.0.1";
    if (!port) {
        std::cerr << "set PORT, or turn on \"Run as a server\"" << std::endl;
        return 1;
    }
    std::signal(SIGPIPE, SIG_IGN); // a client that hangs up early must not kill the server

    // HOST and PORT → a socket address (IPv4 or IPv6); unique_ptr frees it.
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    addrinfo *found = nullptr;
    if (int status = getaddrinfo(host, port, &hints, &found); status != 0) {
        std::cerr << host << ": " << gai_strerror(status) << std::endl;
        return 1;
    }
    std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> address(found, freeaddrinfo);

    // socket → bind → listen: the server's side of TCP.
    Socket server(::socket(address->ai_family, address->ai_socktype, address->ai_protocol));
    int yes = 1;
    setsockopt(server.fd(), SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes); // rebind at once after a restart
    if (server.fd() < 0 || ::bind(server.fd(), address->ai_addr, address->ai_addrlen) < 0 ||
        ::listen(server.fd(), 16) < 0) {
        std::perror("listen");
        return 1;
    }
    std::cout << "listening on " << port << std::endl; // endl flushes: stdout is a pipe here

    // One connection at a time: accept, read a request, answer, close.
    TodoApi api;
    for (;;) {
        Socket client(::accept(server.fd(), nullptr, nullptr));
        if (client.fd() < 0) continue;
        timeval timeout{.tv_sec = 5, .tv_usec = 0};
        setsockopt(client.fd(), SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout); // a silent client must not stall us
        auto request = read_request(client);
        Response response = request ? route(api, *request) : error(400, "bad request");
        respond(client, response);
        std::cout << (request ? request->method + " " + request->path : "-") << " → " << response.status
                  << std::endl;
    } // client goes out of scope here, which closes the connection
}
