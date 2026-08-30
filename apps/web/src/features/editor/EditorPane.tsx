import Editor, { type OnMount } from "@monaco-editor/react";
import type React from "react";
import type * as MonacoApi from "monaco-editor";

import { EditorChrome } from "../../app/EditorChrome.js";
import { defineEditorThemes } from "./theme.js";
import { registerAllLanguages } from "./languagePacks.js";
import { fontStack } from "../../shared/lib/fonts.js";
import type { Appearance } from "../../shared/stores/appearance.js";
import type { Palette } from "../../shared/lib/themes.js";

interface EditorPaneProps {
	/** Everything the toolbar row above the editor needs. */
	chrome: React.ComponentProps<typeof EditorChrome> | undefined;
	appearance: Appearance;
	palette: Palette;
	zen: boolean;
	path: string;
	language: string;
	value: string;
	onMount: OnMount;
	onChange: (value: string | undefined) => void;
}

/**
 * The editor itself, and the toolbar row above it.
 *
 * Monaco's options are typography, and typography is appearance — deriving
 * them here keeps the shell from restating the font stack and the line
 * height it has no other use for. `chrome` is undefined when the toolbar is
 * hidden, which is one flag rather than the two the shell used to combine.
 */
export function EditorPane(props: EditorPaneProps): React.JSX.Element {
	const { appearance, palette, zen } = props;
	const options: MonacoApi.editor.IStandaloneEditorConstructionOptions = {
		automaticLayout: true,
		fontFamily: fontStack(appearance.font),
		fontLigatures: true,
		fontSize: appearance.fontSize,
		glyphMargin: true,
		inlineSuggest: { enabled: true },
		lineHeight: appearance.fontSize + 11,
		suggestFontSize: appearance.fontSize,
		suggestLineHeight: appearance.fontSize + 11,
		minimap: { enabled: false },
		overviewRulerBorder: false,
		padding: { top: 14 },
		renderLineHighlight: "none",
		scrollBeyondLastLine: false,
	};
	return (
		<section className="editor-card">
			{props.chrome && <EditorChrome {...props.chrome} />}
			<div className="editor-wrap">
				<Editor
					height="100%"
					path={props.path}
					language={props.language}
					value={props.value}
					theme={zen ? "atomis-zen" : "atomis-dark"}
					beforeMount={(monaco) => {
						registerAllLanguages(monaco);
						defineEditorThemes(monaco, palette);
					}}
					onMount={props.onMount}
					onChange={props.onChange}
					options={options}
				/>
			</div>
		</section>
	);
}
