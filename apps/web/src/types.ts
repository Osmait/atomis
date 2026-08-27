/** Shared UI-side types for a session's project files and terminal output. */
export type {
	TerminalEntry,
	TerminalSourceLocation as LogSourceLocation,
} from "./state/terminalFolds.js";

export interface ProjectFile {
	path: string;
	uri: string;
	source: string;
}
