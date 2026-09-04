// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import type * as MonacoApi from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import { useEditorContextMenu } from "./useEditorContextMenu.js";

afterEach(() => {
	cleanup();
	window.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
});

function mockEditor(node: HTMLElement, text: string) {
	const model = {
		getValueInRange: () => text,
		getLineContent: (line: number) => `${text} line ${line}`,
	} as Partial<MonacoApi.editor.ITextModel> as MonacoApi.editor.ITextModel;
	const selection = {
		isEmpty: () => false,
		containsPosition: () => true,
		startLineNumber: 1,
	} as Partial<MonacoApi.Selection> as MonacoApi.Selection;
	return {
		getDomNode: () => node,
		getContainerDomNode: () => node.parentElement!,
		getModel: () => model,
		getSelection: () => selection,
		getTargetAtClientPoint: (): MonacoApi.editor.IMouseTarget => ({
			type: 0, element: node, mouseColumn: 1, range: null,
			position: { lineNumber: 2, column: 1 } as MonacoApi.Position,
		}),
	} as Partial<MonacoApi.editor.IStandaloneCodeEditor> as MonacoApi.editor.IStandaloneCodeEditor;
}

function setup() {
	document.body.innerHTML = `<div class="editor-wrap"><div class="host">
		<div class="monaco-editor"><div class="main-line">main code</div>
		<div class="reference-zone-widget"><div class="preview">
		<div class="monaco-editor"><div class="preview-line">preview code</div></div>
		</div><div class="ref-tree"><div class="monaco-list-row">reference result</div></div></div>
		<div class="marker-widget"><div class="message">unknown name</div></div>
		</div></div></div>`;
	const root = document.querySelector(".monaco-editor") as HTMLElement;
	const nested = root.querySelector(".monaco-editor") as HTMLElement;
	const main = mockEditor(root, "MAIN SELECTION");
	const preview = mockEditor(nested, "PREVIEW SELECTION");
	const editorRef = { current: main };
	const setEditorContextMenu = vi.fn();
	const editors = [main, preview];
	renderHook(() => useEditorContextMenu({
		editorRef,
		monacoRef: { current: { editor: { getEditors: () => editors } as Monaco["editor"] } as Monaco },
		setEditorContextMenu,
	}));
	return { main, preview, editorRef, setEditorContextMenu, editors };
}

describe("editor context menu routing", () => {
	it("snapshots the preview selection without replacing the main editor ref", () => {
		const { main, preview, editorRef, setEditorContextMenu } = setup();
		fireEvent.contextMenu(document.querySelector(".preview-line")!);
		expect(setEditorContextMenu).toHaveBeenCalledWith(expect.objectContaining({
			copyLabel: "Copy reference", copyText: "PREVIEW SELECTION", allowPaste: false,
		}));
		expect(editorRef.current).toBe(main);
		expect(editorRef.current).not.toBe(preview);
	});

	it.each([
		[".marker-widget .message", "unknown name", "Copy diagnostic"],
		[".ref-tree .monaco-list-row", "reference result", "Copy reference"],
	])("copies %s instead of the main code selection", (selector, copyText, copyLabel) => {
		const { setEditorContextMenu } = setup();
		fireEvent.contextMenu(document.querySelector(selector)!);
		expect(setEditorContextMenu).toHaveBeenCalledWith(expect.objectContaining({ copyText, copyLabel, allowPaste: false }));
	});

	it("gives a diagnostic inside a preview priority over the preview code", () => {
		const { setEditorContextMenu } = setup();
		const widget = document.createElement("div");
		widget.className = "monaco-hover";
		widget.textContent = "preview documentation";
		document.querySelector(".preview .monaco-editor")!.append(widget);
		fireEvent.contextMenu(widget);
		expect(setEditorContextMenu).toHaveBeenCalledWith(expect.objectContaining({ copyText: "preview documentation", copyLabel: "Copy hover" }));
	});

	it("does not fall back to the main editor when the preview is unavailable", () => {
		const { editors, setEditorContextMenu } = setup();
		editors.pop();
		fireEvent.contextMenu(document.querySelector(".preview-line")!);
		expect(setEditorContextMenu).not.toHaveBeenCalled();
	});
});
