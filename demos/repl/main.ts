// A tiny calculator REPL: it reads what you type, line by line.
// Press Run, then answer under the output: 2 + 3, sum, help, quit.
// Ctrl+D (end of input) quits too. Auto Run plays the Input text instead.
import { createInterface } from "node:readline";

export function evaluate(line: string): number | string {
	const parts = line.split(/\s+/);
	if (parts.length !== 3) return "expected: <number> <op> <number>";
	const a = Number(parts[0]);
	const b = Number(parts[2]);
	if (Number.isNaN(a) || Number.isNaN(b)) return "not a number";
	switch (parts[1]) {
		case "+":
			return a + b;
		case "-":
			return a - b;
		case "*":
			return a * b;
		case "/":
			return b === 0 ? "can't divide by zero" : a / b;
	}
	return "expected: <number> <op> <number>";
}

const results: number[] = [];
console.log("Tiny calculator. Try 2 + 3, or: help, sum, quit");
const lines = createInterface({ input: process.stdin });
process.stdout.write("> ");
for await (const raw of lines) {
	const line = raw.trim();
	if (line === "quit") break;
	if (line === "help") {
		console.log("<number> <op> <number>, with op one of + - * /");
	} else if (line === "sum") {
		const total = results.reduce((sum, result) => sum + result, 0);
		console.log(`total of ${results.length} results: ${total}`);
	} else if (line !== "") {
		const result = evaluate(line);
		if (typeof result === "string") {
			console.log(`? ${result}`);
		} else {
			results.push(result);
			console.log(result);
		}
	}
	process.stdout.write("> ");
}
lines.close();
console.log("bye");
