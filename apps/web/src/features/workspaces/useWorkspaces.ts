import { useCallback, useState } from "react";
import type { Language, WorkspaceMeta } from "@atomis/protocol";

import {
	createWorkspace,
	deleteWorkspace,
	listWorkspaces,
	renameWorkspace,
} from "../../shared/stores/workspaces.js";
import { loadScaffold } from "../../shared/stores/settings.js";

interface WorkspacesOptions {
	/** Opening a workspace rebuilds the session, which only the shell can do. */
	switchToWorkspace: (id: string | undefined) => void;
}

/**
 * The workspace picker's own state: the list, whether an action is running,
 * and what went wrong. Every action reports failure the same way, which is
 * the point of routing them all through one wrapper — a create that throws
 * and a delete that throws leave the dialog in the same, usable state.
 *
 * Switching is deliberately not here: it tears down the socket, the language
 * clients and the models, and only the shell holds all three. Neither is
 * whether the dialog is open — that is shell state, like every other modal.
 */
export function useWorkspaces(options: WorkspacesOptions) {
	const { switchToWorkspace } = options;
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	/** Reloads the list, clearing whatever the last failure said. */
	const refresh = useCallback(async (): Promise<void> => {
		setError(undefined);
		try {
			setWorkspaces(await listWorkspaces());
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}, []);

	const run = useCallback(
		async (action: () => Promise<void>): Promise<void> => {
			setBusy(true);
			setError(undefined);
			try {
				await action();
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : String(failure));
			} finally {
				setBusy(false);
			}
		},
		[],
	);

	const create = useCallback(
		(name: string, language: Language): void => {
			void run(async () => {
				const created = await createWorkspace({
					name,
					language,
					scaffold: loadScaffold(),
				});
				switchToWorkspace(created.id);
			});
		},
		[run, switchToWorkspace],
	);

	const remove = useCallback(
		(id: string, isActive: boolean): void => {
			void run(async () => {
				if (!window.confirm("Delete this workspace and every file in it?"))
					return;
				await deleteWorkspace(id);
				// Deleting the one you are in leaves nowhere to be, so drop to a
				// scratch session — which reloads the list anyway.
				if (isActive) switchToWorkspace(undefined);
				else await refresh();
			});
		},
		[refresh, run, switchToWorkspace],
	);

	const rename = useCallback(
		(id: string, name: string): void => {
			void run(async () => {
				await renameWorkspace(id, name);
				await refresh();
			});
		},
		[refresh, run],
	);

	return {
		workspaces,
		workspacesBusy: busy,
		workspaceError: error,
		refreshWorkspaces: refresh,
		createNamedWorkspace: create,
		deleteNamedWorkspace: remove,
		renameNamedWorkspace: rename,
	};
}
