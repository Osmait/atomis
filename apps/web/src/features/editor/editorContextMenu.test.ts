// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	getContextualEditorCopy,
	getMonacoEditorTarget,
	isNestedMonacoEditor,
} from "./editorContextMenu.js";

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
