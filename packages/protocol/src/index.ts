import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const languages = ["zig", "rust", "go"] as const;
export type Language = (typeof languages)[number];

export function entryFileFor(language: Language): string {
	if (language === "rust") return "main.rs";
	if (language === "go") return "main.go";
	return "main.zig";
}
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_PROJECT_FILES = 64;
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
export const MAX_RUNTIME_MESSAGE_BYTES = MAX_SOURCE_BYTES + 64 * 1024;

export const runStates = [
	"idle",
	"debouncing",
	"instrumenting",
	"compiling",
	"running",
	"testing",
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
	path?: string;
	name: string;
	supported: boolean;
	reason?: string;
	originalRange: SourceRange;
	insertionByte?: number;
	mode: "auto" | "manual";
}

export interface TestCase {
	testId: string;
	path: string;
	name: string;
	line: number;
	column: number;
}

export const testStatuses = [
	"passed",
	"failed",
	"skipped",
	"leaked",
	"timed_out",
] as const;
export type TestStatus = (typeof testStatuses)[number];

export interface TestResultEvent {
	type: "test.result";
	documentVersion: number;
	runId: string;
	testId?: string;
	name: string;
	status: TestStatus;
	durationMs: number;
	message?: string;
}

export interface TestSummaryEvent {
	type: "test.summary";
	documentVersion: number;
	runId: string;
	passed: number;
	failed: number;
	skipped: number;
	leaked: number;
	durationMs: number;
}

export interface AppDiagnostic {
	message: string;
	path?: string;
	severity: "error" | "warning" | "information" | "hint";
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	code?: string | number;
	source?: string;
}

export interface ProjectFile {
	path: string;
	uri: string;
	source: string;
}

export interface DocumentSnapshot {
	sessionId: string;
	version: number;
	uri: string;
	source: string;
	files: ProjectFile[];
	updatedAt: number;
}

export interface CreateSessionResponse {
	sessionId: string;
	authToken: string;
	language: Language;
	documentUri: string;
	zigVersion: string;
	zlsVersion: string;
	rustcVersion?: string;
	cargoVersion?: string;
	rustAnalyzerVersion?: string;
	toolchains?: Partial<Record<Language, { run: string; lsp: string }>>;
	initialSource: string;
	files: ProjectFile[];
	degraded: Partial<Record<string, string>>;
}

export const createSessionRequestSchema = z
	.object({ language: z.enum(languages).default("zig") })
	.strict();

export interface ProbeValueEvent {
	protocolVersion: 1;
	type: "probe_value";
	kind: "probe_value";
	sessionId: string;
	runId: string;
	documentVersion: number;
	probeId: string;
	path?: string;
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

export interface LogSourceLocation {
	path?: string;
	line: number;
	column: number;
	executionIndex: number;
	loop?: {
		line: number;
		column: number;
		variable: string;
		value: string;
	};
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
export const projectPathSchema = z
	.string()
	.min(1)
	.max(240)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.includes("\\") &&
			!/[\u0000-\u001f]/.test(value) &&
			value
				.split("/")
				.every((part) => part.length > 0 && part !== "." && part !== ".."),
		"Invalid project-relative path",
	);
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
			path: projectPathSchema.default("main.zig"),
			source: z.string().max(MAX_SOURCE_BYTES),
		})
		.strict(),
	z
		.object({
			type: z.literal("file.create"),
			sessionId,
			version: z.number().int().positive(),
			path: projectPathSchema,
			source: z.string().max(MAX_SOURCE_BYTES),
		})
		.strict(),
	z
		.object({
			type: z.literal("file.rename"),
			sessionId,
			version: z.number().int().positive(),
			path: projectPathSchema,
			newPath: projectPathSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("file.delete"),
			sessionId,
			version: z.number().int().positive(),
			path: projectPathSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("run.request"),
			sessionId,
			version: z.number().int().positive(),
			reason: z.enum(["manual", "auto"]),
			language: z.enum(languages).optional(),
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
			type: "project.files";
			documentVersion: number;
			files: ProjectFile[];
	  }
	| {
			type: "probe.catalog";
			documentVersion: number;
			probes: ProbeDescriptor[];
	  }
	| {
			type: "test.catalog";
			documentVersion: number;
			tests: TestCase[];
	  }
	| TestResultEvent
	| TestSummaryEvent
	| ProbeValueEvent
	| {
			type: "output";
			documentVersion: number;
			runId: string;
			stream: "stdout" | "stderr";
			category: "program" | "error";
			chunk: string;
			sourceLocation?: LogSourceLocation;
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

export const defaultGoSource = `package main

import "fmt"

func main() {
	price := 40
	tax := 3
	total := applyTax(price, tax)
	values := []int{price, tax, total}

	fmt.Println("total:", values[2])
}

func applyTax(price int, tax int) int {
	return price + tax
}
`;

export const defaultGoTestSource = `package main

import "testing"

// Las funciones TestXxx corren tras main(): mira el panel de tests →
func TestApplyTaxSumaElImpuesto(t *testing.T) {
	if applyTax(40, 3) != 43 {
		t.Fatalf("esperado 43, recibido %d", applyTax(40, 3))
	}
}

func TestApplyTaxConTasaCero(t *testing.T) {
	if applyTax(40, 0) != 40 {
		t.Fatalf("esperado 40, recibido %d", applyTax(40, 0))
	}
}
`;

export const defaultRustSource = `fn main() {
    let price: i32 = 40;
    let tax: i32 = 3;
    let total = apply_tax(price, tax);
    let values = [price, tax, total];

    let _ = values;
}

fn apply_tax(price: i32, tax: i32) -> i32 {
    price + tax
}

// Los bloques #[test] corren tras main(): mira el panel de tests →
#[test]
fn apply_tax_suma_el_impuesto() {
    assert_eq!(43, apply_tax(40, 3));
}

#[test]
fn apply_tax_con_tasa_cero() {
    assert_eq!(40, apply_tax(40, 0));
}
`;

export const defaultSource = `const std = @import("std");

pub fn main() void {
    const price: i32 = 40;
    const tax: i32 = 3;
    const total = price + tax;
    const values = [_]i32{ price, tax, total };

    _ = values;
}

fn applyTax(price: i32, tax: i32) i32 {
    return price + tax;
}

// Los bloques test se ejecutan tras main(): mira el panel de tests →
test "applyTax suma el impuesto" {
    try std.testing.expectEqual(@as(i32, 43), applyTax(40, 3));
}

test "applyTax con tasa cero" {
    try std.testing.expectEqual(@as(i32, 40), applyTax(40, 0));
}
`;
