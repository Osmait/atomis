import type { ProbeFieldLayout, ProbeValueEvent } from "@atomis/protocol";

export interface InlineValue {
	probeId: string;
	runId: string;
	name: string;
	line: number;
	column: number;
	typeName: string;
	preview: string;
	count: number;
	sequence: number;
	history: string[];
	bits?: number;
	sizeBytes?: number;
	alignBytes?: number;
	fields?: ProbeFieldLayout[];
}

export function acceptsVersion(
	activeVersion: number,
	eventVersion: number,
): boolean {
	return activeVersion === eventVersion;
}

export function updateInlineValue(
	previous: Map<string, InlineValue>,
	event: ProbeValueEvent,
): Map<string, InlineValue> {
	const next = new Map(previous);
	const old = previous.get(event.probeId);
	// The history captures loop iterations WITHIN one run; a value arriving
	// from a new run starts fresh, so re-running unchanged code does not
	// pile up identical entries.
	const sameRun = old !== undefined && old.runId === event.runId;
	next.set(event.probeId, {
		probeId: event.probeId,
		runId: event.runId,
		name: event.name,
		line: event.line,
		column: event.column,
		typeName: event.typeName,
		preview: event.preview,
		count: event.count,
		sequence: event.sequence,
		history: sameRun
			? [...(old?.history ?? []), event.preview].slice(-20)
			: [event.preview],
		...(event.bits !== undefined ? { bits: event.bits } : {}),
		...(event.sizeBytes !== undefined ? { sizeBytes: event.sizeBytes } : {}),
		...(event.alignBytes !== undefined
			? { alignBytes: event.alignBytes }
			: {}),
		...(event.fields !== undefined ? { fields: event.fields } : {}),
	});
	return next;
}

export function toggleProbe(ids: readonly string[], id: string): string[] {
	return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}
