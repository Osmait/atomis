import type React from "react";
import cIcon from "material-icon-theme/icons/c.svg";
import cppIcon from "material-icon-theme/icons/cpp.svg";
import documentIcon from "material-icon-theme/icons/document.svg";
import fileIcon from "material-icon-theme/icons/file.svg";
import folderOpenIcon from "material-icon-theme/icons/folder-open.svg";
import folderIcon from "material-icon-theme/icons/folder.svg";
import goIcon from "material-icon-theme/icons/go.svg";
import hIcon from "material-icon-theme/icons/h.svg";
import hppIcon from "material-icon-theme/icons/hpp.svg";
import javascriptIcon from "material-icon-theme/icons/javascript.svg";
import jsonIcon from "material-icon-theme/icons/json.svg";
import markdownIcon from "material-icon-theme/icons/markdown.svg";
import pythonIcon from "material-icon-theme/icons/python.svg";
import rustIcon from "material-icon-theme/icons/rust.svg";
import tomlIcon from "material-icon-theme/icons/toml.svg";
import typescriptIcon from "material-icon-theme/icons/typescript.svg";
import zigIcon from "material-icon-theme/icons/zig.svg";

export type FileKind =
	| "zig"
	| "zon"
	| "rs"
	| "go"
	| "ts"
	| "js"
	| "py"
	| "c"
	| "h"
	| "cpp"
	| "hpp"
	| "toml"
	| "txt"
	| "md"
	| "json"
	| "file";

export function fileKind(path: string): FileKind {
	if (path.endsWith(".zig")) return "zig";
	if (path.endsWith(".zon")) return "zon";
	if (path.endsWith(".rs")) return "rs";
	if (path.endsWith(".go")) return "go";
	if (path.endsWith(".ts")) return "ts";
	if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs"))
		return "js";
	if (path.endsWith(".py")) return "py";
	if (path.endsWith(".h")) return "h";
	if (path.endsWith(".hpp")) return "hpp";
	if (path.endsWith(".c")) return "c";
	if (path.endsWith(".cpp") || path.endsWith(".cc")) return "cpp";
	if (path.endsWith(".mod") || path.endsWith(".sum")) return "toml";
	if (path.endsWith(".toml")) return "toml";
	if (path.endsWith(".txt")) return "txt";
	if (path.endsWith(".md")) return "md";
	if (path.endsWith(".json")) return "json";
	return "file";
}

/** material-icon-theme SVGs (MIT), bundled by Vite — no network use. */
const FILE_ICONS: Record<FileKind, string> = {
	zig: zigIcon,
	zon: zigIcon,
	rs: rustIcon,
	go: goIcon,
	ts: typescriptIcon,
	js: javascriptIcon,
	py: pythonIcon,
	c: cIcon,
	h: hIcon,
	cpp: cppIcon,
	hpp: hppIcon,
	toml: tomlIcon,
	txt: documentIcon,
	md: markdownIcon,
	json: jsonIcon,
	file: fileIcon,
};

export function FileIcon({ path }: { path: string }): React.JSX.Element {
	const kind = fileKind(path);
	return (
		<i className={`file-glyph ${kind}`}>
			<img src={FILE_ICONS[kind]} alt="" draggable={false} />
		</i>
	);
}

export function FolderIcon({
	open = false,
}: {
	open?: boolean;
}): React.JSX.Element {
	return (
		<i className="folder-glyph">
			<img src={open ? folderOpenIcon : folderIcon} alt="" draggable={false} />
		</i>
	);
}

/** Brand mark in the tree header (the Zig file icon at brand size). */
export function ZigMark(): React.JSX.Element {
	return <img src={zigIcon} alt="" draggable={false} />;
}
