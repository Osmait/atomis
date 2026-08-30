import { useEffect, useRef, useState } from "react";
import { FileIcon } from "../features/files/FileIcon.js";
import { Lucide } from "../shared/ui/Lucide.js";

export interface PaletteFile {
	path: string;
}

/** An action the palette can run, listed above the files. */
export interface PaletteCommand {
	id: string;
	title: string;
	hint: string;
	act: () => void;
}

interface CommandPaletteProps {
	files: readonly PaletteFile[];
	commands?: readonly PaletteCommand[];
	activePath: string;
	onOpen: (path: string, run: boolean) => void;
	onCreate: (path: string) => void;
	onClose: () => void;
}

const NO_COMMANDS: readonly PaletteCommand[] = [];

function validCreatePath(path: string): boolean {
	if (path.startsWith("/") || path.includes("\\") || path.length > 240)
		return false;
	if ([...path].some((char) => (char.codePointAt(0) ?? 0) < 0x20)) return false;
	return path
		.split("/")
		.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function CommandPalette({
	files,
	commands = NO_COMMANDS,
	activePath,
	onOpen,
	onCreate,
	onClose,
}: CommandPaletteProps): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => inputRef.current?.focus(), []);

	// A leading ">" narrows to commands, the way editors have taught people
	// to expect; without it commands still show, matched by their title.
	const commandMode = query.startsWith(">");
	const trimmed = (commandMode ? query.slice(1) : query).trim();
	const needle = trimmed.toLowerCase();
	const matchedCommands = commands.filter(
		(command) => !needle || command.title.toLowerCase().includes(needle),
	);
	const results = commandMode
		? []
		: files.filter((file) => !trimmed || file.path.toLowerCase().includes(needle));
	const exactMatch = files.some((file) => file.path === trimmed);
	const creatable =
		!commandMode &&
		Boolean(trimmed) &&
		!exactMatch &&
		validCreatePath(trimmed);
	const rowCount = matchedCommands.length + results.length + (creatable ? 1 : 0);
	const clamp = (value: number): number =>
		rowCount === 0 ? 0 : Math.min(Math.max(value, 0), rowCount - 1);
	const activeRow = clamp(selected);

	const activate = (row: number, run: boolean): void => {
		const command = matchedCommands[row];
		if (command) {
			command.act();
			return;
		}
		const file = results[row - matchedCommands.length];
		if (file) {
			onOpen(file.path, run);
			return;
		}
		if (creatable) onCreate(trimmed);
	};

	return (
		<div className="palette-overlay" onClick={onClose} role="presentation">
			<div
				className="palette"
				onClick={(event) => event.stopPropagation()}
				role="dialog"
				aria-label="Find file"
			>
				<div className="palette-input-row">
					<span className="palette-glyph">⌕</span>
					<input
						ref={inputRef}
						placeholder="search or create a file… (> for commands)"
						value={query}
						aria-label="Find file"
						onChange={(event) => {
							setQuery(event.target.value);
							setSelected(0);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								onClose();
							} else if (event.key === "ArrowDown") {
								event.preventDefault();
								setSelected((previous) => clamp(previous + 1));
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								setSelected((previous) => clamp(previous - 1));
							} else if (event.key === "Enter") {
								event.preventDefault();
								activate(activeRow, event.metaKey || event.ctrlKey);
							}
						}}
					/>
					<span className="palette-kbd">esc</span>
				</div>
				<div className="palette-results">
					{matchedCommands.map((command, index) => (
						<button
							className={`palette-row command${index === activeRow ? " selected" : ""}`}
							key={command.id}
							onClick={command.act}
							onMouseEnter={() => setSelected(index)}
						>
							<Lucide icon="settings" size={13} />
							<span>{command.title}</span>
							<b>{command.hint}</b>
						</button>
					))}
					{results.map((file, index) => {
						const row = matchedCommands.length + index;
						return (
							<button
								className={`palette-row${row === activeRow ? " selected" : ""}${file.path === activePath ? " current" : ""}`}
								key={file.path}
								onClick={(event) =>
									onOpen(file.path, event.metaKey || event.ctrlKey)
								}
								onMouseEnter={() => setSelected(row)}
							>
								<FileIcon path={file.path} />
								<span>{file.path}</span>
								<b>{file.path.endsWith(".zig") ? "run" : "open"}</b>
							</button>
						);
					})}
					{creatable && (
						<button
							className={`palette-row${activeRow === rowCount - 1 ? " selected" : ""}`}
							onClick={() => onCreate(trimmed)}
							onMouseEnter={() => setSelected(rowCount - 1)}
						>
							<i className="file-glyph new">＋</i>
							<span>create {trimmed}</span>
							<b>new</b>
						</button>
					)}
					{rowCount === 0 && <p className="palette-empty">no results</p>}
				</div>
				<footer>↵ open · ⌘↵ open and run · esc close</footer>
			</div>
		</div>
	);
}
