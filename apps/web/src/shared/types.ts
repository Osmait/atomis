/** Shared UI-side types for a session's project files and terminal output. */
export type {
	TerminalEntry,
	TerminalSourceLocation as LogSourceLocation,
} from "./lib/terminalFolds.js";

export interface ProjectFile {
	path: string;
	uri: string;
	source: string;
}

/**
 * Read access to the live file list. The list is mirrored in React state and
 * in a ref — the ref so callbacks see the current value without re-binding,
 * the state so the UI renders — and they must move together. Consumers get
 * this instead of the ref itself, so the only way to write is the setter
 * that updates both.
 */
export interface ProjectFilesReader {
	readonly current: ProjectFile[];
}
