import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	CreateSessionResponse,
	Language,
	ProbeDescriptor,
} from "@ziglive/protocol";
import { LANGUAGE_PACKS } from "../languages/registry.js";
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
			resolveVersion(
				code === 0 ? (output.trim().split("\n")[0] ?? "") : "unavailable",
			),
		);
	});
}

let toolchainCache: Promise<Map<string, string>> | undefined;

/** Detects every registered tool once per server process. */
function detectToolchain(): Promise<Map<string, string>> {
	toolchainCache ??= (async () => {
		const checks = new Map<string, string[]>();
		for (const pack of Object.values(LANGUAGE_PACKS)) {
			checks.set(pack.toolchain.run.command, pack.toolchain.run.args);
			if (pack.toolchain.lsp)
				checks.set(pack.toolchain.lsp.command, pack.toolchain.lsp.args);
		}
		const versions = new Map<string, string>();
		await Promise.all(
			[...checks.entries()].map(async ([command, args]) => {
				versions.set(command, await commandVersion(command, args));
			}),
		);
		return versions;
	})();
	return toolchainCache;
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

		const versions = await detectToolchain();
		const support = {} as Record<Language, LanguageSupport>;
		const toolchains: NonNullable<CreateSessionResponse["toolchains"]> = {};
		const degraded: CreateSessionResponse["degraded"] = {};
		for (const pack of Object.values(LANGUAGE_PACKS)) {
			const runVersion = versions.get(pack.toolchain.run.command) ?? "unavailable";
			const lspVersion = pack.toolchain.lsp
				? (versions.get(pack.toolchain.lsp.command) ?? "unavailable")
				: "unavailable";
			const run = pack.toolchain.run.compatible(runVersion);
			const lsp = Boolean(
				run && pack.toolchain.lsp?.compatible(lspVersion),
			);
			support[pack.id] = {
				present: pack.scaffoldAlways || run,
				run,
				lsp,
			};
			toolchains[pack.id] = { run: runVersion, lsp: lspVersion };
			if (!run)
				degraded[pack.id] =
					`Expected ${pack.toolchain.run.expected}, detected ${runVersion}`;
			else if (pack.toolchain.lsp && !lsp)
				degraded[`${pack.id}-lsp`] =
					`${pack.toolchain.lsp.expected} unavailable (${lspVersion})`;
		}

		// Bilingual-by-extension workspace: scaffold and create the entry file
		// of every supported language; the preferred one becomes the first tab.
		const includedPacks = Object.values(LANGUAGE_PACKS).filter(
			(pack) => support[pack.id].present,
		);
		for (const pack of includedPacks) await pack.scaffold(root);
		const language: Language = includedPacks.some(
			(pack) => pack.id === preferred,
		)
			? preferred
			: "zig";
		const sources = new Map(
			includedPacks.map((pack) => [pack.entryFile, pack.defaultSource]),
		);
		for (const [entry, source] of sources) {
			await writeFile(join(sourceRoot, entry), source, {
				encoding: "utf8",
				mode: 0o600,
			});
			await writeFile(join(root, "generated", entry), source, {
				encoding: "utf8",
				mode: 0o600,
			});
		}
		const primaryEntry = LANGUAGE_PACKS[language].entryFile;
		const entryPaths = [
			primaryEntry,
			...includedPacks
				.map((pack) => pack.entryFile)
				.filter((entry) => entry !== primaryEntry),
		];
		const initialFiles = [...sources.entries()]
			.map(([path, source]) => ({
				path,
				uri: pathToFileURL(join(sourceRoot, path)).href,
				source,
			}))
			.sort((left, right) => left.path.localeCompare(right.path));
		const documentUri = pathToFileURL(join(sourceRoot, primaryEntry)).href;
		const initialSource =
			sources.get(primaryEntry) ?? LANGUAGE_PACKS.zig.defaultSource;
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
			support,
		};
		this.sessions.set(id, session);
		return {
			sessionId: id,
			authToken: token,
			language,
			documentUri,
			zigVersion: toolchains.zig?.run ?? "unavailable",
			zlsVersion: toolchains.zig?.lsp ?? "unavailable",
			rustcVersion: toolchains.rust?.run ?? "unavailable",
			cargoVersion: toolchains.rust?.run ?? "unavailable",
			rustAnalyzerVersion: toolchains.rust?.lsp ?? "unavailable",
			toolchains,
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
