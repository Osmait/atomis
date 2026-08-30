import type { Language, WorkspaceMeta } from "@atomis/protocol";
import { apiFetch } from "../api/client.js";
import { readStoredItem, writeStoredItem } from "./storage.js";

/**
 * Persistent workspaces: named project directories the server keeps on
 * disk. The active one is remembered locally so a reload reattaches to the
 * same files instead of starting a throwaway session.
 */
const ACTIVE_KEY = "atomis.workspace.v1";

export function loadActiveWorkspace(): string | undefined {
	// Clearing stores an empty string, which must read back as "none".
	return readStoredItem(ACTIVE_KEY) || undefined;
}

export function saveActiveWorkspace(id: string | undefined): void {
	writeStoredItem(ACTIVE_KEY, id ?? "");
}

async function request<T>(
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await apiFetch(path, {
		...init,
		headers: { "content-type": "application/json", ...init.headers },
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as {
			error?: string;
		};
		throw new Error(body.error ?? `Request failed (${response.status})`);
	}
	return response.status === 204
		? (undefined as T)
		: ((await response.json()) as T);
}

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
	const body = await request<{ workspaces: WorkspaceMeta[] }>(
		"/api/workspaces",
	);
	return body.workspaces;
}

export async function createWorkspace(options: {
	name: string;
	language: Language;
	scaffold: "demo" | "minimal";
}): Promise<WorkspaceMeta> {
	const body = await request<{ workspace: WorkspaceMeta }>("/api/workspaces", {
		method: "POST",
		body: JSON.stringify(options),
	});
	return body.workspace;
}

export async function renameWorkspace(
	id: string,
	name: string,
): Promise<WorkspaceMeta> {
	const body = await request<{ workspace: WorkspaceMeta }>(
		`/api/workspaces/${id}`,
		{ method: "PATCH", body: JSON.stringify({ name }) },
	);
	return body.workspace;
}

export async function deleteWorkspace(id: string): Promise<void> {
	await request<void>(`/api/workspaces/${id}`, { method: "DELETE" });
}
