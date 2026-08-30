import React, { useState } from "react";
import { useDismissable } from "../hooks/useDismissable.js";
import type { TreeContextMenuState, TreeDraft } from "../hooks/useProjectFiles.js";
import type { TreeRow } from "../shared/lib/fileTree.js";
import { FileIcon, FolderIcon } from "./FileIcon.js";
import { Lucide } from "./Lucide.js";

interface FileTreeProps {
	rows: TreeRow[];
	activePath: string;
	activeIsEntry: boolean;
	focused: boolean;
	treeSel: number;
	srcCollapsed: boolean;
	draft: TreeDraft | undefined;
	draftValue: string;
	draftInvalid: boolean;
	failsByFile: ReadonlyMap<string, number>;
	/** Changing this replays the unfold animation (one workspace = one key). */
	revealKey: string;
	/** Name of the open workspace, shown as the sidebar's title. */
	workspaceName: string;
	/** True for the throwaway session, which reads differently. */
	scratch: boolean;
	onToggleSrc: () => void;
	onSelect: (path: string) => void;
	onToggleFolder: (path: string) => void;
	onCreateFile: (prefix?: string) => void;
	onCreateFolder: (base?: string) => void;
	onRenameActive: () => void;
	onDeleteActive: () => void;
	onHideTree: () => void;
	onLoadDemo: () => void;
	onSwitchWorkspace: () => void;
	onClearWorkspace: () => void;
	onDraftChange: (value: string) => void;
	onDraftCommit: (value: string) => void;
	onDraftCancel: () => void;
	onOpenContextMenu: (menu: TreeContextMenuState) => void;
}

/**
 * Per-row stagger for the unfold: later rows start later, capped so a big
 * tree still finishes quickly.
 */
function rowDelay(index: number): React.CSSProperties {
	return { "--row": Math.min(index, 12) } as React.CSSProperties;
}

/** The project sidebar: src root row with its ⋯ menu, inline creation and
 * rename drafts, and the folder/file rows with failing-test badges. */
export function FileTree(props: FileTreeProps): React.JSX.Element {
	const [menuOpen, setMenuOpen] = useState(false);
	useDismissable(menuOpen, ".tree-menu-wrap, .tree-menu", () =>
		setMenuOpen(false),
	);
	const {
		rows,
		activePath,
		draft,
		draftValue,
		draftInvalid,
		failsByFile,
	} = props;

	const draftRow = (indent: number): React.JSX.Element => (
		<div
			className={`tree-draft${draftInvalid ? " invalid" : ""}`}
			style={{ paddingLeft: `${10 + indent * 14}px` }}
		>
			{draft?.kind === "folder" ? (
				<FolderIcon />
			) : (
				<FileIcon path={draftValue || "file.txt"} />
			)}
			<input
				aria-label={
					draft?.kind === "folder"
						? "Folder name"
						: draft?.kind === "rename"
							? "New file path"
							: "File name"
				}
				autoFocus
				onBlur={() => {
					if (draftValue.trim() && draft?.kind !== "rename")
						props.onDraftCommit(draftValue);
					props.onDraftCancel();
				}}
				onChange={(event) => props.onDraftChange(event.target.value)}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === "Enter") props.onDraftCommit(draftValue);
					else if (event.key === "Escape") props.onDraftCancel();
				}}
				placeholder={draft?.kind === "folder" ? "folder" : "name.ext"}
				spellCheck={false}
				value={draftValue}
			/>
		</div>
	);

	return (
		<aside className={`tree-card${props.focused ? " kb-zone" : ""}`}>
			{/* The sidebar is titled by the workspace, where an IDE puts the
			    project — and the title is the switcher. */}
			<button
				className={`workspace-bar${props.scratch ? " scratch" : ""}`}
				onClick={props.onSwitchWorkspace}
				title="Switch workspace"
			>
				<Lucide icon={props.scratch ? "flask-conical" : "folder-open"} size={14} />
				<span className="workspace-bar-name">{props.workspaceName}</span>
				<Lucide icon="chevrons-up-down" size={13} />
			</button>
			<div
				className="file-tree"
				onContextMenu={(event) => {
					event.preventDefault();
					const row =
						event.target instanceof Element
							? event.target.closest<HTMLElement>(
									"[data-tree-path], [data-tree-folder]",
								)
							: null;
					props.onOpenContextMenu({
						x: event.clientX,
						y: event.clientY,
						...(row?.dataset.treePath ? { path: row.dataset.treePath } : {}),
						...(row?.dataset.treeFolder
							? { folder: row.dataset.treeFolder }
							: {}),
					});
				}}
			>
				<div className="tree-root">
					<button
						className="tree-root-toggle"
						onClick={props.onToggleSrc}
						title={props.srcCollapsed ? "Expand src" : "Collapse src"}
					>
						<span className="chev">
							<Lucide
								icon={props.srcCollapsed ? "chevron-right" : "chevron-down"}
								size={13}
							/>
						</span>
						<FolderIcon open={!props.srcCollapsed} /> src
					</button>
					<span className="tree-menu-wrap root-tools">
						<button
							aria-label="Tree actions"
							className={`tree-menu-btn${menuOpen ? " open" : ""}`}
							onClick={() => setMenuOpen((previous) => !previous)}
						>
							<Lucide icon="ellipsis-vertical" size={14} />
						</button>
					</span>
				</div>
				{menuOpen && (
					<div className="term-menu tree-menu" role="menu">
						<button
							onClick={() => {
								setMenuOpen(false);
								props.onCreateFile();
							}}
							role="menuitem"
						>
							<Lucide icon="file-plus" size={13} />
							<span>New file</span>
						</button>
						<button
							onClick={() => {
								setMenuOpen(false);
								props.onCreateFolder();
							}}
							role="menuitem"
						>
							<Lucide icon="folder-plus" size={13} />
							<span>New folder</span>
						</button>
						<span className="term-menu-sep" />
						<button
							disabled={props.activeIsEntry}
							onClick={() => {
								setMenuOpen(false);
								props.onRenameActive();
							}}
							role="menuitem"
						>
							<Lucide icon="pencil" size={13} />
							<span>Rename file</span>
						</button>
						<button
							disabled={props.activeIsEntry}
							onClick={() => {
								setMenuOpen(false);
								props.onDeleteActive();
							}}
							role="menuitem"
						>
							<Lucide icon="trash-2" size={13} />
							<span>Delete file</span>
						</button>
						<span className="term-menu-sep" />
						<button
							onClick={() => {
								setMenuOpen(false);
								props.onSwitchWorkspace();
							}}
							role="menuitem"
						>
							<Lucide icon="folder-plus" size={13} />
							<span>Switch workspace…</span>
						</button>
						<button
							onClick={() => {
								setMenuOpen(false);
								props.onLoadDemo();
							}}
							role="menuitem"
						>
							<Lucide icon="flask-conical" size={13} />
							<span>Load demo workspace</span>
						</button>
						<button
							onClick={() => {
								setMenuOpen(false);
								props.onClearWorkspace();
							}}
							role="menuitem"
						>
							<Lucide icon="eraser" size={13} />
							<span>Clear workspace</span>
						</button>
						<span className="term-menu-sep" />
						<button
							onClick={() => {
								setMenuOpen(false);
								props.onHideTree();
							}}
							role="menuitem"
						>
							<Lucide icon="panel-left-close" size={13} />
							<span>Hide tree</span>
							<b>⌘B</b>
						</button>
					</div>
				)}
				{draft && draft.kind !== "rename" && draft.base === "" && draftRow(0)}
				{/* Remounting on the workspace key replays the accordion. */}
				<div className="tree-rows" key={props.revealKey}>
				{!props.srcCollapsed &&
					rows.map((row, rowIndex) => {
						const kbSelected = props.focused && rowIndex === props.treeSel;
						if (row.kind === "folder")
							return (
								<React.Fragment key={`folder:${row.path}`}>
									<div
										className={`tree-folder-row${kbSelected ? " kb-sel" : ""}`}
										data-tree-folder={row.path}
										style={{
											paddingLeft: `${10 + row.depth * 14}px`,
											...rowDelay(rowIndex),
										}}
									>
										<button
											className="tree-folder"
											onClick={() => props.onToggleFolder(row.path)}
											title={row.path}
										>
											<span className="chev">
												{row.collapsed ? "▸" : "▾"}
											</span>
											<FolderIcon open={!row.collapsed} />
											<span className="folder-name">{row.name}</span>
											{row.fails > 0 && (
												<span className="tree-badge fails">{row.fails}</span>
											)}
										</button>
										<button
											className="folder-add"
											onClick={() => props.onCreateFile(`${row.path}/`)}
											title={`New file in ${row.path}/`}
										>
											＋
										</button>
									</div>
									{draft &&
										draft.kind !== "rename" &&
										draft.base === `${row.path}/` &&
										draftRow(row.depth + 1)}
								</React.Fragment>
							);
						if (draft?.kind === "rename" && draft.original === row.path)
							return (
								<React.Fragment key={row.path}>
									{draftRow(row.depth)}
								</React.Fragment>
							);
						const fails = failsByFile.get(`src/${row.path}`) ?? 0;
						return (
							<button
								aria-label={row.path}
								className={`tree-file${row.path === activePath ? " active" : ""}${kbSelected ? " kb-sel" : ""}`}
								data-tree-path={row.path}
								key={row.path}
								onClick={() => props.onSelect(row.path)}
								style={{
									paddingLeft: `${22 + row.depth * 14}px`,
									...rowDelay(rowIndex),
								}}
								title={row.path}
							>
								<FileIcon path={row.path} /> {row.name}
								<span className={`tree-badge${fails ? " fails" : ""}`}>
									{fails
										? String(fails)
										: row.path === activePath
											? "✓"
											: ""}
								</span>
							</button>
						);
					})}
				</div>
			</div>
		</aside>
	);
}
