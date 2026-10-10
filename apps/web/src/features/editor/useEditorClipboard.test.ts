// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type * as MonacoApi from "monaco-editor";
import { useEditorClipboard } from "./useEditorClipboard.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

function setup() {
	const node = document.createElement("div");
	document.body.append(node);
	const mainFocus = vi.fn();
	const previewFocus = vi.fn();
	const main = {
		getDomNode: () => node,
		focus: mainFocus,
	} as Partial<MonacoApi.editor.IStandaloneCodeEditor> as MonacoApi.editor.IStandaloneCodeEditor;
	const preview = {
		getDomNode: () => node,
		focus: previewFocus,
	} as Partial<MonacoApi.editor.ICodeEditor> as MonacoApi.editor.ICodeEditor;
	const writeText = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const setStatus = vi.fn();
	const setEditorContextMenu = vi.fn();
	const { result } = renderHook(() => useEditorClipboard({
		editorRef: { current: main }, setStatus, setEditorContextMenu,
	}));
	return { result, writeText, mainFocus, previewFocus, preview, node, setStatus, setEditorContextMenu };
}

it("copies the captured popup text without reading the underlying model", async () => {
	const { result, writeText, mainFocus, setEditorContextMenu } = setup();
	await result.current.copyFromEditor("selected error fragment");
	expect(writeText).toHaveBeenCalledWith("selected error fragment");
	expect(setEditorContextMenu).toHaveBeenCalledWith(undefined);
	expect(mainFocus).toHaveBeenCalledOnce();
});

it("restores focus to the source preview instead of the main editor", async () => {
	const { result, preview, mainFocus, previewFocus } = setup();
	await result.current.copyFromEditor("return", preview);
	expect(previewFocus).toHaveBeenCalledOnce();
	expect(mainFocus).not.toHaveBeenCalled();
});

it("does not refocus a preview closed while clipboard permission is pending", async () => {
	const { result, writeText, preview, node, mainFocus, previewFocus } = setup();
	let finishCopy!: () => void;
	const pending = new Promise<void>((resolve) => { finishCopy = resolve; });
	writeText.mockReturnValueOnce(pending);
	const copied = result.current.copyFromEditor("return", preview);
	node.remove();
	finishCopy();
	await copied;
	expect(previewFocus).not.toHaveBeenCalled();
	expect(mainFocus).not.toHaveBeenCalled();
});

it("reports clipboard permission failures", async () => {
	const { result, writeText, setStatus } = setup();
	writeText.mockRejectedValueOnce(new Error("Permission denied"));
	await result.current.copyFromEditor("error");
	expect(setStatus).toHaveBeenCalledWith("Copy failed: Permission denied");
});
