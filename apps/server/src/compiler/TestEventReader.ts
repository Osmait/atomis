export interface RawTestStart {
	kind: "test_start";
	index: number;
	name: string;
}

export interface RawTestResult {
	kind: "test_result";
	index: number;
	name: string;
	status: "passed" | "failed" | "skipped" | "leaked";
	durationNs: number;
	error?: string;
}

export interface RawTestSummary {
	kind: "test_summary";
	passed: number;
	failed: number;
	skipped: number;
	leaked: number;
}

export type RawTestEvent = RawTestStart | RawTestResult | RawTestSummary;

const STATUSES = new Set(["passed", "failed", "skipped", "leaked"]);

export class TestEventReader {
	private buffer = "";
	private events = 0;

	public constructor(
		private readonly onEvent: (event: RawTestEvent) => void,
		private readonly maxEvents = 10_000,
	) {}

	public push(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length > 64 * 1024) throw new Error("Test event exceeds 64 KiB");
			if (line) this.parse(line);
			newline = this.buffer.indexOf("\n");
		}
		if (this.buffer.length > 64 * 1024)
			throw new Error("Test event exceeds 64 KiB");
	}

	private parse(line: string): void {
		if (++this.events > this.maxEvents)
			throw new Error("Test event count exceeds run limit");
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch (error) {
			throw new Error(
				`Invalid test JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!value || typeof value !== "object")
			throw new Error("Test event is not an object");
		const event = value as Partial<RawTestEvent> & {
			protocolVersion?: number;
		};
		if (event.protocolVersion !== 1) throw new Error("Invalid test event");
		if (event.kind === "test_summary") {
			const summary = event as Partial<RawTestSummary>;
			if (
				typeof summary.passed !== "number" ||
				typeof summary.failed !== "number" ||
				typeof summary.skipped !== "number" ||
				typeof summary.leaked !== "number"
			)
				throw new Error("Invalid test summary schema");
			this.onEvent(summary as RawTestSummary);
			return;
		}
		if (event.kind === "test_start") {
			const start = event as Partial<RawTestStart>;
			if (typeof start.index !== "number" || typeof start.name !== "string")
				throw new Error("Invalid test start schema");
			this.onEvent(start as RawTestStart);
			return;
		}
		if (event.kind === "test_result") {
			const result = event as Partial<RawTestResult>;
			if (
				typeof result.index !== "number" ||
				typeof result.name !== "string" ||
				typeof result.durationNs !== "number" ||
				typeof result.status !== "string" ||
				!STATUSES.has(result.status)
			)
				throw new Error("Invalid test result schema");
			this.onEvent(result as RawTestResult);
			return;
		}
		throw new Error("Unknown test event kind");
	}

	public end(): void {
		if (this.buffer.trim())
			throw new Error("Test channel ended with partial NDJSON");
	}
}
