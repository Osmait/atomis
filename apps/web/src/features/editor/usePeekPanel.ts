import { useEffect, useState } from "react";
import type * as MonacoApi from "monaco-editor";
import type { InlineValue } from "../../shared/lib/runtimeState.js";

interface PeekPanelOptions {
	editorRef: React.RefObject<
		MonacoApi.editor.IStandaloneCodeEditor | undefined
	>;
	valuesRef: React.RefObject<Map<string, InlineValue>>;
	values: Map<string, InlineValue>;
	stale: boolean;
	activePath: string;
}

export interface PeekState {
	peek: { path: string; probeId: string } | null;
	setPeek: React.Dispatch<
		React.SetStateAction<{ path: string; probeId: string } | null>
	>;
	peekOverride: bigint | undefined;
	setPeekOverride: React.Dispatch<React.SetStateAction<bigint | undefined>>;
	peekNode: HTMLDivElement | null;
}

/**
 * The low-level peek panel's anchor: a Monaco view zone under the probed
 * line plus an overlay node the panel portals into, resized to fit and torn
 * down when the probe disappears or the buffer goes stale.
 */
export function usePeekPanel(options: PeekPanelOptions): PeekState {
	const { editorRef, valuesRef, values, stale, activePath } = options;
	const [peek, setPeek] = useState<{ path: string; probeId: string } | null>(
		null,
	);
	const [peekOverride, setPeekOverride] = useState<bigint | undefined>(
		undefined,
	);
	const [peekNode, setPeekNode] = useState<HTMLDivElement | null>(null);

	useEffect(() => {
		setPeekOverride(undefined);
		const editor = editorRef.current;
		if (!editor || !peek || peek.path !== activePath) {
			setPeekNode(null);
			return;
		}
		const value = valuesRef.current.get(peek.probeId);
		const model = editor.getModel();
		if (!value || !model || value.line > model.getLineCount()) {
			setPeekNode(null);
			return;
		}
		const overlayNode = document.createElement("div");
		overlayNode.className = "peek-overlay";
		let zoneId = "";
		const zone = {
			afterLineNumber: value.line,
			heightInPx: 120,
			domNode: document.createElement("div"),
			onDomNodeTop: (top: number) => {
				overlayNode.style.top = `${top}px`;
			},
		};
		editor.changeViewZones((accessor) => {
			zoneId = accessor.addZone(zone);
		});
		const layoutOverlay = (): void => {
			const layout = editor.getLayoutInfo();
			overlayNode.style.left = `${layout.contentLeft}px`;
			overlayNode.style.width = `${Math.max(280, layout.contentWidth - 30)}px`;
		};
		layoutOverlay();
		const overlay = {
			getId: () => "atomis.peek",
			getDomNode: () => overlayNode,
			getPosition: () => null,
		};
		editor.addOverlayWidget(overlay);
		const layoutListener = editor.onDidLayoutChange(layoutOverlay);
		const observer = new ResizeObserver(() => {
			const height = overlayNode.scrollHeight;
			if (height > 0 && height + 10 !== zone.heightInPx) {
				zone.heightInPx = height + 10;
				editor.changeViewZones((accessor) => accessor.layoutZone(zoneId));
			}
		});
		observer.observe(overlayNode);
		setPeekNode(overlayNode);
		editor.revealLineInCenterIfOutsideViewport(value.line);
		return () => {
			observer.disconnect();
			layoutListener.dispose();
			editor.removeOverlayWidget(overlay);
			editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
			setPeekNode(null);
		};
	}, [peek, activePath, editorRef, valuesRef]);

	// The peek follows the run: close it when its probe stops reporting or
	// the buffer goes stale (lines may have shifted under the zone).
	useEffect(() => {
		if (peek && (stale || !values.has(peek.probeId))) setPeek(null);
	}, [peek, stale, values]);

	return { peek, setPeek, peekOverride, setPeekOverride, peekNode };
}
