import type { Monaco } from "@monaco-editor/react";
import type { CreateSessionResponse } from "@atomis/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { defineEditorThemes } from "../editor/theme.js";
import {
	type Appearance,
	loadAppearance,
	saveAppearance,
} from "../../shared/stores/appearance.js";
import { type AppTheme, cssVariables, paletteOf } from "../../shared/lib/themes.js";

interface AppearanceOptions {
	monacoRef: React.RefObject<Monaco | undefined>;
	/** Zen drops the editor onto the surrounding panel colour. */
	zen: boolean;
	/** The editor is rebuilt per session, so its theme is re-applied then. */
	session: CreateSessionResponse | undefined;
}

/**
 * The theme, the typography, and painting the window with them.
 *
 * Hovering a theme in the settings dialog paints everything with it without
 * committing, so the palette on screen is not always the saved one — which
 * is why every consumer reads `palette` and `activeTheme` from here rather
 * than `appearance.theme`.
 */
export function useAppearance(options: AppearanceOptions) {
	const { monacoRef, zen, session } = options;
	const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
	const appearanceRef = useRef(appearance);
	appearanceRef.current = appearance;

	const [previewTheme, setPreviewTheme] = useState<AppTheme>();
	const activeTheme = previewTheme ?? appearance.theme;
	const palette = paletteOf(activeTheme);

	// One place paints the window: the palette becomes the custom properties
	// the stylesheet already reads, so a new theme needs no CSS of its own.
	useEffect(() => {
		const root = document.documentElement;
		for (const [name, value] of Object.entries(cssVariables(palette)))
			root.style.setProperty(name, value);
		root.style.colorScheme = palette.scheme;
	}, [palette]);

	useEffect(() => {
		const monaco = monacoRef.current;
		if (!monaco) return;
		// Redefining under the same name is what repaints an editor already
		// on screen; setTheme alone would re-apply the previous colours.
		defineEditorThemes(monaco, palette);
		monaco.editor.setTheme(zen ? "atomis-zen" : "atomis-dark");
	}, [monacoRef, palette, session, zen]);

	const updateAppearance = useCallback((next: Partial<Appearance>): void => {
		setAppearance((previous) => {
			const merged = { ...previous, ...next };
			saveAppearance(merged);
			return merged;
		});
	}, []);

	return {
		appearance,
		appearanceRef,
		setAppearance,
		updateAppearance,
		activeTheme,
		palette,
		previewTheme,
		setPreviewTheme,
	};
}
