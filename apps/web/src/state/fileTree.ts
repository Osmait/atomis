export interface FolderRow {
	kind: "folder";
	path: string;
	name: string;
	depth: number;
	collapsed: boolean;
	fails: number;
	pending: boolean;
}

export interface FileRow {
	kind: "file";
	path: string;
	name: string;
	depth: number;
}

export type TreeRow = FolderRow | FileRow;

const parentOf = (path: string): string =>
	path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * Derives the hierarchical tree rows from flat project paths. Folders are
 * implicit (they exist because files live inside them), plus any locally
 * pending folders created in the UI that have no file yet. Children of a
 * collapsed folder are omitted; folders sort before files at every level.
 */
export function buildTreeRows(options: {
	files: readonly string[];
	collapsed: ReadonlySet<string>;
	pendingFolders: readonly string[];
	failsByFile: ReadonlyMap<string, number>;
}): TreeRow[] {
	const folders = new Set<string>();
	for (const path of options.files) {
		const parts = path.split("/");
		for (let depth = 1; depth < parts.length; depth++)
			folders.add(parts.slice(0, depth).join("/"));
	}
	for (const pending of options.pendingFolders) {
		const parts = pending.split("/");
		for (let depth = 1; depth <= parts.length; depth++)
			folders.add(parts.slice(0, depth).join("/"));
	}

	const folderFails = new Map<string, number>();
	for (const [path, fails] of options.failsByFile) {
		if (!fails) continue;
		const parts = path.split("/");
		for (let depth = 1; depth < parts.length; depth++) {
			const folder = parts.slice(0, depth).join("/");
			folderFails.set(folder, (folderFails.get(folder) ?? 0) + fails);
		}
	}

	const childFolders = new Map<string, string[]>();
	const childFiles = new Map<string, string[]>();
	for (const folder of folders) {
		const parent = parentOf(folder);
		childFolders.set(parent, [...(childFolders.get(parent) ?? []), folder]);
	}
	for (const file of options.files) {
		const parent = parentOf(file);
		childFiles.set(parent, [...(childFiles.get(parent) ?? []), file]);
	}

	const hasRealFiles = (folder: string): boolean =>
		options.files.some((file) => file.startsWith(`${folder}/`));

	const rows: TreeRow[] = [];
	const walk = (parent: string, depth: number): void => {
		const sortedFolders = (childFolders.get(parent) ?? []).toSorted((a, b) =>
			a.localeCompare(b),
		);
		for (const folder of sortedFolders) {
			const collapsed = options.collapsed.has(folder);
			rows.push({
				kind: "folder",
				path: folder,
				name: folder.slice(folder.lastIndexOf("/") + 1),
				depth,
				collapsed,
				fails: folderFails.get(folder) ?? 0,
				pending: !hasRealFiles(folder),
			});
			if (!collapsed) walk(folder, depth + 1);
		}
		const sortedFiles = (childFiles.get(parent) ?? []).toSorted((a, b) =>
			a.localeCompare(b),
		);
		for (const file of sortedFiles)
			rows.push({
				kind: "file",
				path: file,
				name: file.slice(file.lastIndexOf("/") + 1),
				depth,
			});
	};
	walk("", 0);
	return rows;
}
