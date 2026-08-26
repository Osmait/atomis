import { randomBytes, timingSafeEqual } from "node:crypto";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CreateSessionResponse, ProbeDescriptor } from "@ziglive/protocol";
import { defaultSource } from "@ziglive/protocol";
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

export interface Session {
	id: string;
	token: string;
	root: string;
	documentUri: string;
	store: DocumentStore;
	settings: SessionSettings;
	probes: ProbeDescriptor[];
	runtimeConnections: number;
	lspConnections: number;
	zigCompatible: boolean;
	zlsCompatible: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../../../..");
const SESSION_ROOT = join(tmpdir(), "ziglive");
const SESSION_ID = /^[a-f0-9]{32}$/;

async function commandVersion(command: "zig" | "zls"): Promise<string> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolveVersion) => {
		const child = spawn(
			command,
			[command === "zig" ? "version" : "--version"],
			{ shell: false, stdio: ["ignore", "pipe", "ignore"] },
		);
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", () => resolveVersion("unavailable"));
		child.once("close", (code) =>
			resolveVersion(code === 0 ? output.trim() : "unavailable"),
		);
	});
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

	public async create(): Promise<ProjectSessionResponse> {
		const id = randomBytes(16).toString("hex");
		const token = randomBytes(32).toString("base64url");
		const root = join(SESSION_ROOT, id);
		const sourceRoot = join(root, "src");
		const sourcePath = join(sourceRoot, "main.zig");
		await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
		await mkdir(join(root, "generated"), { recursive: true, mode: 0o700 });
		await mkdir(join(root, ".zig-cache"), { recursive: true, mode: 0o700 });
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
		await writeFile(sourcePath, defaultSource, {
			encoding: "utf8",
			mode: 0o600,
		});
		await writeFile(join(root, "generated/main.zig"), defaultSource, {
			encoding: "utf8",
			mode: 0o600,
		});
		const documentUri = pathToFileURL(sourcePath).href;
		const initialFiles = [
			{ path: "main.zig", uri: documentUri, source: defaultSource },
		];
		const [zigVersion, zlsVersion] = await Promise.all([
			commandVersion("zig"),
			commandVersion("zls"),
		]);
		const zigCompatible = /^0\.16\./.test(zigVersion);
		const zlsCompatible = /^0\.16\./.test(zlsVersion);
		const initialSnapshot: ProjectDocumentSnapshot = {
			sessionId: id,
			version: 1,
			uri: documentUri,
			source: defaultSource,
			files: initialFiles,
			updatedAt: Date.now(),
		};
		const session: Session = {
			id,
			token,
			root,
			documentUri,
			store: new DocumentStore(initialSnapshot, sourceRoot),
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
			zigCompatible,
			zlsCompatible,
		};
		this.sessions.set(id, session);
		const degraded: CreateSessionResponse["degraded"] = {};
		if (!zigCompatible)
			degraded.zig = `Expected Zig 0.16.x, detected ${zigVersion}`;
		if (!zlsCompatible)
			degraded.zls = `Expected ZLS 0.16.x, detected ${zlsVersion}`;
		return {
			sessionId: id,
			authToken: token,
			documentUri,
			zigVersion,
			zlsVersion,
			initialSource: defaultSource,
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

	public instrumenterPath(): string {
		return join(PROJECT_ROOT, "zig-out", "bin", "runzig-instrument");
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
