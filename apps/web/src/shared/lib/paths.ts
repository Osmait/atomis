/**
 * Project path rules shared by file creation, folder creation and rename:
 * relative, backslash-free, no empty/`.`/`..` segments — mirroring the
 * server-side validation so invalid names fail inline in the tree.
 */
export function isValidProjectPath(path: string): boolean {
	if (!path || path.startsWith("/") || path.includes("\\")) return false;
	return !path
		.split("/")
		.some((part) => !part || part === "." || part === "..");
}

/** Folder names may be typed with a trailing slash; strip it before use. */
export function normalizeFolderName(raw: string): string {
	return raw.replace(/\/+$/, "");
}
