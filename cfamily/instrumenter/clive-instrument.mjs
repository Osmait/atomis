// clive-instrument: the Atomis source instrumenter for C and C++. Parses
// the file with clang's JSON AST dump using EMPTY STUBS for system includes
// (only the syntactic shape is needed, and clang's recovery keeps VarDecls
// with names and byte offsets even when types are unknown), then splices
// probe/log calls into the ORIGINAL text preserving the newline count. The
// probe runtime is injected at compile time with `-include`, so user files
// never gain imports. Parse diagnostics are left to the real compile step,
// which sees the true headers.
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAX_SOURCE_BYTES = 1024 * 1024;

function fnv1a64(input) {
	let hash = 0xcbf29ce484222325n;
	for (const byte of Buffer.from(input, "utf8")) {
		hash ^= BigInt(byte);
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}

function probeId(uri, startByte, endByte, name) {
	const key = `clive-v1|${uri}|${startByte}-${endByte}|${name}`;
	return fnv1a64(key) + fnv1a64(`${key}|2`);
}

function makeStubs(source) {
	const stubDir = mkdtempSync(join(tmpdir(), "atomis-stubs-"));
	for (const match of source.matchAll(/^\s*#\s*include\s*<([^>]+)>/gm)) {
		const header = match[1];
		if (header.includes("..")) continue;
		const target = join(stubDir, header);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "");
	}
	return stubDir;
}

export function instrument(source, options) {
	const { inputPath, uri, lang, autoInspect, manualIds, fileId } = options;
	if (source.includes("__atomis_probe(") || source.includes("__atomis_log"))
		return { generated: source, probes: [] };

	const stubDir = makeStubs(source);
	let dump;
	try {
		const clang = lang === "cpp" ? "clang++" : "clang";
		const result = spawnSync(
			clang,
			[
				"-x",
				lang === "cpp" ? "c++" : "c",
				`-std=${lang === "cpp" ? "c++20" : "c17"}`,
				"-nostdinc",
				"-nostdinc++",
				"-isystem",
				stubDir,
				"-Wno-everything",
				"-fsyntax-only",
				"-Xclang",
				"-ast-dump=json",
				inputPath,
			],
			{
				cwd: dirname(inputPath),
				encoding: "utf8",
				maxBuffer: 128 * 1024 * 1024,
			},
		);
		try {
			dump = JSON.parse(result.stdout);
		} catch {
			// Unparseable source: run without probes; the real compile reports.
			return { generated: source, probes: [] };
		}
	} finally {
		rmSync(stubDir, { recursive: true, force: true });
	}

	const probes = [];
	const insertions = [];
	const loops = [];
	const loopRanges = [];
	const markedLines = new Set();
	const skipDeclStmts = new Set();
	const state = { file: "", line: 0 };

	const track = (location) => {
		if (!location || typeof location !== "object") return undefined;
		const spot = location.spellingLoc ?? location;
		if (typeof spot.file === "string") state.file = spot.file;
		if (typeof spot.line === "number") state.line = spot.line;
		return spot;
	};
	const inInput = () =>
		state.file === inputPath || state.file.endsWith(`/${options.inputName}`);

	const sourceLineOf = () => state.line;

	const recordProbe = (varDecl, statementEnd, reason) => {
		const loc = track(varDecl.loc) ?? {};
		const line = sourceLineOf();
		const column = typeof loc.col === "number" ? loc.col : 1;
		const startByte = typeof loc.offset === "number" ? loc.offset : 0;
		const name = varDecl.name;
		const endByte = startByte + name.length;
		const id = probeId(uri, startByte, endByte, name);
		const active =
			!reason && (autoInspect || manualIds.includes(id));
		if (active)
			insertions.push({
				offset: statementEnd,
				text: ` __atomis_probe("${id}", ${line}, ${column}, "${name}", ${name});`,
			});
		probes.push({
			probeId: id,
			name,
			supported: !reason,
			...(reason ? { reason } : {}),
			originalRange: {
				startLine: line,
				startColumn: column,
				endLine: line,
				endColumn: column + name.length,
				startByte,
				endByte,
			},
			...(active ? { insertionByte: statementEnd } : {}),
			mode: autoInspect ? "auto" : "manual",
		});
	};

	const rangeOf = (node) => {
		const begin = track(node.range?.begin);
		const beginLine = sourceLineOf();
		const end = track(node.range?.end);
		if (
			typeof begin?.offset !== "number" ||
			typeof end?.offset !== "number"
		)
			return undefined;
		return {
			begin: begin.offset,
			beginLine,
			beginCol: typeof begin.col === "number" ? begin.col : 1,
			end: end.offset + (end.tokLen ?? 0),
		};
	};

	const firstDeclRefName = (node) => {
		if (node?.kind === "DeclRefExpr" && node.referencedDecl?.name)
			return node.referencedDecl.name;
		for (const child of node?.inner ?? []) {
			const found = firstDeclRefName(child);
			if (found) return found;
		}
		return "";
	};

	const visit = (node, parent) => {
		if (!node || typeof node !== "object" || !node.kind) {
			track(node?.loc);
			for (const child of node?.inner ?? []) visit(child, parent);
			return;
		}
		const range = rangeOf(node);
		track(node.loc);
		const inMain = inInput();

		if (
			node.kind === "ForStmt" ||
			node.kind === "WhileStmt" ||
			node.kind === "DoStmt" ||
			node.kind === "CXXForRangeStmt"
		) {
			let variable = "";
			for (const child of node.inner ?? []) {
				if (child?.kind === "DeclStmt") {
					skipDeclStmts.add(child);
					const varDecl = (child.inner ?? []).find(
						(inner) => inner?.kind === "VarDecl" && inner.name,
					);
					if (varDecl && !variable) variable = varDecl.name;
				}
			}
			if (!variable) variable = firstDeclRefName(node.inner?.[0]);
			const meta = {
				line: range?.beginLine ?? sourceLineOf(),
				column: range?.beginCol ?? 1,
				variable,
			};
			loops.push(meta);
			if (inMain && range)
				loopRanges.push({
					...meta,
					beginLine: meta.line,
					endLine: sourceLineOf(),
				});
			for (const child of node.inner ?? []) visit(child, node);
			loops.pop();
			return;
		}

		if (
			node.kind === "DeclStmt" &&
			inMain &&
			range &&
			!skipDeclStmts.has(node)
		) {
			const varDecls = (node.inner ?? []).filter(
				(child) => child?.kind === "VarDecl",
			);
			if (varDecls.length === 1 && varDecls[0].name) {
				// clang ≤18 drops the recovered initializer of an unknown-type
				// VarDecl from the JSON dump entirely (newer clangs keep a
				// RecoveryExpr and the init marker), so fall back to the
				// statement text to tell `T x = …;` from `T x;`.
				const statementText = source.slice(range.begin, range.end);
				const afterName = statementText.slice(
					statementText.indexOf(varDecls[0].name),
				);
				const initialized =
					varDecls[0].init !== undefined || /[={]/.test(afterName);
				if (initialized) recordProbe(varDecls[0], range.end, undefined);
				else
					recordProbe(
						varDecls[0],
						range.end,
						"declaration without initializer",
					);
			} else if (varDecls.length > 1 && varDecls[0]?.name)
				recordProbe(varDecls[0], range.end, "multiple declaration");
		}

		if (
			parent?.kind === "CompoundStmt" &&
			node.kind !== "DeclStmt" &&
			node.kind !== "CompoundStmt" &&
			node.kind !== "IfStmt" &&
			node.kind !== "ReturnStmt" &&
			node.kind !== "SwitchStmt" &&
			inMain &&
			range
		) {
			const text = source.slice(range.begin, range.end);
			let fd = 0;
			if (/\bcerr\b/.test(text) || /fprintf\s*\(\s*stderr/.test(text))
				fd = 2;
			else if (/\bcout\b|\bprintf\s*\(|\bputs\s*\(/.test(text)) fd = 1;
			if (fd) {
				markedLines.add(range.beginLine);
				const enclosing = loops.at(-1);
				const marker =
					enclosing?.variable
						? `, __atomis_log_loop(${fd}, ${fileId}, ${range.beginLine}, ${range.beginCol}, ${enclosing.line}, ${enclosing.column}, "${enclosing.variable}", ${enclosing.variable})`
						: `, __atomis_log(${fd}, ${fileId}, ${range.beginLine}, ${range.beginCol})`;
				insertions.push({ offset: range.end, text: marker });
			}
		}

		for (const child of node.inner ?? []) visit(child, node);
	};
	visit(dump, undefined);

	// Statements built on stream objects from stubbed headers (std::cout,
	// std::cerr) vanish from the recovered AST, so single-line stream
	// statements are matched textually and get their marker via the same
	// comma-operator insertion before the closing semicolon.
	{
		const lines = source.split("\n");
		let offset = 0;
		for (const [index, lineText] of lines.entries()) {
			const lineNumber = index + 1;
			const match =
				/^(\s*)(?:std\s*::\s*)?(cout|cerr)\s*<<.*;\s*$/.exec(lineText);
			if (match && !markedLines.has(lineNumber)) {
				const fd = match[2] === "cerr" ? 2 : 1;
				const semicolon = lineText.lastIndexOf(";");
				const enclosing = loopRanges
					.filter(
						(loop) =>
							loop.beginLine <= lineNumber && loop.endLine >= lineNumber,
					)
					.at(-1);
				const marker = enclosing?.variable
					? `, __atomis_log_loop(${fd}, ${fileId}, ${lineNumber}, ${(match[1]?.length ?? 0) + 1}, ${enclosing.line}, ${enclosing.column}, "${enclosing.variable}", ${enclosing.variable})`
					: `, __atomis_log(${fd}, ${fileId}, ${lineNumber}, ${(match[1]?.length ?? 0) + 1})`;
				insertions.push({ offset: offset + semicolon, text: marker });
			}
			offset += lineText.length + 1;
		}
	}

	insertions.sort((left, right) => right.offset - left.offset);
	let generated = source;
	for (const item of insertions)
		if (item.offset <= generated.length)
			generated =
				generated.slice(0, item.offset) +
				item.text +
				generated.slice(item.offset);
	const newlines = (text) => (text.match(/\n/g) ?? []).length;
	if (newlines(source) !== newlines(generated))
		return { generated: source, probes: [] };
	return { generated, probes };
}

function render(result, output, sourceMap, version) {
	return JSON.stringify({
		protocolVersion: 1,
		documentVersion: version,
		generatedPath: output,
		sourceMapPath: sourceMap,
		probes: result.probes,
		parseDiagnostics: [],
	});
}

export function runCli(argv) {
	const options = {
		uri: "file:///main.c",
		version: 1,
		fileId: 0,
		autoInspect: true,
		manual: [],
		lang: "c",
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const next = () => argv[++index];
		if (arg === "--no-auto-inspect") options.autoInspect = false;
		else if (arg === "--entry") continue;
		else if (arg === "--lang") options.lang = next() === "cpp" ? "cpp" : "c";
		else if (arg === "--input") options.input = next();
		else if (arg === "--output") options.output = next();
		else if (arg === "--source-map") options.sourceMap = next();
		else if (arg === "--uri") options.uri = next() ?? options.uri;
		else if (arg === "--version") options.version = Number(next() ?? 1);
		else if (arg === "--file-id") options.fileId = Number(next() ?? 0);
		else if (arg === "--manual") options.manual.push(next() ?? "");
		else {
			process.stderr.write(`clive-instrument: invalid argument: ${arg}\n`);
			return 1;
		}
	}
	if (!options.input || !options.output || !options.sourceMap) {
		process.stderr.write(
			"clive-instrument: missing --input/--output/--source-map\n",
		);
		return 1;
	}
	if (statSync(options.input).size > MAX_SOURCE_BYTES) {
		process.stderr.write(
			`clive-instrument: ${options.input} exceeds 1 MiB\n`,
		);
		return 1;
	}
	const source = readFileSync(options.input, "utf8");
	const result = instrument(source, {
		inputPath: options.input,
		inputName: options.input.split("/").at(-1) ?? options.input,
		uri: options.uri,
		lang: options.lang,
		autoInspect: options.autoInspect,
		manualIds: options.manual,
		fileId: options.fileId,
	});
	const payload = render(
		result,
		options.output,
		options.sourceMap,
		options.version,
	);
	writeFileSync(options.output, result.generated, { mode: 0o600 });
	writeFileSync(options.sourceMap, payload, { mode: 0o600 });
	process.stdout.write(`${payload}\n`);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`)
	process.exit(runCli(process.argv.slice(2)));
