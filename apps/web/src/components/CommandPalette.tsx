import { useEffect, useRef, useState } from "react";
import { FileIcon } from "./FileIcon.js";

export interface PaletteFile {
	path: string;
}

interface CommandPaletteProps {
	files: readonly PaletteFile[];
	activePath: string;
	onOpen: (path: string, run: boolean) => void;
	onCreate: (path: string) => void;
	onClose: () => void;
}

function validCreatePath(path: string): boolean {
	if (path.startsWith("/") || path.includes("\\") || path.length > 240)
		return false;
	if ([...path].some((char) => char.charCodeAt(0) < 0x20)) return false;
	return path
		.split("/")
		.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function CommandPalette({
	files,
	activePath,
	onOpen,
	onCreate,
	onClose,
}: CommandPaletteProps): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => inputRef.current?.focus(), []);

	const trimmed = query.trim();
	const results = files.filter(
		(file) =>
			!trimmed || file.path.toLowerCase().includes(trimmed.toLowerCase()),
	);
	const exactMatch = files.some((file) => file.path === trimmed);
	const creatable = Boolean(trimmed) && !exactMatch && validCreatePath(trimmed);
	const rowCount = results.length + (creatable ? 1 : 0);
	const clamp = (value: number): number =>
		rowCount === 0 ? 0 : Math.min(Math.max(value, 0), rowCount - 1);
	const activeRow = clamp(selected);

	const activate = (row: number, run: boolean): void => {
		if (row < results.length) {
			const file = results[row];
			if (file) onOpen(file.path, run);
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
				aria-label="Buscar archivo"
			>
				<div className="palette-input-row">
					<span className="palette-glyph">⌕</span>
					<input
						ref={inputRef}
						placeholder="buscar o crear archivo…"
						value={query}
						aria-label="Buscar archivo"
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
					{results.map((file, index) => {
						return (
							<button
								className={`palette-row${index === activeRow ? " selected" : ""}${file.path === activePath ? " current" : ""}`}
								key={file.path}
								onClick={(event) =>
									onOpen(file.path, event.metaKey || event.ctrlKey)
								}
								onMouseEnter={() => setSelected(index)}
							>
								<FileIcon path={file.path} />
								<span>{file.path}</span>
								<b>{file.path.endsWith(".zig") ? "run" : "ver"}</b>
							</button>
						);
					})}
					{creatable && (
						<button
							className={`palette-row${activeRow === results.length ? " selected" : ""}`}
							onClick={() => onCreate(trimmed)}
							onMouseEnter={() => setSelected(results.length)}
						>
							<i className="file-glyph new">＋</i>
							<span>crear {trimmed}</span>
							<b>nuevo</b>
						</button>
					)}
					{rowCount === 0 && <p className="palette-empty">sin resultados</p>}
				</div>
				<footer>↵ abrir · ⌘↵ abrir y ejecutar · esc cerrar</footer>
			</div>
		</div>
	);
}
