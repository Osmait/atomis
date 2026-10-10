// A REST API for a todo list, on POSIX sockets alone: no framework and no
// libraries, so the HTTP parsing and the JSON a framework hides are here.
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define MAX_TODOS 256
#define MAX_TITLE 256      // bytes, with the terminating NUL; a longer title is a 400
#define MAX_REQUEST 16384  // request line, headers and body together
#define MAX_RESPONSE (1 << 20) // room for MAX_TODOS todos even with every title byte escaped

struct todo {
    long id;
    char title[MAX_TITLE];
    bool done;
};

static struct todo todos[MAX_TODOS]; // in creation order
static int count = 0;
static long next_id = 1;

// ---- JSON out: a growing response body ------------------------------------

struct buffer {
    char data[MAX_RESPONSE];
    size_t length;
};

static void append(struct buffer *out, const char *format, ...) {
    va_list args;
    va_start(args, format);
    int written = vsnprintf(out->data + out->length, sizeof out->data - out->length, format, args);
    va_end(args);
    if (written > 0) out->length += (size_t)written;
    if (out->length >= sizeof out->data) out->length = sizeof out->data - 1; // cut off, never overrun
}

// A JSON string: quoted, with " and \ escaped, and control characters as \u00XX.
static void append_string(struct buffer *out, const char *text) {
    append(out, "\"");
    for (const unsigned char *c = (const unsigned char *)text; *c; c++) {
        if (*c == '"' || *c == '\\') append(out, "\\%c", *c);
        else if (*c < 0x20) append(out, "\\u%04x", *c);
        else append(out, "%c", *c);
    }
    append(out, "\"");
}

static void append_todo(struct buffer *out, const struct todo *todo) {
    append(out, "{\"id\":%ld,\"title\":", todo->id);
    append_string(out, todo->title);
    append(out, ",\"done\":%s}", todo->done ? "true" : "false");
}

static int error(struct buffer *out, int status, const char *message) {
    append(out, "{\"error\":");
    append_string(out, message);
    append(out, "}");
    return status;
}

// ---- JSON in: just enough to read {"title": "…"} and {"done": true} -------
// Each reader takes a cursor into the body and returns the cursor past what it
// read, or NULL when the text there is not valid JSON.

static const char *skip_space(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}

static bool hex4(const char *p, unsigned *value) {
    *value = 0;
    for (int i = 0; i < 4; i++) {
        char c = p[i];
        int digit = c >= '0' && c <= '9'   ? c - '0'
                    : c >= 'a' && c <= 'f' ? c - 'a' + 10
                    : c >= 'A' && c <= 'F' ? c - 'A' + 10
                                           : -1;
        if (digit < 0) return false;
        *value = *value * 16 + (unsigned)digit;
    }
    return true;
}

// Encodes a code point as UTF-8 into out; returns how many bytes it took.
static size_t utf8(unsigned long code, char *out) {
    if (code < 0x80) {
        out[0] = (char)code;
        return 1;
    }
    if (code < 0x800) {
        out[0] = (char)(0xC0 | code >> 6);
        out[1] = (char)(0x80 | (code & 0x3F));
        return 2;
    }
    if (code < 0x10000) {
        out[0] = (char)(0xE0 | code >> 12);
        out[1] = (char)(0x80 | (code >> 6 & 0x3F));
        out[2] = (char)(0x80 | (code & 0x3F));
        return 3;
    }
    out[0] = (char)(0xF0 | code >> 18);
    out[1] = (char)(0x80 | (code >> 12 & 0x3F));
    out[2] = (char)(0x80 | (code >> 6 & 0x3F));
    out[3] = (char)(0x80 | (code & 0x3F));
    return 4;
}

// A string at p (on its opening quote), decoded into out; out may be NULL to
// only skip it. Fails when it does not fit in size bytes.
static const char *read_string(const char *p, char *out, size_t size) {
    static const char escaped[] = "\"\\/bfnrt", meaning[] = "\"\\/\b\f\n\r\t";
    if (*p++ != '"') return NULL;
    size_t length = 0;
    while (*p != '"') {
        char bytes[4];
        size_t n = 1;
        if ((unsigned char)*p < 0x20) return NULL; // the body ended, or a raw control character
        if (*p != '\\') {
            bytes[0] = *p++;
        } else if (p[1] != '\0' && strchr(escaped, p[1])) {
            bytes[0] = meaning[strchr(escaped, p[1]) - escaped];
            p += 2;
        } else if (p[1] == 'u') {
            unsigned unit, low;
            if (!hex4(p + 2, &unit)) return NULL;
            p += 6;
            unsigned long code = unit;
            if (unit >= 0xD800 && unit <= 0xDBFF) { // a surrogate pair: two \u escapes, one character
                if (p[0] != '\\' || p[1] != 'u' || !hex4(p + 2, &low) || low < 0xDC00 || low > 0xDFFF) return NULL;
                code = 0x10000 + ((unit - 0xD800UL) << 10) + (low - 0xDC00);
                p += 6;
            }
            if (code == 0 || (code >= 0xDC00 && code <= 0xDFFF)) return NULL; // C strings end at NUL
            n = utf8(code, bytes);
        } else {
            return NULL;
        }
        if (out) {
            if (length + n >= size) return NULL;
            memcpy(out + length, bytes, n);
        }
        length += n;
    }
    if (out) out[length] = '\0';
    return p + 1;
}

// Any value, skipped: strings, objects and arrays (nested), true, false, null
// and numbers (checked loosely: a run of the characters numbers are made of).
static const char *skip_value(const char *p) {
    p = skip_space(p);
    if (*p == '"') return read_string(p, NULL, 0);
    if (*p == '{' || *p == '[') {
        char close = *p == '{' ? '}' : ']';
        p = skip_space(p + 1);
        if (*p == close) return p + 1;
        for (;;) {
            if (close == '}') { // an object member starts with "key":
                p = read_string(skip_space(p), NULL, 0);
                if (!p || *(p = skip_space(p)) != ':') return NULL;
                p++;
            }
            if (!(p = skip_value(p))) return NULL;
            p = skip_space(p);
            if (*p == close) return p + 1;
            if (*p++ != ',') return NULL;
        }
    }
    if (strncmp(p, "true", 4) == 0 || strncmp(p, "null", 4) == 0) return p + 4;
    if (strncmp(p, "false", 5) == 0) return p + 5;
    size_t digits = strspn(p, "0123456789+-.eE");
    return digits ? p + digits : NULL;
}

// What a request body says, of what this API reads.
struct fields {
    bool has_title; // "title" was a string
    char title[MAX_TITLE];
    bool has_done; // "done" was a boolean
    bool done;
};

// Reads a body that must be one JSON object, keeping "title" and "done" when
// they have the right type and skipping every other member.
static bool read_fields(const char *p, struct fields *fields) {
    memset(fields, 0, sizeof *fields);
    p = skip_space(p);
    if (*p++ != '{') return false;
    p = skip_space(p);
    if (*p == '}') return *skip_space(p + 1) == '\0'; // {}
    for (;;) { // one "key": value member per turn
        char key[16];
        const char *after = read_string(p, key, sizeof key);
        if (!after) { // too long to be "title" or "done", or not a string at all
            key[0] = '\0';
            after = read_string(p, NULL, 0);
        }
        if (!after || *(p = skip_space(after)) != ':') return false;
        p = skip_space(p + 1);
        if (strcmp(key, "title") == 0 && *p == '"') {
            if (!(p = read_string(p, fields->title, sizeof fields->title))) return false;
            fields->has_title = true;
        } else if (strcmp(key, "done") == 0 && (strncmp(p, "true", 4) == 0 || strncmp(p, "false", 5) == 0)) {
            fields->has_done = true;
            fields->done = *p == 't';
            p += fields->done ? 4 : 5;
        } else if (!(p = skip_value(p))) {
            return false;
        }
        p = skip_space(p);
        if (*p == '}') break;
        if (*p++ != ',') return false;
        p = skip_space(p);
    }
    return *skip_space(p + 1) == '\0'; // nothing may follow the object
}

// ---- HTTP: one request in, one response out --------------------------------

struct request {
    char method[16];
    char path[1024];
    const char *body; // NUL-terminated, inside the read buffer
};

// Appends what the client has sent so far to buffer, keeping it a C string.
static bool receive(int client, char *buffer, size_t size, size_t *used) {
    if (*used + 1 >= size) return false; // the request is larger than the buffer
    ssize_t n = recv(client, buffer + *used, size - 1 - *used, 0);
    if (n <= 0) return false; // closed, failed or timed out
    *used += (size_t)n;
    buffer[*used] = '\0';
    return true;
}

// An HTTP/1.1 request is a request line, header lines, a blank line, then as
// many body bytes as the Content-Length header says:
//
//   POST /todos HTTP/1.1\r\n
//   Content-Type: application/json\r\n
//   Content-Length: 22\r\n
//   \r\n
//   {"title":"Learn HTTP"}
static bool read_request(int client, char *buffer, size_t size, struct request *request) {
    // 1. Read until the blank line that ends the headers.
    size_t used = 0;
    char *blank;
    buffer[0] = '\0';
    while (!(blank = strstr(buffer, "\r\n\r\n")))
        if (!receive(client, buffer, size, &used)) return false;
    *blank = '\0'; // the head is a string of its own now
    char *body = blank + 4;

    // 2. The request line: "PATCH /todos/1 HTTP/1.1".
    char version[16];
    if (sscanf(buffer, "%15s %1023s %15s", request->method, request->path, version) != 3) return false;
    if (strncmp(version, "HTTP/1.", 7) != 0) return false;

    // 3. The headers, one "Name: value" per line. Names ignore case; only
    //    Content-Length matters here (a chunked body is not supported).
    size_t length = 0;
    for (char *line = strstr(buffer, "\r\n"); line; line = strstr(line, "\r\n")) {
        line += 2;
        if (strncasecmp(line, "content-length:", 15) == 0) length = strtoul(line + 15, NULL, 10);
    }

    // 4. The body: exactly Content-Length bytes after the blank line.
    size_t head = (size_t)(body - buffer);
    if (length >= size - head) return false;
    while (used < head + length)
        if (!receive(client, buffer, size, &used)) return false;
    body[length] = '\0';
    request->body = body;
    return true;
}

static const char *reason(int status) {
    switch (status) {
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    case 400: return "Bad Request";
    case 404: return "Not Found";
    default: return "Insufficient Storage";
    }
}

static void send_all(int client, const char *data, size_t length) {
    while (length > 0) {
        ssize_t sent = send(client, data, length, 0);
        if (sent <= 0) return;
        data += sent;
        length -= (size_t)sent;
    }
}

// The status line and headers, then the body. 204 has no body, so no
// Content-Type or Content-Length either.
static void respond(int client, int status, const struct buffer *body) {
    char head[256];
    int n;
    if (status == 204)
        n = snprintf(head, sizeof head, "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    else
        n = snprintf(head, sizeof head,
                     "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n"
                     "Connection: close\r\n\r\n",
                     status, reason(status), body->length);
    send_all(client, head, (size_t)n);
    if (status != 204) send_all(client, body->data, body->length);
}

// ---- The API: one handler per endpoint -----------------------------------
// A handler gets the request, the id its path captured ({id}, or 0 when the
// route has none) and the buffer for its JSON answer; it returns the status.

// The index of todo id in todos, or -1.
static int find_todo(long id) {
    for (int i = 0; i < count; i++)
        if (todos[i].id == id) return i;
    return -1;
}

static int health(const struct request *request, long id, struct buffer *out) {
    (void)request, (void)id; // the same answer whatever was asked
    append(out, "{\"ok\":true}");
    return 200;
}

static int list_todos(const struct request *request, long id, struct buffer *out) {
    (void)request, (void)id;
    append(out, "[");
    for (int i = 0; i < count; i++) {
        if (i > 0) append(out, ",");
        append_todo(out, &todos[i]);
    }
    append(out, "]");
    return 200;
}

static int create_todo(const struct request *request, long id, struct buffer *out) {
    (void)id;
    struct fields fields = {0};
    if (!read_fields(request->body, &fields) || !fields.has_title || fields.title[0] == '\0')
        return error(out, 400, "title is required");
    if (count == MAX_TODOS) return error(out, 507, "the list is full");
    struct todo *todo = &todos[count++];
    todo->id = next_id++;
    memcpy(todo->title, fields.title, sizeof todo->title);
    todo->done = false;
    append_todo(out, todo);
    return 201;
}

static int get_todo(const struct request *request, long id, struct buffer *out) {
    (void)request;
    int i = find_todo(id);
    if (i < 0) return error(out, 404, "not found");
    append_todo(out, &todos[i]);
    return 200;
}

static int update_todo(const struct request *request, long id, struct buffer *out) {
    int i = find_todo(id);
    if (i < 0) return error(out, 404, "not found");
    struct fields fields = {0};
    if (read_fields(request->body, &fields) && fields.has_done) todos[i].done = fields.done; // only a boolean counts
    append_todo(out, &todos[i]);
    return 200;
}

static int delete_todo(const struct request *request, long id, struct buffer *out) {
    (void)request;
    int i = find_todo(id);
    if (i < 0) return error(out, 404, "not found");
    memmove(&todos[i], &todos[i + 1], (size_t)(count - i - 1) * sizeof todos[0]); // keep creation order
    count--;
    return 204; // no body
}

// ---- The router: what a framework's app.get("/todos/{id}", …) builds -------

typedef int handler(const struct request *request, long id, struct buffer *out);

struct route {
    const char *method;
    const char *pattern; // "{id}" stands for a number in the path
    handler *handle;
};

static const struct route ROUTES[] = {
    {"GET", "/health", health},
    {"GET", "/todos", list_todos},
    {"POST", "/todos", create_todo},
    {"GET", "/todos/{id}", get_todo},
    {"PATCH", "/todos/{id}", update_todo},
    {"DELETE", "/todos/{id}", delete_todo},
};

// Walks pattern and path together: plain characters must be equal, and
// "{id}" takes a run of digits, stored in *id. Both must end together.
static bool match(const char *pattern, const char *path, long *id) {
    while (*pattern && *path) {
        if (strncmp(pattern, "{id}", 4) == 0) {
            size_t digits = strspn(path, "0123456789");
            if (digits == 0) return false;
            *id = strtol(path, NULL, 10);
            pattern += 4;
            path += digits;
        } else if (*pattern++ != *path++) {
            return false;
        }
    }
    return *pattern == '\0' && *path == '\0';
}

// The first route whose method and pattern fit answers; none fit → 404.
static int handle(const struct request *request, struct buffer *out) {
    for (size_t r = 0; r < sizeof ROUTES / sizeof ROUTES[0]; r++) {
        long id = 0;
        if (strcmp(ROUTES[r].method, request->method) == 0 && match(ROUTES[r].pattern, request->path, &id))
            return ROUTES[r].handle(request, id, out);
    }
    return error(out, 404, "not found");
}

int main(void) {
    const char *port = getenv("PORT");
    const char *host = getenv("HOST");
    if (!host) host = "127.0.0.1";
    if (!port) {
        fprintf(stderr, "set PORT, or turn on \"Run as a server\"\n");
        return 1;
    }
    signal(SIGPIPE, SIG_IGN); // a client that hangs up early must not kill the server

    // HOST and PORT → a socket address. HOST is an IP address (IPv4 or IPv6),
    // not a name: resolving names takes getaddrinfo, which strict C17 hides.
    struct sockaddr_in ipv4 = {.sin_family = AF_INET, .sin_port = htons((unsigned short)atoi(port))};
    struct sockaddr_in6 ipv6 = {.sin6_family = AF_INET6, .sin6_port = ipv4.sin_port};
    bool is_ipv4 = inet_pton(AF_INET, host, &ipv4.sin_addr) == 1;
    if (!is_ipv4 && inet_pton(AF_INET6, host, &ipv6.sin6_addr) != 1) {
        fprintf(stderr, "HOST=%s is not an IP address\n", host);
        return 1;
    }
    struct sockaddr *address = is_ipv4 ? (struct sockaddr *)&ipv4 : (struct sockaddr *)&ipv6;
    socklen_t address_size = is_ipv4 ? sizeof ipv4 : sizeof ipv6;

    // socket → bind → listen: the server's side of TCP.
    int server = socket(address->sa_family, SOCK_STREAM, 0);
    int yes = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes); // rebind at once after a restart
    if (server < 0 || bind(server, address, address_size) < 0 || listen(server, 16) < 0) {
        perror("listen");
        return 1;
    }
    printf("listening on %s\n", port);
    fflush(stdout); // stdout is a pipe here, so fully buffered

    // One connection at a time: accept, read a request, answer, close.
    static char buffer[MAX_REQUEST];
    static struct buffer response;
    for (;;) {
        int client = accept(server, NULL, NULL);
        if (client < 0) continue;
        struct timeval timeout = {.tv_sec = 5};
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout); // a silent client must not stall us
        struct request request = {.method = "-", .path = "-"};
        response.length = 0;
        int code = read_request(client, buffer, sizeof buffer, &request) ? handle(&request, &response)
                                                                         : error(&response, 400, "bad request");
        respond(client, code, &response);
        close(client);
        printf("%s %s → %d\n", request.method, request.path, code);
        fflush(stdout);
    }
}
