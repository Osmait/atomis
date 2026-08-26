import type { IncomingMessage } from "node:http";

export function validOrigin(
	request: IncomingMessage,
	serverPort: number,
): boolean {
	const origin = request.headers.origin;
	if (!origin) return false;
	const allowed = new Set([
		`http://127.0.0.1:${serverPort}`,
		...(process.env.NODE_ENV !== "production" ? ["http://127.0.0.1:5173"] : []),
	]);
	return allowed.has(origin);
}
