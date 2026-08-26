import { randomBytes, timingSafeEqual } from "node:crypto";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	CreateSessionResponse,
	Language,
	ProbeDescriptor,
} from "@ziglive/protocol";
import { defaultRustSource, defaultSource, entryFileFor } from "@ziglive/protocol";
import {
	DocumentStore,
	type ProjectDocumentSnapshot,
	type ProjectFile,
} from "./DocumentStore.js";

type ProjectSessionResponse = CreateSessionResponse & { files: ProjectFile[] };

export interface SessionSettings {
	autoRun: boolean;
	autoInspect: boolean;
	debounceMs: number;
	timeoutMs: number;
	manualProbeIds: string[];
}

export interface LanguageSupport {
	present: boolean;
	run: boolean;
	lsp: boolean;
}

export interface Session {
	id: string;
	token: string;
	language: Language;
	entryPaths: string[];
	root: string;
	documentUri: string;
	store: DocumentStore;
	settings: SessionSettings;
	probes: ProbeDescriptor[];
	runtimeConnections: number;
	lspConnections: number;
	support: Record<Language, LanguageSupport>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../../../..");
const SESSION_ROOT = join(tmpdir(), "ziglive");
const SESSION_ID = /^[a-f0-9]{32}$/;

async function commandVersion(
	command: string,
	args: string[],
): Promise<string> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolveVersion) => {
		const child = spawn(command, args, {
			shell: false,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", () => resolveVersion("unavailable"));
		child.once("close", (code) =>
			resolveVersion(code === 0 ? output.trim().split("\n")[0]! : "unavailable"),
		);
	});
}

interface ToolchainInfo {
	zig: string;
	zls: string;
	rustc: string;
	cargo: string;
	rustAnalyzer: string;
}

let toolchainCache: Promise<ToolchainInfo> | undefined;

function detectToolchain(): Promise<ToolchainInfo> {
	toolchainCache ??= (async () => {
		const [zig, zls, rustc, cargo, rustAnalyzer] = await Promise.all([
			commandVersion("zig", ["version"]),
			commandVersion("zls", ["--version"]),
			commandVersion("rustc", ["--version"]),
			commandVersion("cargo", ["--version"]),
			commandVersion("rust-analyzer", ["--version"]),
		]);
		return { zig, zls, rustc, cargo, rustAnalyzer };
	})();
	return toolchainCache;
}

export function cargoCompatible(version: string): boolean {
	const match = /cargo (\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 1 || (major === 1 && minor >= 75);
}

export class SessionManager {
	private readonly sessions = new Map<string, Session>();
	public readonly root = SESSION_ROOT;

	public async initialize(): Promise<void> {
		await mkdir(SESSION_ROOT, { recursive: true, mode: 0o700 });
		const entries = await readdir(SESSION_ROOT).catch(() => []);
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		for (const entry of entries) {
			const path = join(SESSION_ROOT, entry);
			const info = await stat(path).catch(() => undefined);
			if (info?.isDirectory() && info.mtimeMs < cutoff)
				await rm(path, { recursive: true, force: true });
		}
	}

	private async populateZig(root: string): Promise<void> {
		await cp(
			join(PROJECT_ROOT, "zig/session-template/build.zig"),
			join(root, "build.zig"),
		);
		await cp(
			join(PROJECT_ROOT, "zig/session-template/build.zig.zon"),
			join(root, "build.zig.zon"),
		);
		await cp(
			join(PROJECT_ROOT, "zig/session-template/zls.json"),
			join(root, "zls.json"),
		);
		await cp(
			join(PROJECT_ROOT, "zig/runtime/runzig_runtime.zig"),
			join(root, "generated/runzig_runtime.zig"),
		);
		await cp(
			join(PROJECT_ROOT, "zig/test-runner/runzig_test_runner.zig"),
			join(root, "runzig_test_runner.zig"),
		);
		await writeFile(join(root, "test_root.zig"), "comptime {}\n", {
			encoding: "utf8",
			mode: 0o600,
		});
	}

	private async populateRust(root: string): Promise<void> {
		await cp(
			join(PROJECT_ROOT, "rust/session-template/Cargo.toml"),
			join(root, "Cargo.toml"),
		);
		await cp(
			join(PROJECT_ROOT, "rust/runtime/ziglive_runtime.rs"),
			join(root, "generated/ziglive_runtime.rs"),
		);
	}

	public async create(
		preferred: Language = "zig",
	): Promise<ProjectSessionResponse> {
		const id = randomBytes(16).toString("hex");
		const token = randomBytes(32).toString("base64url");
		const root = join(SESSION_ROOT, id);
		const sourceRoot = join(root, "src");
		await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
		await mkdir(join(root, "generated"), { recursive: true, mode: 0o700 });
		await mkdir(join(root, ".zig-cache"), { recursive: true, mode: 0o700 });

		const toolchain = await detectToolchain();
		const zigCompatible = /^0\.16\./.test(toolchain.zig);
		const zlsCompatible = /^0\.16\./.test(toolchain.zls);
		const rustCompatible = cargoCompatible(toolchain.cargo);
		const rustAnalyzerCompatible = /^rust-analyzer /.test(
			toolchain.rustAnalyzer,
		);

		// Every workspace is bilingual by extension: the Zig scaffold is always
		// present and the Rust scaffold joins when a usable cargo exists.
		await this.populateZig(root);
		if (rustCompatible) await this.populateRust(root);

		const language: Language =
			preferred === "rust" && rustCompatible ? "rust" : "zig";
		const entryPaths =
			language === "rust"
				? ["main.rs", "main.zig"]
				: rustCompatible
					? ["main.zig", "main.rs"]
					: ["main.zig"];
		const sources: Record<string, string> = {
			"main.zig": defaultSource,
			...(rustCompatible ? { "main.rs": defaultRustSource } : {}),
		};
		for (const [entry, source] of Object.entries(sources)) {
			await writeFile(join(sourceRoot, entry), source, {
				encoding: "utf8",
				mode: 0o600,
			});
			await writeFile(join(root, "generated", entry), source, {
				encoding: "utf8",
				mode: 0o600,
			});
		}
		const initialFiles = Object.entries(sources)
			.map(([path, source]) => ({
				path,
				uri: pathToFileURL(join(sourceRoot, path)).href,
				source,
			}))
			.sort((left, right) => left.path.localeCompare(right.path));
		const primaryEntry = entryFileFor(language);
		const documentUri = pathToFileURL(join(sourceRoot, primaryEntry)).href;
		const initialSource = sources[primaryEntry] ?? defaultSource;
		const initialSnapshot: ProjectDocumentSnapshot = {
			sessionId: id,
			version: 1,
			uri: documentUri,
			source: initialSource,
			files: initialFiles,
			updatedAt: Date.now(),
		};
		const session: Session = {
			id,
			token,
			language,
			entryPaths,
			root,
			documentUri,
			store: new DocumentStore(initialSnapshot, sourceRoot, entryPaths),
			settings: {
				autoRun: true,
				autoInspect: true,
				debounceMs: 400,
				timeoutMs: 2000,
				manualProbeIds: [],
			},
			probes: [],
			runtimeConnections: 0,
			lspConnections: 0,
			support: {
				zig: { present: true, run: zigCompatible, lsp: zlsCompatible },
				rust: {
					present: rustCompatible,
					run: rustCompatible,
					lsp: rustCompatible && rustAnalyzerCompatible,
				},
			},
		};
		this.sessions.set(id, session);
		const degraded: CreateSessionResponse["degraded"] = {};
		if (!zigCompatible)
			degraded.zig = `Expected Zig 0.16.x, detected ${toolchain.zig}`;
		if (!zlsCompatible)
			degraded.zls = `Expected ZLS 0.16.x, detected ${toolchain.zls}`;
		if (!rustCompatible)
			degraded.rust = `Rust sessions disabled: expected Rust 1.75+, detected ${toolchain.cargo}`;
		else if (!rustAnalyzerCompatible)
			degraded.rustAnalyzer = `rust-analyzer unavailable (${toolchain.rustAnalyzer})`;
		return {
			sessionId: id,
			authToken: token,
			language,
			documentUri,
			zigVersion: toolchain.zig,
			zlsVersion: toolchain.zls,
			rustcVersion: toolchain.rustc,
			cargoVersion: toolchain.cargo,
			rustAnalyzerVersion: toolchain.rustAnalyzer,
			initialSource,
			files: initialFiles,
			degraded,
		};
	}

	public authenticate(id: string, token: string): Session | undefined {
		if (!SESSION_ID.test(id)) return undefined;
		const session = this.sessions.get(id);
		if (!session || token.length > 128) return undefined;
		const left = Buffer.from(session.token);
		const right = Buffer.from(token);
		if (left.length !== right.length || !timingSafeEqual(left, right))
			return undefined;
		return session;
	}

	public get(id: string): Session | undefined {
		return SESSION_ID.test(id) ? this.sessions.get(id) : undefined;
	}

	public instrumenterPath(language: Language): string {
		return language === "rust"
			? join(
					PROJECT_ROOT,
					"rust",
					"instrumenter",
					"target",
					"release",
					"rustlive-instrument",
				)
			: join(PROJECT_ROOT, "zig-out", "bin", "runzig-instrument");
	}

	public async destroy(id: string): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;
		this.sessions.delete(id);
		await rm(session.root, { recursive: true, force: true });
	}

	public async close(): Promise<void> {
		const ids = [...this.sessions.keys()];
		await Promise.all(ids.map((id) => this.destroy(id)));
	}
}
