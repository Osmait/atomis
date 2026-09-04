// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	getContextualEditorCopy,
	getEditorCopyText,
	getMonacoEditorTarget,
	isNestedMonacoEditor,
} from "./editorContextMenu.js";
import type * as MonacoApi from "monaco-editor";

afterEach(() => {
	document.body.replaceChildren();
	window.getSelection()?.removeAllRanges();
});

describe("getContextualEditorCopy", () => {
	it.each([
		["inline-value", "40\u00A0:\u00A0i32", "Copy value", "40 : i32"],
		["inline-log", "tick 3 ×4", "Copy log", "tick 3 ×4"],
		[
			"error-lens-message",
			"× use of undeclared identifier 'missing_name'",
			"Copy diagnostic",
			"× use of undeclared identifier 'missing_name'",
		],
		["test-lens-message", "× expected 2, got 3", "Copy test result", "× expected 2, got 3"],
		["marker-widget", "unknown name", "Copy diagnostic", "unknown name"],
		["parameter-hints-widget", "apply_tax(price: int)", "Copy signature", "apply_tax(price: int)"],
	])("copies visible %s text", (className, content, label, text) => {
		const widget = document.createElement("span");
		widget.className = className;
		widget.textContent = content;
		const child = document.createElement("strong");
		widget.append(child);
		document.body.append(widget);
		expect(getContextualEditorCopy(child, null)).toEqual({ label, text });
	});

	it("copies only the selected part of a hover when there is a selection", () => {
		const hover = document.createElement("div");
		hover.className = "monaco-hover";
		hover.textContent = "function apply_tax(price: int)";
		document.body.append(hover);
		const range = document.createRange();
		range.setStart(hover.firstChild as Text, 9);
		range.setEnd(hover.firstChild as Text, 18);
		const selection = window.getSelection();
		selection?.addRange(range);
		expect(getContextualEditorCopy(hover, selection)).toEqual({
			label: "Copy hover",
			text: "apply_tax",
		});
	});

	it.each(["marker-widget", "monaco-hover", "parameter-hints-widget"])("preserves a selected fragment of %s", (className) => {
		const widget = document.createElement("div");
		widget.className = className;
		widget.textContent = "unknown missing_name here";
		document.body.append(widget);
		const range = document.createRange();
		range.setStart(widget.firstChild!, 8);
		range.setEnd(widget.firstChild!, 20);
		window.getSelection()?.addRange(range);
		expect(getContextualEditorCopy(widget)?.text).toBe("missing_name");
	});

	it("does not copy an unrelated DOM selection", () => {
		document.body.innerHTML = '<div class="marker-widget">actual error</div><span>unrelated</span>';
		const range = document.createRange();
		range.selectNodeContents(document.querySelector("span")!);
		window.getSelection()?.addRange(range);
		expect(getContextualEditorCopy(document.querySelector(".marker-widget"))?.text).toBe("actual error");
	});
});

function editor(empty: boolean) {
	const model = {
		getValueInRange: () => "selected code",
		getLineContent: (line: number) => `line ${line}`,
	} as Partial<MonacoApi.editor.ITextModel> as MonacoApi.editor.ITextModel;
	const selection = {
		isEmpty: () => empty,
		containsPosition: (position: MonacoApi.IPosition) => position.lineNumber === 3,
		startLineNumber: 3,
	} as MonacoApi.Selection;
	return {
		getModel: () => model,
		getSelection: () => selection,
	} as MonacoApi.editor.ICodeEditor;
}

describe("getEditorCopyText", () => {
	const selected = { lineNumber: 3, column: 5 };
	const outside = { lineNumber: 8, column: 1 };
	it("copies a selection when right-clicked inside it", () => {
		expect(getEditorCopyText(editor(false), selected)).toBe("selected code");
	});
	it("copies the clicked line outside a selection", () => {
		expect(getEditorCopyText(editor(false), outside)).toBe("line 8");
	});
	it("copies the clicked line without a selection", () => {
		expect(getEditorCopyText(editor(true), outside)).toBe("line 8");
	});
	it("uses the current selection for a keyboard context menu without a hit target", () => {
		expect(getEditorCopyText(editor(false))).toBe("selected code");
		expect(getEditorCopyText(editor(true))).toBe("line 3");
	});
	it("does not copy from a disposed model", () => {
		const disposed = editor(false);
		disposed.getModel = () => null;
		expect(getEditorCopyText(disposed)).toBeUndefined();
	});
});

describe("isNestedMonacoEditor", () => {
	it("distinguishes a reference preview from the root editor", () => {
		const root = document.createElement("div");
		root.className = "monaco-editor";
		const rootContent = document.createElement("span");
		const preview = document.createElement("div");
		preview.className = "monaco-editor";
		const previewContent = document.createElement("span");
		root.append(rootContent, preview);
		preview.append(previewContent);
		expect(isNestedMonacoEditor(rootContent)).toBe(false);
		expect(isNestedMonacoEditor(previewContent)).toBe(true);
		expect(getMonacoEditorTarget(previewContent)).toBe(preview);
	});
});
