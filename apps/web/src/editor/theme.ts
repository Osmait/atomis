import type * as Monaco from "monaco-editor";
import type { Palette } from "../state/themes.js";

/**
 * The editor's theme, generated from the same palette that paints the rest
 * of the window. Monaco wants token colours without the leading `#` and
 * workbench colours with it, which is the only reason for the two shapes.
 */

/** Monaco token rules want a bare hex. */
function bare(color: string): string {
	return color.replace("#", "");
}

function tokenRules(palette: Palette): Monaco.editor.ITokenThemeRule[] {
	return [
		{ token: "keyword", foreground: bare(palette.mauve), fontStyle: "bold" },
		{ token: "type", foreground: bare(palette.yellow) },
		{ token: "predefined", foreground: bare(palette.peach) },
		{ token: "string", foreground: bare(palette.green) },
		{ token: "string.escape", foreground: bare(palette.pink) },
		{ token: "number", foreground: bare(palette.peach) },
		{
			token: "comment",
			foreground: bare(palette.overlayDim),
			fontStyle: "italic",
		},
		{
			token: "comment.doc",
			foreground: bare(palette.overlay),
			fontStyle: "italic",
		},
		{ token: "operator", foreground: bare(palette.sky) },
	];
}

function workbenchColors(
	palette: Palette,
	background: string,
): Record<string, string> {
	return {
		"editor.background": background,
		"editor.foreground": palette.text,
		"editorCursor.foreground": palette.mauve,
		"editorLineNumber.foreground": palette.dim,
		"editorLineNumber.activeForeground": palette.text,
		"editor.selectionBackground": palette.surface1,
		"editor.inactiveSelectionBackground": palette.surface0,
		"editorIndentGuide.background1": palette.surface0,
		"editorIndentGuide.activeBackground1": palette.surface1,
		"editorWhitespace.foreground": palette.surface0,
		"editorError.foreground": palette.red,
		"editorWarning.foreground": palette.yellow,
		"editorInfo.foreground": palette.blue,
		"editorOverviewRuler.border": "#00000000",
		"editorSuggestWidget.background": palette.mantle,
		"editorSuggestWidget.border": palette.surface0,
		"editorSuggestWidget.foreground": palette.text,
		"editorSuggestWidget.selectedBackground": palette.surface0,
		"editorSuggestWidget.selectedForeground": palette.peach,
		"editorSuggestWidget.selectedIconForeground": palette.peach,
		"editorSuggestWidget.highlightForeground": palette.mauve,
		"editorSuggestWidget.focusHighlightForeground": palette.peach,
		"editorSuggestWidgetStatus.foreground": palette.overlayDim,
		"symbolIcon.functionForeground": palette.blue,
		"symbolIcon.methodForeground": palette.blue,
		"symbolIcon.constructorForeground": palette.blue,
		"symbolIcon.classForeground": palette.yellow,
		"symbolIcon.structForeground": palette.yellow,
		"symbolIcon.interfaceForeground": palette.yellow,
		"symbolIcon.moduleForeground": palette.yellow,
		"symbolIcon.namespaceForeground": palette.yellow,
		"symbolIcon.enumeratorForeground": palette.yellow,
		"symbolIcon.enumeratorMemberForeground": palette.teal,
		"symbolIcon.variableForeground": palette.text,
		"symbolIcon.fieldForeground": palette.teal,
		"symbolIcon.propertyForeground": palette.teal,
		"symbolIcon.constantForeground": palette.peach,
		"symbolIcon.keywordForeground": palette.mauve,
		"symbolIcon.snippetForeground": palette.green,
		"symbolIcon.textForeground": palette.subtext,
		"symbolIcon.fileForeground": palette.subtext,
		"symbolIcon.folderForeground": palette.subtext,
		"symbolIcon.typeParameterForeground": palette.yellow,
		"symbolIcon.operatorForeground": palette.teal,
		"symbolIcon.referenceForeground": palette.subtext,
		"symbolIcon.unitForeground": palette.peach,
		"symbolIcon.valueForeground": palette.peach,
		"symbolIcon.eventForeground": palette.peach,
		"editorHoverWidget.background": palette.mantle,
		"editorHoverWidget.border": palette.surface0,
		"editorGutter.background": background,
		"scrollbarSlider.background": `${palette.surface0}88`,
		"scrollbarSlider.hoverBackground": `${palette.surface1}88`,
		"scrollbarSlider.activeBackground": `${palette.surface1}aa`,
	};
}

/**
 * (Re)defines both editor themes. Monaco replaces a theme defined twice
 * under the same name, so calling this again is how a theme change reaches
 * an editor that is already on screen — followed by `setTheme` to repaint.
 */
export function defineEditorThemes(
	monaco: typeof Monaco,
	palette: Palette,
): void {
	const base = palette.scheme === "light" ? "vs" : "vs-dark";
	const rules = tokenRules(palette);
	monaco.editor.defineTheme("atomis-dark", {
		base,
		inherit: true,
		rules,
		colors: workbenchColors(palette, palette.panelEditor ?? palette.surface),
	});
	// Zen drops the editor onto the surrounding panel colour.
	monaco.editor.defineTheme("atomis-zen", {
		base,
		inherit: true,
		rules,
		colors: workbenchColors(palette, palette.panelSide ?? palette.mantle),
	});
}
