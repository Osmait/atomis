import type { ProbeFieldLayout, ProbeValueEvent } from "@ziglive/protocol";

export interface InlineValue {
	probeId: string;
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
	next.set(event.probeId, {
		probeId: event.probeId,
		name: event.name,
		line: event.line,
		column: event.column,
		typeName: event.typeName,
		preview: event.preview,
		count: event.count,
		sequence: event.sequence,
		history: [...(old?.history ?? []), event.preview].slice(-20),
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
