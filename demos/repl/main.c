// A tiny calculator REPL: it reads what you type, line by line.
// Press Run, then answer under the output: 2 + 3, sum, help, quit.
// Ctrl+D (end of input) quits too. Auto Run plays the Input text instead.
#include <stdio.h>
#include <string.h>

#define MAX_RESULTS 256

static const char *evaluate(const char *line, double *result) {
    double a, b;
    char op, extra;
    if (sscanf(line, "%lf %c %lf %c", &a, &op, &b, &extra) != 3)
        return "expected: <number> <op> <number>";
    switch (op) {
    case '+': *result = a + b; return NULL;
    case '-': *result = a - b; return NULL;
    case '*': *result = a * b; return NULL;
    case '/':
        if (b == 0) return "can't divide by zero";
        *result = a / b;
        return NULL;
    }
    return "expected: <number> <op> <number>";
}

int main(void) {
    double results[MAX_RESULTS];
    int count = 0;
    char line[256];
    puts("Tiny calculator. Try 2 + 3, or: help, sum, quit");
    for (;;) {
        // stdout is a pipe here, so fully buffered: flush the prompt.
        printf("> ");
        fflush(stdout);
        if (!fgets(line, sizeof line, stdin)) break;
        line[strcspn(line, "\r\n")] = '\0';
        if (strcmp(line, "quit") == 0) break;
        if (line[0] == '\0') continue;
        if (strcmp(line, "help") == 0) {
            puts("<number> <op> <number>, with op one of + - * /");
        } else if (strcmp(line, "sum") == 0) {
            double total = 0;
            for (int i = 0; i < count; i++) total += results[i];
            printf("total of %d results: %g\n", count, total);
        } else {
            double result = 0;
            const char *error = evaluate(line, &result);
            if (error) {
                printf("? %s\n", error);
            } else {
                if (count < MAX_RESULTS) results[count++] = result;
                printf("%g\n", result);
            }
        }
    }
    puts("bye");
    return 0;
}
