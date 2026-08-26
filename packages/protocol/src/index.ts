import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_RUNTIME_MESSAGE_BYTES = MAX_SOURCE_BYTES + 64 * 1024;

export const runStates = [
	"idle",
	"debouncing",
	"instrumenting",
	"compiling",
	"running",
	"succeeded",
	"compile_error",
	"runtime_error",
	"timed_out",
	"cancelled",
] as const;
export type RunState = (typeof runStates)[number];

export interface SourceRange {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	startByte: number;
	endByte: number;
}

export interface ProbeDescriptor {
	probeId: string;
	name: string;
	supported: boolean;
	reason?: string;
	originalRange: SourceRange;
	insertionByte?: number;
	mode: "auto" | "manual";
}

export interface AppDiagnostic {
	message: string;
	severity: "error" | "warning" | "information" | "hint";
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	code?: string | number;
	source?: string;
}

export interface DocumentSnapshot {
	sessionId: string;
	version: number;
	uri: string;
	source: string;
	updatedAt: number;
}

export interface CreateSessionResponse {
	sessionId: string;
	authToken: string;
	documentUri: string;
	zigVersion: string;
	zlsVersion: string;
	initialSource: string;
	degraded: { zig?: string; zls?: string };
}

export interface ProbeValueEvent {
	protocolVersion: 1;
	type: "probe_value";
	kind: "probe_value";
	sessionId: string;
	runId: string;
	documentVersion: number;
	probeId: string;
	name: string;
	line: number;
	column: number;
	typeName: string;
	preview: string;
	truncated: boolean;
	sequence: number;
	timestamp: number;
	count: number;
}

export interface RunResult {
	instrumentationMs: number;
	compilationMs: number;
	executionMs: number;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	reason?: string;
}

const sessionId = z.string().regex(/^[a-f0-9]{32}$/);
const settings = z
	.object({
		autoRun: z.boolean(),
		autoInspect: z.boolean(),
		debounceMs: z.number().int().min(300).max(500),
		timeoutMs: z.number().int().min(100).max(10_000),
		manualProbeIds: z.array(z.string().min(1).max(128)).max(1000),
	})
	.strict();

export const runtimeClientMessageSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("document.update"),
			sessionId,
			version: z.number().int().positive(),
			source: z.string().max(MAX_SOURCE_BYTES),
		})
		.strict(),
	z
		.object({
			type: z.literal("run.request"),
			sessionId,
			version: z.number().int().positive(),
			reason: z.enum(["manual", "auto"]),
		})
		.strict(),
	z.object({ type: z.literal("run.cancel"), sessionId }).strict(),
	z
		.object({ type: z.literal("settings.update"), sessionId })
		.extend(settings.shape)
		.strict(),
]);
export type RuntimeClientMessage = z.infer<typeof runtimeClientMessageSchema>;

export type RuntimeServerEvent =
	| {
			type: "run.state";
			documentVersion: number;
			runId?: string;
			state: RunState;
	  }
	| {
			type: "probe.catalog";
			documentVersion: number;
			probes: ProbeDescriptor[];
	  }
	| ProbeValueEvent
	| {
			type: "output";
			documentVersion: number;
			runId: string;
			stream: "stdout" | "stderr";
			category: "program" | "error";
			chunk: string;
	  }
	| {
			type: "diagnostics";
			documentVersion: number;
			owner: string;
			diagnostics: AppDiagnostic[];
	  }
	| {
			type: "run.finished";
			documentVersion: number;
			runId: string;
			result: RunResult;
	  }
	| { type: "lsp.capabilities"; capabilities: Record<string, unknown> }
	| {
			type: "server.error";
			recoverable: boolean;
			message: string;
			details?: string;
	  };

export const defaultSource = `const std = @import("std");

pub fn main() void {
    const price: i32 = 40;
    const tax: i32 = 3;
    const total = price + tax;
    const values = [_]i32{ price, tax, total };

    _ = values;
}
`;
