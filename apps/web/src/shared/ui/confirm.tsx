import type React from "react";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Lucide } from "./Lucide.js";

export interface ConfirmOptions {
	title: string;
	/** What will happen, said once — the title already names the action. */
	message?: string;
	/** The confirm button's label: the verb, never a bare "OK". */
	confirmLabel: string;
	/** Red confirm button and a warning glyph. Defaults to true: every
	 * confirmation the app asks for today loses work if it goes through. */
	destructive?: boolean;
}

interface Request extends ConfirmOptions {
	/** Keys the dialog, so a new request remounts it and focus starts over. */
	id: number;
	/** Where focus was when asked — usually the editor — to go back to. */
	returnFocus: HTMLElement | undefined;
	resolve: (confirmed: boolean) => void;
}

/*
 * One dialog at a time, held outside React: the actions that ask live in
 * hooks the shell itself calls, which sit above any provider the shell
 * could render, so they reach the dialog the way they reached
 * window.confirm — by calling a function.
 */
let current: Request | undefined;
let lastId = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function publish(next: Request | undefined): void {
	current = next;
	for (const listener of listeners) listener();
}

/**
 * Asks before a destructive action, in the app's own dialog instead of the
 * browser's: window.confirm cannot be styled, blocks the page, and some
 * hosts (an iOS home-screen app, a dismissed "prevent more dialogs") make it
 * return false without showing anything — the action then just did nothing.
 *
 * Resolves true only on the confirm button. A second request while one is
 * open cancels the first.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
	current?.resolve(false);
	const focused = document.activeElement;
	const returnFocus = focused instanceof HTMLElement ? focused : undefined;
	return new Promise((resolve) => {
		publish({ ...options, id: ++lastId, returnFocus, resolve });
	});
}

function settle(confirmed: boolean): void {
	const request = current;
	if (!request) return;
	publish(undefined);
	request.resolve(confirmed);
}

/** Renders the pending confirmation, if any. Mount it once, in the shell. */
export function ConfirmHost(): React.JSX.Element | null {
	const request = useSyncExternalStore(subscribe, () => current);
	return request ? <ConfirmDialog key={request.id} request={request} /> : null;
}

function ConfirmDialog({ request }: { request: Request }): React.JSX.Element {
	const id = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const destructive = request.destructive ?? true;

	// Focus goes back once answered. Read when asked, not here: autoFocus
	// has already moved it to the dialog by the time an effect runs.
	useEffect(() => {
		const { returnFocus } = request;
		return () => returnFocus?.focus();
	}, [request]);

	// Capture phase, so the dialog answers Escape before whatever is under
	// it does: the workspace switcher would otherwise close on the same key.
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				settle(false);
			} else if (event.key === "Tab") {
				// Two buttons: Tab stays between them rather than walking
				// into the page behind the backdrop.
				const buttons = dialogRef.current?.querySelectorAll("button");
				if (!buttons?.length) return;
				event.preventDefault();
				const list = [...buttons];
				const index = list.indexOf(document.activeElement as HTMLButtonElement);
				const step = event.shiftKey ? -1 : 1;
				list[(index + step + list.length) % list.length]?.focus();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);

	return (
		<div
			className="palette-overlay confirm-overlay"
			onClick={() => settle(false)}
			role="presentation"
		>
			<div
				aria-describedby={request.message ? `${id}-message` : undefined}
				aria-labelledby={`${id}-title`}
				aria-modal="true"
				className="palette confirm-dialog"
				onClick={(event) => event.stopPropagation()}
				ref={dialogRef}
				role="alertdialog"
			>
				<div className="confirm-body">
					{destructive && (
						<span className="confirm-glyph">
							<Lucide icon="triangle-alert" size={16} />
						</span>
					)}
					<div>
						<h2 id={`${id}-title`}>{request.title}</h2>
						{request.message && <p id={`${id}-message`}>{request.message}</p>}
					</div>
				</div>
				<footer className="confirm-actions">
					<button className="confirm-cancel" onClick={() => settle(false)}>
						Cancel
					</button>
					<button
						autoFocus
						className={`confirm-ok${destructive ? " danger" : ""}`}
						onClick={() => settle(true)}
					>
						{request.confirmLabel}
					</button>
				</footer>
			</div>
		</div>
	);
}
