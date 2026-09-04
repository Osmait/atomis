import { useCallback } from "react";
import type { OnMount } from "@monaco-editor/react";
import type * as MonacoApi from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import type { CreateSessionResponse, ProbeDescriptor } from "@atomis/protocol";
import type { ProjectFile } from "../../shared/types.js";
import type { Settings } from "../../shared/stores/settings.js";
import { toggleProbe } from "../../shared/lib/runtimeState.js";
import { installVimExtensions } from "./vimExtensions.js";

/** What the editor needs on the way up, and who to tell once it is. */
export interface EditorMountDeps {
	session: CreateSessionResponse | undefined;
	editorRef: React.RefObject<MonacoApi.editor.IStandaloneCodeEditor | undefined>;
	monacoRef: React.RefObject<Monaco | undefined>;
	entryRef: React.RefObject<string>;
	activePathRef: React.RefObject<string>;
	catalogRef: React.RefObject<ProbeDescriptor[]>;
	settingsRef: React.RefObject<Settings>;
	decorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	errorLensDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	logSourceDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	testLensDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	inlineLogDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	setProjectFiles: (update: (previous: ProjectFile[]) => ProjectFile[]) => void;
	setCursorPosition: (position: { line: number; column: number }) => void;
	setPeek: (
		update: (
			previous: { path: string; probeId: string } | null | undefined,
		) => { path: string; probeId: string } | null,
	) => void;
	setFocusZone: (zone: "editor") => void;
	openInLsp: (path: string, model: MonacoApi.editor.ITextModel) => void;
	setupVimKeys: (runRef: React.RefObject<() => void>) => void;
	attachVim: () => void;
	/**
	 * `run` and `sendSettings` come as refs, not functions: the shell
	 * rebuilds both per session (they embed the sessionId), but the mouse
	 * and key handlers below register once per editor. A handler that closed
	 * over the first session's pair kept sending the old sessionId after a
	 * workspace switch — which the server answers by closing the socket.
	 */
	sendSettingsRef: React.RefObject<(next: Settings) => void>;
	runRef: React.RefObject<() => void>;
}

/**
 * Everything that happens the moment Monaco exists: collections to draw on,
 * the caret, the keys, the context menu, vim, and the click targets that turn
 * a gutter into a probe. It runs once per editor and reads the world through
 * refs, which is why it lives away from the component that owns them.
 */
export function useEditorMount({
	session,
	editorRef,
	monacoRef,
	entryRef,
	activePathRef,
	catalogRef,
	settingsRef,
	decorationsRef,
	errorLensDecorationsRef,
	logSourceDecorationsRef,
	testLensDecorationsRef,
	inlineLogDecorationsRef,
	setProjectFiles,
	setCursorPosition,
	setPeek,
	setFocusZone,
	openInLsp,
	setupVimKeys,
	attachVim,
	sendSettingsRef,
	runRef,
}: EditorMountDeps): OnMount {
	return useCallback<OnMount>(
	(editor, monaco) => {
		if (!session) return;
		editorRef.current = editor;
		monacoRef.current = monaco;
		const model = editor.getModel();
		if (!model) return;
		// Monaco owns the buffer now; take its value as the truth for the
		// entry file. This used to write the ref alone, leaving the state
		// the editor renders from behind it.
		setProjectFiles((previous) =>
			previous.map((file) =>
				file.path === entryRef.current
					? { ...file, source: model.getValue() }
					: file,
			),
		);
		decorationsRef.current = editor.createDecorationsCollection();
		errorLensDecorationsRef.current = editor.createDecorationsCollection();
		logSourceDecorationsRef.current = editor.createDecorationsCollection();
		testLensDecorationsRef.current = editor.createDecorationsCollection();
		inlineLogDecorationsRef.current = editor.createDecorationsCollection();
		setCursorPosition({
			line: editor.getPosition()?.lineNumber ?? 1,
			column: editor.getPosition()?.column ?? 1,
		});
		editor.onDidChangeCursorPosition(({ position: nextPosition }) =>
			setCursorPosition({
				line: nextPosition.lineNumber,
				column: nextPosition.column,
			}),
		);

		openInLsp(activePathRef.current, model);

		editor.onKeyDown((event) => {
			if (
				(event.ctrlKey || event.metaKey) &&
				event.keyCode === monaco.KeyCode.Enter
			) {
				event.preventDefault();
				event.stopPropagation();
				runRef.current();
			}
		});
		setupVimKeys(runRef);
		installVimExtensions();
		attachVim();
		editor.onDidFocusEditorText(() => setFocusZone("editor"));
		editor.onMouseDown((mouse) => {
			const element = mouse.target.element as HTMLElement | null;
			if (
				mouse.event.leftButton &&
				element?.classList?.contains("inline-value") &&
				mouse.target.position
			) {
				const line = mouse.target.position.lineNumber;
				const clicked = catalogRef.current.find(
					(candidate) =>
						candidate.supported &&
						candidate.originalRange.startLine === line &&
						((candidate as ProbeDescriptor & { path?: string }).path ??
							`src/${entryRef.current}`) ===
							`src/${activePathRef.current}`,
				);
				if (clicked) {
					setPeek((previous) =>
						previous?.probeId === clicked.probeId
							? null
							: { path: activePathRef.current, probeId: clicked.probeId },
					);
					return;
				}
			}
			if (
				mouse.target.type !==
					monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
				!mouse.target.position
			)
				return;
			const probe = catalogRef.current.find(
				(candidate) =>
					candidate.supported &&
					candidate.originalRange.startLine ===
						mouse.target.position?.lineNumber,
			);
			if (!probe) return;
			const next = {
				...settingsRef.current,
				manualProbeIds: toggleProbe(
					settingsRef.current.manualProbeIds,
					probe.probeId,
				),
			};
			sendSettingsRef.current(next);
			setTimeout(() => runRef.current(), 0);
		});

		// Desktop users arrive with a physical keyboard, so put the caret where
		// they can type immediately. A phone browser only opens its software
		// keyboard when focus begins inside a user gesture. Focusing Monaco
		// during mount leaves its hidden input already active, so the later tap
		// has no focus transition and iOS keeps the keyboard closed. Let Monaco
		// perform that first focus from the tap on touch-primary devices.
		if (!window.matchMedia("(pointer: coarse)").matches) editor.focus();
	},
		[
			activePathRef,
			attachVim,
			catalogRef,
			decorationsRef,
			entryRef,
			errorLensDecorationsRef,
			editorRef,
			inlineLogDecorationsRef,
			logSourceDecorationsRef,
			monacoRef,
			setFocusZone,
			openInLsp,
			runRef,
			sendSettingsRef,
			session,
			setCursorPosition,
			setPeek,
			setProjectFiles,
			settingsRef,
			setupVimKeys,
			testLensDecorationsRef,
		],
	);
}
