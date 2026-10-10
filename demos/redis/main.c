// A mini Redis: an in-memory key-value store that logs every write to a
// file, and replays (then compacts) that log the next time it starts.
// Press Run and type commands under the output: SET name Ada, GET name,
// INCR visits, DEL name, EXISTS name, KEYS, DBSIZE, FLUSHALL, QUIT.
// Run it again: the data is still there. Auto Run replays the Input text.
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define LOG "../redis.aof" // beside src/, so it is not one of your project files
#define MAX_KEYS 256
#define MAX_WORDS 32

struct entry {
    char key[64];
    char value[256];
};

static struct entry store[MAX_KEYS];
static int size = 0;
static FILE *log_file;

static int find(const char *key) {
    for (int i = 0; i < size; i++)
        if (strcmp(store[i].key, key) == 0) return i;
    return -1;
}

static int set(const char *key, const char *value) {
    int i = find(key);
    if (i < 0) {
        if (size == MAX_KEYS) return 0;
        i = size++;
        snprintf(store[i].key, sizeof store[i].key, "%s", key);
    }
    snprintf(store[i].value, sizeof store[i].value, "%s", value);
    return 1;
}

static int del(const char *key) {
    int i = find(key);
    if (i < 0) return 0;
    store[i] = store[--size];
    return 1;
}

static int by_key(const void *a, const void *b) {
    return strcmp(((const struct entry *)a)->key, ((const struct entry *)b)->key);
}

// Rebuilds the store from the log: the cache starts as the file left it.
static int replay(const char *path) {
    FILE *file = fopen(path, "r");
    if (!file) return 0;
    char line[512];
    int entries = 0;
    while (fgets(line, sizeof line, file)) {
        line[strcspn(line, "\n")] = '\0';
        entries++;
        char *rest = strchr(line, ' ');
        if (rest) *rest++ = '\0';
        if (strcmp(line, "SET") == 0 && rest) {
            char *value = strchr(rest, ' ');
            if (value) *value++ = '\0';
            set(rest, value ? value : "");
        } else if (strcmp(line, "DEL") == 0 && rest) {
            del(rest);
        } else if (strcmp(line, "FLUSHALL") == 0) {
            size = 0;
        }
    }
    fclose(file);
    return entries;
}

static void append(const char *entry) {
    fprintf(log_file, "%s\n", entry);
    fflush(log_file);
}

static const char *commands[] = {"SET", "GET", "DEL", "EXISTS", "INCR", "KEYS", "DBSIZE", "FLUSHALL"};

static void execute(char **words, int count) {
    const char *command = words[0];
    char **args = words + 1;
    int argc = count - 1;
    char entry[512];
    if (strcasecmp(command, "SET") == 0 && argc >= 2) {
        char value[256] = "";
        for (int i = 1; i < argc; i++) {
            if (i > 1) strncat(value, " ", sizeof value - strlen(value) - 1);
            strncat(value, args[i], sizeof value - strlen(value) - 1);
        }
        if (!set(args[0], value)) {
            puts("(error) ERR the store is full");
            return;
        }
        snprintf(entry, sizeof entry, "SET %s %s", args[0], value);
        append(entry);
        puts("OK");
    } else if (strcasecmp(command, "GET") == 0 && argc == 1) {
        int i = find(args[0]);
        if (i < 0) puts("(nil)");
        else printf("\"%s\"\n", store[i].value);
    } else if (strcasecmp(command, "DEL") == 0 && argc == 1) {
        if (!del(args[0])) {
            puts("(integer) 0");
            return;
        }
        snprintf(entry, sizeof entry, "DEL %s", args[0]);
        append(entry);
        puts("(integer) 1");
    } else if (strcasecmp(command, "EXISTS") == 0 && argc == 1) {
        printf("(integer) %d\n", find(args[0]) >= 0);
    } else if (strcasecmp(command, "INCR") == 0 && argc == 1) {
        int i = find(args[0]);
        const char *current = i < 0 ? "0" : store[i].value;
        char *end;
        errno = 0;
        long long number = strtoll(current, &end, 10);
        if (*current == '\0' || isspace((unsigned char)*current) || *end != '\0' || errno == ERANGE ||
            number == LLONG_MAX) {
            puts("(error) ERR value is not an integer or out of range");
            return;
        }
        char text[32];
        snprintf(text, sizeof text, "%lld", number + 1);
        if (!set(args[0], text)) {
            puts("(error) ERR the store is full");
            return;
        }
        snprintf(entry, sizeof entry, "SET %s %s", args[0], text);
        append(entry);
        printf("(integer) %s\n", text);
    } else if (strcasecmp(command, "KEYS") == 0 && argc <= 1) {
        if (size == 0) puts("(empty array)");
        qsort(store, size, sizeof store[0], by_key);
        for (int i = 0; i < size; i++) printf("%d) \"%s\"\n", i + 1, store[i].key);
    } else if (strcasecmp(command, "DBSIZE") == 0 && argc == 0) {
        printf("(integer) %d\n", size);
    } else if (strcasecmp(command, "FLUSHALL") == 0 && argc == 0) {
        size = 0;
        append("FLUSHALL");
        puts("OK");
    } else {
        for (size_t i = 0; i < sizeof commands / sizeof commands[0]; i++) {
            if (strcasecmp(command, commands[i]) == 0) {
                char lower[64];
                snprintf(lower, sizeof lower, "%s", command);
                for (char *c = lower; *c; c++) *c = (char)tolower((unsigned char)*c);
                printf("(error) ERR wrong number of arguments for '%s'\n", lower);
                return;
            }
        }
        printf("(error) ERR unknown command '%s'\n", command);
    }
}

int main(void) {
    int entries = replay(LOG);
    printf("loaded %d keys (%d log entries) from redis.aof\n", size, entries);
    // Compaction: the log restarts as one SET per key, then grows a line per write.
    log_file = fopen(LOG, "w");
    if (!log_file) {
        perror(LOG);
        return 1;
    }
    qsort(store, size, sizeof store[0], by_key);
    for (int i = 0; i < size; i++) fprintf(log_file, "SET %s %s\n", store[i].key, store[i].value);
    fflush(log_file);

    puts("mini-redis ready: SET GET DEL EXISTS INCR KEYS DBSIZE FLUSHALL QUIT");
    char line[512];
    for (;;) {
        // stdout is a pipe here, so fully buffered: flush the prompt.
        printf("redis> ");
        fflush(stdout);
        if (!fgets(line, sizeof line, stdin)) break;
        char *words[MAX_WORDS];
        int count = 0;
        for (char *word = strtok(line, " \t\r\n"); word && count < MAX_WORDS; word = strtok(NULL, " \t\r\n"))
            words[count++] = word;
        if (count == 0) continue;
        if (strcasecmp(words[0], "QUIT") == 0) break;
        execute(words, count);
    }
    fclose(log_file);
    puts("bye");
    return 0;
}
