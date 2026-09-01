/**
 * Project path rules shared by file creation, folder creation and rename —
 * mirroring the server's `valid_project_path` (apps/server-rs/src/protocol.rs)
 * so invalid names fail inline in the tree instead of over the wire:
 * relative, at most 240 BYTES (the server measures bytes, not characters),
 * free of backslashes and control characters, no empty/`.`/`..` segments.
 *
 * `#` and `?` are refused here additionally: the server stores them fine,
 * but the file's Monaco model URI goes through `new URL`, which reads them
 * as fragment/query and silently truncates the path.
 */
const MAX_PATH_BYTES = 240;

export function isValidProjectPath(path: string): boolean {
	if (!path || path.startsWith("/") || path.includes("\\")) return false;
	if (path.includes("#") || path.includes("?")) return false;
	for (const character of path)
		if ((character.codePointAt(0) ?? 0) < 0x20) return false;
	if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) return false;
	return !path
		.split("/")
		.some((part) => !part || part === "." || part === "..");
}

/** Folder names may be typed with a trailing slash; strip it before use. */
export function normalizeFolderName(raw: string): string {
	return raw.replace(/\/+$/, "");
}
