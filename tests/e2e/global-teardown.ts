import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { FullConfig } from "@playwright/test";

/**
 * Deletes the per-run data directory (preferences file + workspaces) the
 * config pointed the webServer at. The directory is unique to this run —
 * pid + timestamp — so deleting it can never touch another run's state,
 * let alone the developer's; the name check makes that a hard guarantee
 * even if the env var ever points somewhere unexpected.
 */
export default async function globalTeardown(config: FullConfig): Promise<void> {
	const workspaces = config.webServer?.env?.ATOMIS_WORKSPACES;
	if (!workspaces) return;
	const dataDir = dirname(workspaces);
	if (!basename(dataDir).startsWith("atomis-e2e-")) return;
	await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
