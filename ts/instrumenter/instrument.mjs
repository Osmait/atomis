// tslive-instrument: the Atomis source instrumenter for TypeScript and
// JavaScript. Mirrors the runzig/rustlive/golive contract — parse one file
// with the repo's TypeScript compiler API, record probe insertion points for
// simple const/let/var declarations (top level included: module bodies are
// executable) and source markers for direct console statements, then splice
// the calls into the ORIGINAL text so the generated copy keeps every
// character and the exact newline count. The runtime globals are installed
// by `node --import`, so no import is added to user files.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import ts from "typescript-ast";

const MAX_SOURCE_BYTES = 1024 * 1024;

const LOG_TARGETS = new Map([
	["log", 1],
	["info", 1],
	["debug", 1],
	["trace", 2],
	["warn", 2],
	["error", 2],
]);

function fnv1a64(input) {
	let hash = 0xcbf29ce484222325n;
	for (const byte of Buffer.from(input, "utf8")) {
		hash ^= BigInt(byte);
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}

function probeId(uri, range, name) {
	const key = `tslive-v1|${uri}|${range.startByte}-${range.endByte}|${name}`;
	return fnv1a64(key) + fnv1a64(`${key}|2`);
}

export function instrument(source, uri, autoInspect, manualIds, fileId) {
	if (
		source.includes("__atomis_probe(") ||
		source.includes("__atomis_log")
	) {
		return { generated: source, probes: [], parseDiagnostics: [] };
	}
	const scriptKind =
		uri.endsWith(".js") || uri.endsWith(".mjs") || uri.endsWith(".cjs")
			? ts.ScriptKind.JS
			: ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(
		"input.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKind,
	);
	const parseErrors = sourceFile.parseDiagnostics ?? [];
	if (parseErrors.length) {
		return {
			generated: undefined,
			probes: [],
			parseDiagnostics: parseErrors.map((diagnostic) => {
				const at = sourceFile.getLineAndCharacterOfPosition(
					diagnostic.start ?? 0,
				);
				return {
					message: ts.flattenDiagnosticMessageText(
						diagnostic.messageText,
						" ",
					),
					line: at.line + 1,
					column: at.character + 1,
				};
			}),
		};
	}

	const manual = new Set(manualIds);
	const probes = [];
	const insertions = [];
	const loops = [];

	const position = (pos) => {
		const at = sourceFile.getLineAndCharacterOfPosition(pos);
		return { line: at.line + 1, column: at.character + 1 };
	};

	const recordProbe = (nameNode, statementEnd, reason) => {
		const start = nameNode.getStart(sourceFile);
		const startAt = position(start);
		const endAt = position(nameNode.end);
		const range = {
			startLine: startAt.line,
			startColumn: startAt.column,
			endLine: endAt.line,
			endColumn: endAt.column,
			startByte: start,
			endByte: nameNode.end,
		};
		const name = nameNode.getText(sourceFile);
		const id = probeId(uri, range, name);
		const active = !reason && (autoInspect || manual.has(id));
		if (active)
			insertions.push({
				offset: statementEnd,
				text: `; __atomis_probe(${JSON.stringify(id)}, ${range.startLine}, ${range.startColumn}, ${JSON.stringify(name)}, ${name});`,
			});
		probes.push({
			probeId: id,
			name,
			supported: !reason,
			...(reason ? { reason } : {}),
			originalRange: range,
			...(active ? { insertionByte: statementEnd } : {}),
			mode: autoInspect ? "auto" : "manual",
		});
	};

	const firstIdentifier = (node) => {
		if (ts.isIdentifier(node)) return node.getText(sourceFile);
		let found = "";
		node.forEachChild(function search(child) {
			if (found) return;
			if (ts.isIdentifier(child)) {
				found = child.getText(sourceFile);
				return;
			}
			child.forEachChild(search);
		});
		return found;
	};

	const loopVariable = (node) => {
		if (
			(ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
			ts.isVariableDeclarationList(node.initializer)
		) {
			const declaration = node.initializer.declarations[0];
			if (declaration && ts.isIdentifier(declaration.name))
				return declaration.name.getText(sourceFile);
		}
		if (ts.isForStatement(node) && node.initializer) {
			if (ts.isVariableDeclarationList(node.initializer)) {
				const declaration = node.initializer.declarations[0];
				if (declaration && ts.isIdentifier(declaration.name))
					return declaration.name.getText(sourceFile);
			}
		}
		if (
			(ts.isWhileStatement(node) || ts.isDoStatement(node)) &&
			node.expression
		)
			return firstIdentifier(node.expression);
		return "";
	};

	const visit = (node) => {
		if (
			ts.isForStatement(node) ||
			ts.isForOfStatement(node) ||
			ts.isForInStatement(node) ||
			ts.isWhileStatement(node) ||
			ts.isDoStatement(node)
		) {
			const at = position(node.getStart(sourceFile));
			loops.push({ line: at.line, column: at.column, variable: loopVariable(node) });
			ts.forEachChild(node, visit);
			loops.pop();
			return;
		}

		if (ts.isVariableStatement(node)) {
			const declarations = node.declarationList.declarations;
			if (declarations.length === 1) {
				const declaration = declarations[0];
				if (ts.isIdentifier(declaration.name)) {
					if (declaration.initializer)
						recordProbe(declaration.name, node.end, "");
					else
						recordProbe(
							declaration.name,
							node.end,
							"declaración sin inicializador",
						);
				} else recordProbe(declaration.name, node.end, "patrón de desestructuración");
			} else if (declarations[0])
				recordProbe(declarations[0].name, node.end, "declaración múltiple");
		}

		if (
			ts.isExpressionStatement(node) &&
			ts.isCallExpression(node.expression) &&
			ts.isPropertyAccessExpression(node.expression.expression) &&
			ts.isIdentifier(node.expression.expression.expression) &&
			node.expression.expression.expression.getText(sourceFile) === "console"
		) {
			const method = node.expression.expression.name.getText(sourceFile);
			const fd = LOG_TARGETS.get(method);
			if (fd !== undefined) {
				const at = position(node.getStart(sourceFile));
				const enclosing = loops.at(-1);
				if (enclosing?.variable)
					insertions.push({
						offset: node.end,
						text: `; __atomis_log_loop(${fd}, ${fileId}, ${at.line}, ${at.column}, ${enclosing.line}, ${enclosing.column}, ${JSON.stringify(enclosing.variable)}, ${enclosing.variable});`,
					});
				else
					insertions.push({
						offset: node.end,
						text: `; __atomis_log(${fd}, ${fileId}, ${at.line}, ${at.column});`,
					});
			}
		}

		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sourceFile, visit);

	insertions.sort((left, right) => right.offset - left.offset);
	let generated = source;
	for (const item of insertions)
		generated =
			generated.slice(0, item.offset) + item.text + generated.slice(item.offset);
	const newlines = (text) => (text.match(/\n/g) ?? []).length;
	if (newlines(source) !== newlines(generated))
		return {
			generated: undefined,
			probes: [],
			parseDiagnostics: [
				{
					message: "instrumentation would change the line count",
					line: 1,
					column: 1,
				},
			],
		};
	return { generated, probes, parseDiagnostics: [] };
}

function render(result, output, sourceMap, version) {
	const payload = {
		protocolVersion: 1,
		documentVersion: version,
		...(result.generated !== undefined
			? { generatedPath: output, sourceMapPath: sourceMap }
			: {}),
		probes: result.probes,
		parseDiagnostics: result.parseDiagnostics.map((diagnostic) => ({
			message: diagnostic.message,
			severity: "error",
			line: diagnostic.line,
			column: diagnostic.column,
		})),
	};
	return JSON.stringify(payload);
}

export function runCli(argv) {
	const options = {
		uri: "file:///main.ts",
		version: 1,
		fileId: 0,
		autoInspect: true,
		manual: [],
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const next = () => argv[++index];
		if (arg === "--no-auto-inspect") options.autoInspect = false;
		else if (arg === "--entry") continue;
		else if (arg === "--input") options.input = next();
		else if (arg === "--output") options.output = next();
		else if (arg === "--source-map") options.sourceMap = next();
		else if (arg === "--uri") options.uri = next() ?? options.uri;
		else if (arg === "--version") options.version = Number(next() ?? 1);
		else if (arg === "--file-id") options.fileId = Number(next() ?? 0);
		else if (arg === "--manual") options.manual.push(next() ?? "");
		else {
			process.stderr.write(`tslive-instrument: invalid argument: ${arg}\n`);
			return 1;
		}
	}
	if (!options.input || !options.output || !options.sourceMap) {
		process.stderr.write(
			"tslive-instrument: missing --input/--output/--source-map\n",
		);
		return 1;
	}
	if (statSync(options.input).size > MAX_SOURCE_BYTES) {
		process.stderr.write(`tslive-instrument: ${options.input} exceeds 1 MiB\n`);
		return 1;
	}
	const source = readFileSync(options.input, "utf8");
	const result = instrument(
		source,
		options.uri,
		options.autoInspect,
		options.manual,
		options.fileId,
	);
	const json = render(result, options.output, options.sourceMap, options.version);
	if (result.generated !== undefined) {
		writeFileSync(options.output, result.generated, { mode: 0o600 });
		writeFileSync(options.sourceMap, json, { mode: 0o600 });
	}
	process.stdout.write(`${json}\n`);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`)
	process.exit(runCli(process.argv.slice(2)));
