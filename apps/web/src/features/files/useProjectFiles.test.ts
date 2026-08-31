// @vitest-environment jsdom
// The file operations' local half: what must be validated BEFORE the
// optimistic apply, and what state a delete leaves behind.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
	MAX_PROJECT_FILES,
	type CreateSessionResponse,
} from "@atomis/protocol";
import { useProjectFiles } from "./useProjectFiles.js";
import type { ProjectFile } from "../../shared/types.js";

function mount(initialFiles: ProjectFile[]) {
	const session = {
		sessionId: "s".repeat(32),
		documentUri: "file:///ws/src/main.zig",
	} as object as CreateSessionResponse;
	const filesRef = { current: initialFiles };
	const sent: { type?: string }[] = [];
	const statuses: string[] = [];
	const pruned: string[] = [];
	const rendered = renderHook(() =>
		useProjectFiles({
			session,
			sendRuntime: (message) => sent.push(message as { type?: string }),
			versionRef: { current: 1 },
			entryRef: { current: "main.zig" },
			activeLanguageRef: { current: "zig" },
			filesRef,
			setProjectFiles: (next) => {
				filesRef.current =
					typeof next === "function" ? next(filesRef.current) : next;
			},
			lspClientsRef: { current: {} },
			monacoRef: { current: undefined },
			openInLsp: () => undefined,
			pinnedLogLocationRef: { current: undefined },
			logSourceDecorationsRef: { current: undefined },
			setStatus: (status) => statuses.push(status),
			pruneDiagnosticsFor: (path) => pruned.push(path),
		}),
	);
	return { rendered, filesRef, sent, statuses, pruned };
}

const file = (path: string): ProjectFile => ({
	path,
	uri: `file:///ws/src/${path}`,
	source: "",
});

afterEach(() => vi.unstubAllGlobals());

describe("useProjectFiles", () => {
	it("deleting the active file re-adds the entry's tab when it was closed", () => {
		vi.stubGlobal("confirm", () => true);
		const { rendered, pruned } = mount([file("main.zig"), file("extra.zig")]);
		act(() => rendered.result.current.selectFile("extra.zig"));
		// The entry's own tab goes away…
		act(() => rendered.result.current.closeTab("main.zig"));
		expect(rendered.result.current.openTabs).toEqual(["extra.zig"]);
		// …then the active file is deleted: the fallback to the entry must
		// bring its tab back, or the tab strip would be empty around an
		// active file.
		act(() => rendered.result.current.deleteFile("extra.zig"));
		expect(rendered.result.current.activePath).toBe("main.zig");
		expect(rendered.result.current.openTabs).toEqual(["main.zig"]);
		// And the deleted file's diagnostics were pruned at operation time.
		expect(pruned).toEqual(["extra.zig"]);
	});

	it("refuses to create past the server's file cap, before the optimistic apply", () => {
		const many = Array.from({ length: MAX_PROJECT_FILES }, (_, index) =>
			file(`f${index}.zig`),
		);
		const { rendered, filesRef, sent, statuses } = mount(many);
		let created = true;
		act(() => {
			created = rendered.result.current.createFileNamed("uno-mas.zig");
		});
		expect(created).toBe(false);
		expect(statuses.at(-1)).toContain(`${MAX_PROJECT_FILES}`);
		expect(filesRef.current).toHaveLength(MAX_PROJECT_FILES);
		expect(sent.some((message) => message.type === "file.create")).toBe(false);
	});

	it("refuses an invalid path with the reason, before the optimistic apply", () => {
		const { rendered, filesRef, sent, statuses } = mount([file("main.zig")]);
		let created = true;
		act(() => {
			created = rendered.result.current.createFileNamed("bad#name.zig");
		});
		expect(created).toBe(false);
		expect(statuses.at(-1)).toBe("Invalid file path");
		expect(filesRef.current).toHaveLength(1);
		expect(sent).toHaveLength(0);
	});
});
