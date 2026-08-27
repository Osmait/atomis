import type React from "react";
import type { TreeContextMenuState } from "../hooks/useProjectFiles.js";
import { ENTRY_FILES } from "../languages.js";
import { Lucide } from "./Lucide.js";

interface TreeContextMenuProps {
	menu: TreeContextMenuState;
	onClose: () => void;
	onOpen: (path: string) => void;
	onRename: (path: string) => void;
	onDelete: (path: string) => void;
	onCreateFile: (prefix: string) => void;
	onCreateFolder: (base: string) => void;
}

/** Right-click menu of the tree: open/rename/delete on a row, plus create
 * actions targeted at the row's folder (or the root). */
export function TreeContextMenu(props: TreeContextMenuProps): React.JSX.Element {
	const { menu } = props;
	return (
		<div
			className="term-menu tree-context-menu"
			ref={(node) => {
				if (!node) return;
				const { innerWidth, innerHeight } = window;
				const rect = node.getBoundingClientRect();
				node.style.left = `${Math.min(menu.x, innerWidth - rect.width - 8)}px`;
				node.style.top = `${Math.min(menu.y, innerHeight - rect.height - 8)}px`;
			}}
			role="menu"
		>
			{menu.path && (
				<>
					<button
						onClick={() => {
							props.onClose();
							if (menu.path) props.onOpen(menu.path);
						}}
						role="menuitem"
					>
						<Lucide icon="chevron-right" size={13} />
						<span>Abrir</span>
					</button>
					<button
						disabled={ENTRY_FILES.has(menu.path)}
						onClick={() => {
							props.onClose();
							if (menu.path) props.onRename(menu.path);
						}}
						role="menuitem"
					>
						<Lucide icon="pencil" size={13} />
						<span>Renombrar</span>
					</button>
					<button
						disabled={ENTRY_FILES.has(menu.path)}
						onClick={() => {
							props.onClose();
							if (menu.path) props.onDelete(menu.path);
						}}
						role="menuitem"
					>
						<Lucide icon="trash-2" size={13} />
						<span>Eliminar</span>
					</button>
					<span className="term-menu-sep" />
				</>
			)}
			<button
				onClick={() => {
					props.onClose();
					const base =
						menu.folder ??
						(menu.path?.includes("/")
							? menu.path.slice(0, menu.path.lastIndexOf("/"))
							: undefined);
					props.onCreateFile(base ? `${base}/` : "");
				}}
				role="menuitem"
			>
				<Lucide icon="file-plus" size={13} />
				<span>
					Nuevo archivo
					{menu.folder ? ` en ${menu.folder}/` : ""}
				</span>
			</button>
			<button
				onClick={() => {
					props.onClose();
					props.onCreateFolder(menu.folder ? `${menu.folder}/` : "");
				}}
				role="menuitem"
			>
				<Lucide icon="folder-plus" size={13} />
				<span>Nueva carpeta</span>
			</button>
		</div>
	);
}

interface EditorContextMenuProps {
	menu: { x: number; y: number };
	onCopy: () => void;
	onPaste: () => void;
}

/** Minimal Copy/Paste menu over Monaco (the native one is suppressed). */
export function EditorContextMenu(
	props: EditorContextMenuProps,
): React.JSX.Element {
	return (
		<div
			className="editor-context-menu"
			ref={(node) => {
				if (!node) return;
				node.style.left = `${props.menu.x}px`;
				node.style.top = `${props.menu.y}px`;
			}}
			role="menu"
		>
			<button role="menuitem" onClick={props.onCopy}>
				Copy
			</button>
			<button role="menuitem" onClick={props.onPaste}>
				Paste
			</button>
		</div>
	);
}
