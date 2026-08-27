import { useEffect, useState } from "react";

/** Responsive breakpoints: narrow docks the terminal below, tight hides the tree. */
export function useMediaLayout(): { narrow: boolean; tight: boolean } {
	const [narrow, setNarrow] = useState(false);
	const [tight, setTight] = useState(false);
	useEffect(() => {
		const narrowQuery = window.matchMedia("(max-width: 1040px)");
		const tightQuery = window.matchMedia("(max-width: 780px)");
		const update = (): void => {
			setNarrow(narrowQuery.matches);
			setTight(tightQuery.matches);
		};
		update();
		narrowQuery.addEventListener("change", update);
		tightQuery.addEventListener("change", update);
		return () => {
			narrowQuery.removeEventListener("change", update);
			tightQuery.removeEventListener("change", update);
		};
	}, []);
	return { narrow, tight };
}
