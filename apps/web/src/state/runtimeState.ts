import type { ProbeValueEvent } from "@ziglive/protocol";

export interface InlineValue {
	probeId: string;
	name: string;
	line: number;
	column: number;
	typeName: string;
	preview: string;
	count: number;
	history: string[];
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
		history: [...(old?.history ?? []), event.preview].slice(-20),
	});
	return next;
}

export function toggleProbe(ids: readonly string[], id: string): string[] {
	return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}
