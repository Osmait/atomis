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

/** ws(s) URL for a session endpoint, deriving the scheme from the page. */
export function websocketUrl(
	path: string,
	session: { sessionId: string; authToken: string },
	params: Record<string, string> = {},
	base: string = window.location.href,
): string {
	const url = new URL(path, base);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("sessionId", session.sessionId);
	url.searchParams.set("token", session.authToken);
	for (const [key, value] of Object.entries(params))
		url.searchParams.set(key, value);
	return url.href;
}
