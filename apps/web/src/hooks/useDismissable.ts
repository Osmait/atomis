import { useEffect } from "react";

/**
 * Closes a menu/popover on any pointer press outside `containSelector` or on
 * Escape — the shared dismiss behaviour of every dropdown and context menu.
 */
export function useDismissable(
	open: boolean,
	containSelector: string,
	close: () => void,
): void {
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent): void => {
			if (
				event.target instanceof Element &&
				event.target.closest(containSelector)
			)
				return;
			close();
		};
		const onEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("pointerdown", onPointer);
		window.addEventListener("keydown", onEscape);
		return () => {
			window.removeEventListener("pointerdown", onPointer);
			window.removeEventListener("keydown", onEscape);
		};
	}, [open, containSelector, close]);
}
