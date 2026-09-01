import { useCallback, useRef, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import {
	MAX_PROJECT_FILES,
	type CreateSessionResponse,
	type Language,
} from "@atomis/protocol";
import type * as MonacoApi from "monaco-editor";
import { ENTRY_FILES, languageForPath } from "../editor/languagePacks.js";
import type { LspClient } from "../editor/lsp/LspClient.js";
import {
	isValidProjectPath,
	normalizeFolderName,
} from "../../shared/lib/paths.js";
import { saveLanguage } from "../../shared/stores/settings.js";
import { closeTab as computeCloseTab } from "../../shared/lib/tabs.js";
import type { LogSourceLocation, ProjectFile, ProjectFilesReader } from "../../shared/types.js";

export interface TreeDraft {
	kind: "file" | "folder" | "rename";
	base: string;
	original?: string;
}

export interface TreeContextMenuState {
	x: number;
	y: number;
	path?: string;
	folder?: string;
}

interface ProjectFilesOptions {
	session: CreateSessionResponse | undefined;
	sendRuntime: (message: object) => void;
	versionRef: React.RefObject<number>;
	entryRef: React.RefObject<string>;
	activeLanguageRef: React.RefObject<Language>;
	filesRef: ProjectFilesReader;
	setProjectFiles: (
		next: ProjectFile[] | ((previous: ProjectFile[]) => ProjectFile[]),
	) => void;
	lspClientsRef: React.RefObject<Partial<Record<Language, LspClient>>>;
	monacoRef: React.RefObject<Monaco | undefined>;
	openInLsp: (path: string, model: MonacoApi.editor.ITextModel) => void;
	pinnedLogLocationRef: React.RefObject<LogSourceLocation | undefined>;
	logSourceDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	setStatus: (status: string) => void;
	/**
	 * Drops a path's diagnostics at delete/rename time. The LSP's empty
	 * publishDiagnostics arrives only after the file has left filesRef, so
	 * it lands under a different key and the old entries stayed listed
	 * forever.
	 */
	pruneDiagnosticsFor: (path: string) => void;
}

/**
 * File and tab management: the active file, open tabs, folder collapse
 * state, and the create/rename/delete operations (with their inline tree
 * drafts) that keep the local mirror, Monaco, the LSPs and the server in
 * sync.
 */
export function useProjectFiles(options: ProjectFilesOptions) {
	const {
		session,
		sendRuntime,
		versionRef,
		entryRef,
		activeLanguageRef,
		filesRef,
		setProjectFiles,
		lspClientsRef,
		monacoRef,
		openInLsp,
		pinnedLogLocationRef,
		logSourceDecorationsRef,
		setStatus,
		pruneDiagnosticsFor,
	} = options;
	const [activePath, setActivePath] = useState(entryRef.current);
	const activePathRef = useRef(entryRef.current);
	const [openTabs, setOpenTabs] = useState([entryRef.current]);
	const openTabsRef = useRef(openTabs);
	openTabsRef.current = openTabs;
	const [treeDraft, setTreeDraft] = useState<TreeDraft | undefined>(undefined);
	const [treeDraftInvalid, setTreeDraftInvalid] = useState(false);
	const [treeDraftValue, setTreeDraftValue] = useState("");
	const [treeContextMenu, setTreeContextMenu] = useState<
		TreeContextMenuState | undefined
	>(undefined);
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
		new Set(),
	);
	const [pendingFolders, setPendingFolders] = useState<string[]>([]);
	const [srcCollapsed, setSrcCollapsed] = useState(false);

	const selectFile = useCallback(
		(path: string): void => {
			const file = filesRef.current.find(
				(candidate) => candidate.path === path,
			);
			if (!file) return;
			activePathRef.current = path;
			setActivePath(path);
			setOpenTabs((previous) =>
				previous.includes(path) ? previous : [...previous, path],
			);
			pinnedLogLocationRef.current = undefined;
			logSourceDecorationsRef.current?.clear();
			const language = languageForPath(path);
			if (language) {
				activeLanguageRef.current = language;
				saveLanguage(language);
			}
			setTimeout(() => {
				const model = monacoRef.current?.editor.getModel(
					monacoRef.current.Uri.parse(file.uri),
				);
				if (model) openInLsp(path, model);
			}, 0);
		},
		[
			activeLanguageRef,
			filesRef,
			logSourceDecorationsRef,
			monacoRef,
			openInLsp,
			pinnedLogLocationRef,
		],
	);

	const closeTab = useCallback(
		(path: string): void => {
			const closed = computeCloseTab(
				openTabsRef.current,
				path,
				activePathRef.current,
				entryRef.current,
			);
			setOpenTabs(closed.tabs);
			if (closed.nextActive) selectFile(closed.nextActive);
		},
		[entryRef, selectFile],
	);

	const closeOtherTabs = useCallback((): void => {
		setOpenTabs([activePathRef.current]);
	}, []);

	const createFileNamed = useCallback(
		(path: string): boolean => {
			if (!session) return false;
			// Everything the server would refuse is refused HERE, before the
			// optimistic apply below touches the tree, the tabs and the
			// active file — an optimistic file the server then rejects is a
			// phantom the user edits into the void.
			if (!isValidProjectPath(path)) {
				setStatus("Invalid file path");
				return false;
			}
			if (filesRef.current.some((file) => file.path === path)) {
				setStatus(`File ${path} already exists`);
				return false;
			}
			if (filesRef.current.length >= MAX_PROJECT_FILES) {
				setStatus(`A project can contain at most ${MAX_PROJECT_FILES} files`);
				return false;
			}
			const base = session.documentUri.slice(
				0,
				session.documentUri.lastIndexOf("/") + 1,
			);
			const file = { path, uri: new URL(path, base).href, source: "" };
			const nextFiles = [...filesRef.current, file].toSorted(
				(left, right) => left.path.localeCompare(right.path),
			);
			setProjectFiles(nextFiles);
			const version = ++versionRef.current;
			sendRuntime({
				type: "file.create",
				sessionId: session.sessionId,
				version,
				path,
				source: "",
			});
			activePathRef.current = path;
			setActivePath(path);
			setOpenTabs((previous) => [...previous, path]);
			return true;
		},
		[filesRef, sendRuntime, session, setProjectFiles, setStatus, versionRef],
	);

	// VS Code-style inline creation: the tree shows an input row instead of
	// a browser prompt. `base` is the folder prefix ("" for the root).
	const createFile = useCallback((prefix = ""): void => {
		setTreeDraftInvalid(false);
		setTreeDraftValue("");
		setSrcCollapsed(false);
		setTreeDraft({ kind: "file", base: prefix });
	}, []);

	const createFolder = useCallback((base = ""): void => {
		setTreeDraftInvalid(false);
		setTreeDraftValue("");
		setSrcCollapsed(false);
		setTreeDraft({ kind: "folder", base });
	}, []);

	const createFolderNamed = useCallback(
		(raw: string): boolean => {
			const folder = normalizeFolderName(raw);
			if (!isValidProjectPath(folder)) {
				setStatus("Invalid folder name");
				return false;
			}
			setPendingFolders((previous) =>
				previous.includes(folder) ? previous : [...previous, folder],
			);
			return true;
		},
		[setStatus],
	);

	const toggleFolder = useCallback((path: string): void => {
		setCollapsedFolders((previous) => {
			const next = new Set(previous);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const renameFileTo = useCallback(
		(path: string, newPath: string): boolean => {
			if (!session || ENTRY_FILES.has(path)) return false;
			if (!newPath || newPath === path) return true;
			if (!isValidProjectPath(newPath)) {
				setStatus("Invalid file path");
				return false;
			}
			if (filesRef.current.some((file) => file.path === newPath)) {
				setStatus(`File ${newPath} already exists`);
				return false;
			}
			const current = filesRef.current.find((file) => file.path === path);
			if (!current) return false;
			const base = session.documentUri.slice(
				0,
				session.documentUri.lastIndexOf("/") + 1,
			);
			const renamed = {
				...current,
				path: newPath,
				uri: new URL(newPath, base).href,
			};
			setProjectFiles((previous) =>
				previous.map((file) => (file.path === path ? renamed : file)),
			);
			setOpenTabs((previous) =>
				previous.map((tab) => (tab === path ? newPath : tab)),
			);
			if (activePathRef.current === path) {
				activePathRef.current = newPath;
				setActivePath(newPath);
			}
			const oldLanguage = languageForPath(path);
			if (oldLanguage) lspClientsRef.current[oldLanguage]?.close(current.uri);
			// The old name's diagnostics go with it; the new name earns its
			// own from the next publish/run.
			pruneDiagnosticsFor(path);
			const version = ++versionRef.current;
			sendRuntime({
				type: "file.rename",
				sessionId: session.sessionId,
				version,
				path,
				newPath,
			});
			return true;
		},
		[filesRef, lspClientsRef, pruneDiagnosticsFor, sendRuntime, session, setProjectFiles, setStatus, versionRef],
	);

	const renameFile = useCallback((path: string): void => {
		if (ENTRY_FILES.has(path)) return;
		setTreeDraftInvalid(false);
		setTreeDraftValue(path);
		setSrcCollapsed(false);
		setTreeDraft({ kind: "rename", base: "", original: path });
	}, []);

	const commitTreeDraft = useCallback(
		(value: string): void => {
			const draft = treeDraft;
			if (!draft) return;
			const name = value.trim();
			if (!name) {
				setTreeDraft(undefined);
				return;
			}
			let ok = false;
			if (draft.kind === "file") ok = createFileNamed(draft.base + name);
			else if (draft.kind === "folder")
				ok = createFolderNamed(draft.base + name);
			else if (draft.original) ok = renameFileTo(draft.original, name);
			if (ok) setTreeDraft(undefined);
			else setTreeDraftInvalid(true);
		},
		[treeDraft, createFileNamed, createFolderNamed, renameFileTo],
	);

	const deleteFile = useCallback(
		(path: string): void => {
			if (!session || ENTRY_FILES.has(path)) return;
			if (!window.confirm(`Delete src/${path}?`)) return;
			const current = filesRef.current.find((file) => file.path === path);
			if (!current) return;
			const wasActive = activePathRef.current === path;
			setProjectFiles((previous) =>
				previous.filter((file) => file.path !== path),
			);
			setOpenTabs((previous) => {
				const kept = previous.filter((tab) => tab !== path);
				// Deleting the active file falls back to the entry, which
				// must have a tab to land on — its own may have been closed.
				if (wasActive && !kept.includes(entryRef.current))
					kept.push(entryRef.current);
				return kept;
			});
			if (wasActive) {
				activePathRef.current = entryRef.current;
				setActivePath(entryRef.current);
			}
			const language = languageForPath(path);
			if (language) lspClientsRef.current[language]?.close(current.uri);
			pruneDiagnosticsFor(path);
			monacoRef.current?.editor
				.getModel(monacoRef.current.Uri.parse(current.uri))
				?.dispose();
			const version = ++versionRef.current;
			sendRuntime({
				type: "file.delete",
				sessionId: session.sessionId,
				version,
				path,
			});
		},
		[entryRef, filesRef, lspClientsRef, monacoRef, pruneDiagnosticsFor, sendRuntime, session, setProjectFiles, versionRef],
	);

	/** Session bootstrap: reset to the created session's entry file. */
	const resetToEntry = useCallback((entry: string): void => {
		activePathRef.current = entry;
		setActivePath(entry);
		setOpenTabs([entry]);
	}, []);

	return {
		activePath,
		activePathRef,
		openTabs,
		openTabsRef,
		treeDraft,
		setTreeDraft,
		treeDraftInvalid,
		setTreeDraftInvalid,
		treeDraftValue,
		setTreeDraftValue,
		treeContextMenu,
		setTreeContextMenu,
		collapsedFolders,
		pendingFolders,
		srcCollapsed,
		setSrcCollapsed,
		selectFile,
		closeTab,
		closeOtherTabs,
		createFile,
		createFolder,
		createFileNamed,
		renameFile,
		deleteFile,
		commitTreeDraft,
		toggleFolder,
		resetToEntry,
	};
}
