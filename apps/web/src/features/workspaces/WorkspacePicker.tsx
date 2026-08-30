import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { Language, WorkspaceMeta } from "@atomis/protocol";
import { Lucide } from "../../shared/ui/Lucide.js";

interface WorkspacePickerProps {
	workspaces: WorkspaceMeta[];
	activeId: string | undefined;
	language: Language;
	busy: boolean;
	error?: string | undefined;
	onOpen: (id: string) => void;
	onCreate: (name: string) => void;
	onRename: (id: string, name: string) => void;
	onDelete: (id: string) => void;
	onScratch: () => void;
	onClose: () => void;
}

/** Relative "last opened" that stays readable without a date library. */
function ago(timestamp: number): string {
	const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * The workspace switcher: persistent projects to open, create, rename and
 * delete, plus the scratch session for throwaway work.
 */
export function WorkspacePicker(
	props: WorkspacePickerProps,
): React.JSX.Element {
	const [name, setName] = useState("");
	const [renaming, setRenaming] = useState<string | undefined>(undefined);
	const [renameValue, setRenameValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") props.onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [props]);

	return (
		<div className="palette-overlay" onClick={props.onClose} role="presentation">
			<div
				className="palette workspace-picker"
				onClick={(event) => event.stopPropagation()}
				role="dialog"
				aria-label="Workspaces"
			>
				<div className="palette-input-row">
					<span className="palette-glyph">
						<Lucide icon="folder-plus" size={14} />
					</span>
					<input
						ref={inputRef}
						aria-label="New workspace name"
						placeholder="name a new workspace…"
						value={name}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === "Enter" && name.trim()) {
								props.onCreate(name.trim());
								setName("");
							}
						}}
					/>
					<button
						className="palette-kbd"
						disabled={!name.trim() || props.busy}
						onClick={() => {
							props.onCreate(name.trim());
							setName("");
						}}
					>
						create
					</button>
				</div>

				{props.error && <p className="workspace-error">{props.error}</p>}

				<div className="palette-results">
					{props.workspaces.map((workspace) => (
						<div
							className={`palette-row workspace-row${workspace.id === props.activeId ? " selected" : ""}`}
							key={workspace.id}
						>
							{renaming === workspace.id ? (
								<input
									aria-label={`Rename ${workspace.name}`}
									autoFocus
									value={renameValue}
									onChange={(event) => setRenameValue(event.target.value)}
									onKeyDown={(event) => {
										event.stopPropagation();
										if (event.key === "Enter" && renameValue.trim()) {
											props.onRename(workspace.id, renameValue.trim());
											setRenaming(undefined);
										} else if (event.key === "Escape")
											setRenaming(undefined);
									}}
								/>
							) : (
								<>
									<button
										className="workspace-open"
										onClick={() => props.onOpen(workspace.id)}
									>
										<span className="workspace-name">{workspace.name}</span>
										<span className="workspace-meta">
											{workspace.language} · {ago(workspace.updatedAt)}
										</span>
									</button>
									<span className="workspace-actions">
										<button
											aria-label={`Rename ${workspace.name}`}
											onClick={() => {
												setRenaming(workspace.id);
												setRenameValue(workspace.name);
											}}
											title="Rename"
										>
											<Lucide icon="pencil" size={13} />
										</button>
										<button
											aria-label={`Delete ${workspace.name}`}
											onClick={() => props.onDelete(workspace.id)}
											title="Delete"
										>
											<Lucide icon="trash-2" size={13} />
										</button>
									</span>
								</>
							)}
						</div>
					))}
					{!props.workspaces.length && (
						<p className="palette-empty">
							no workspaces yet — name one above to keep its files
						</p>
					)}
					<button
						className={`palette-row workspace-scratch${props.activeId ? "" : " selected"}`}
						onClick={props.onScratch}
					>
						<span className="workspace-name">Scratch session</span>
						<span className="workspace-meta">
							temporary · discarded when you leave
						</span>
					</button>
				</div>
			</div>
		</div>
	);
}
