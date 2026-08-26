interface RawProbeField {
	name: string;
	typeName: string;
	offset: number;
	size: number;
	preview: string;
}

interface RawProbeEvent {
	protocolVersion: 1;
	kind: "probe_value";
	probeId: string;
	name: string;
	line: number;
	column: number;
	typeName: string;
	preview: string;
	truncated: boolean;
	sequence: number;
	bits?: number;
	sizeBytes?: number;
	alignBytes?: number;
	fields?: RawProbeField[];
}

function validField(value: unknown): value is RawProbeField {
	if (!value || typeof value !== "object") return false;
	const field = value as Partial<RawProbeField>;
	return (
		typeof field.name === "string" &&
		typeof field.typeName === "string" &&
		typeof field.offset === "number" &&
		typeof field.size === "number" &&
		typeof field.preview === "string"
	);
}

export class ProbeEventReader {
	private buffer = "";
	private events = 0;

	public constructor(
		private readonly onEvent: (event: RawProbeEvent) => void,
		private readonly maxEvents = 10_000,
	) {}

	public push(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length > 64 * 1024)
				throw new Error("Probe event exceeds 64 KiB");
			if (line) this.parse(line);
			newline = this.buffer.indexOf("\n");
		}
		if (this.buffer.length > 64 * 1024)
			throw new Error("Probe event exceeds 64 KiB");
	}

	private parse(line: string): void {
		if (++this.events > this.maxEvents)
			throw new Error("Probe event count exceeds run limit");
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch (error) {
			throw new Error(
				`Invalid probe JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!value || typeof value !== "object")
			throw new Error("Probe event is not an object");
		const event = value as Partial<RawProbeEvent>;
		if (
			event.protocolVersion !== 1 ||
			event.kind !== "probe_value" ||
			typeof event.probeId !== "string" ||
			typeof event.name !== "string" ||
			typeof event.line !== "number" ||
			typeof event.column !== "number" ||
			typeof event.typeName !== "string" ||
			typeof event.preview !== "string" ||
			typeof event.truncated !== "boolean" ||
			typeof event.sequence !== "number"
		)
			throw new Error("Invalid probe event schema");
		for (const key of ["bits", "sizeBytes", "alignBytes"] as const)
			if (event[key] !== undefined && typeof event[key] !== "number")
				throw new Error("Invalid probe event schema");
		if (
			event.fields !== undefined &&
			!(Array.isArray(event.fields) && event.fields.every(validField))
		)
			throw new Error("Invalid probe event schema");
		this.onEvent(event as RawProbeEvent);
	}

	public end(): void {
		if (this.buffer.trim())
			throw new Error("Probe channel ended with partial NDJSON");
	}
}
