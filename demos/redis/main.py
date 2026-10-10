# A mini Redis: an in-memory key-value store that logs every write to a
# file, and replays (then compacts) that log the next time it starts.
# Press Run and type commands under the output: SET name Ada, GET name,
# INCR visits, DEL name, EXISTS name, KEYS, DBSIZE, FLUSHALL, QUIT.
# Run it again: the data is still there. Auto Run replays the Input text.

LOG = "../redis.aof"  # beside src/, so it is not one of your project files
COMMANDS = {"SET", "GET", "DEL", "EXISTS", "INCR", "KEYS", "DBSIZE", "FLUSHALL"}


def replay(path):
    """Rebuilds the store from the log: the cache starts as the file left it."""
    store, entries = {}, 0
    try:
        with open(path) as log:
            for line in log:
                entries += 1
                op, _, rest = line.rstrip("\n").partition(" ")
                if op == "SET":
                    key, _, value = rest.partition(" ")
                    store[key] = value
                elif op == "DEL":
                    store.pop(rest, None)
                elif op == "FLUSHALL":
                    store.clear()
    except FileNotFoundError:
        pass
    return store, entries


store, entries = replay(LOG)
print(f"loaded {len(store)} keys ({entries} log entries) from redis.aof")

# Compaction: the log restarts as one SET per key, then grows a line per write.
log = open(LOG, "w")
for key in sorted(store):
    log.write(f"SET {key} {store[key]}\n")
log.flush()


def append(entry):
    log.write(entry + "\n")
    log.flush()


def execute(words):
    command, args = words[0].upper(), words[1:]
    if command == "SET" and len(args) >= 2:
        key, value = args[0], " ".join(args[1:])
        store[key] = value
        append(f"SET {key} {value}")
        return "OK"
    if command == "GET" and len(args) == 1:
        return f'"{store[args[0]]}"' if args[0] in store else "(nil)"
    if command == "DEL" and len(args) == 1:
        if args[0] not in store:
            return "(integer) 0"
        del store[args[0]]
        append(f"DEL {args[0]}")
        return "(integer) 1"
    if command == "EXISTS" and len(args) == 1:
        return f"(integer) {int(args[0] in store)}"
    if command == "INCR" and len(args) == 1:
        try:
            number = int(store.get(args[0], "0")) + 1
        except ValueError:
            return "(error) ERR value is not an integer or out of range"
        store[args[0]] = str(number)
        append(f"SET {args[0]} {number}")
        return f"(integer) {number}"
    if command == "KEYS" and len(args) <= 1:
        keys = sorted(store)
        return "\n".join(f'{i}) "{key}"' for i, key in enumerate(keys, 1)) or "(empty array)"
    if command == "DBSIZE" and not args:
        return f"(integer) {len(store)}"
    if command == "FLUSHALL" and not args:
        store.clear()
        append("FLUSHALL")
        return "OK"
    if command in COMMANDS:
        return f"(error) ERR wrong number of arguments for '{words[0].lower()}'"
    return f"(error) ERR unknown command '{words[0]}'"


print("mini-redis ready: SET GET DEL EXISTS INCR KEYS DBSIZE FLUSHALL QUIT")
while True:
    try:
        line = input("redis> ")
    except EOFError:
        break
    words = line.split()
    if not words:
        continue
    if words[0].upper() == "QUIT":
        break
    print(execute(words))
log.close()
print("bye")
