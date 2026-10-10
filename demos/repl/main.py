# A tiny calculator REPL: it reads what you type, line by line.
# Press Run, then answer under the output: 2 + 3, sum, help, quit.
# Ctrl+D (end of input) quits too. Auto Run plays the Input text instead.

OPS = {
    "+": lambda a, b: a + b,
    "-": lambda a, b: a - b,
    "*": lambda a, b: a * b,
    "/": lambda a, b: a / b,
}


def show(number):
    return str(int(number)) if number == int(number) else str(number)


def evaluate(line):
    parts = line.split()
    if len(parts) != 3 or parts[1] not in OPS:
        return None, "expected: <number> <op> <number>"
    try:
        a, b = float(parts[0]), float(parts[2])
    except ValueError:
        return None, "not a number"
    if parts[1] == "/" and b == 0:
        return None, "can't divide by zero"
    return OPS[parts[1]](a, b), None


results = []
print("Tiny calculator. Try 2 + 3, or: help, sum, quit")
while True:
    try:
        line = input("> ").strip()
    except EOFError:
        break
    if line == "quit":
        break
    if line == "":
        continue
    if line == "help":
        print("<number> <op> <number>, with op one of + - * /")
    elif line == "sum":
        print(f"total of {len(results)} results: {show(sum(results))}")
    else:
        result, error = evaluate(line)
        if error:
            print(f"? {error}")
        else:
            results.append(result)
            print(show(result))
print("bye")
