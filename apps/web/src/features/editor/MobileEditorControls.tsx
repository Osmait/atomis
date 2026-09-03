import { useState } from "react";
import type React from "react";
import type * as MonacoApi from "monaco-editor";

import { Lucide, type LucideIcon } from "../../shared/ui/Lucide.js";

export interface MobileEditorControlsProps {
	editorRef: React.RefObject<
		MonacoApi.editor.IStandaloneCodeEditor | undefined
	>;
	running: boolean;
	runDisabled: boolean;
	onEscape: () => void;
	onRun: () => void;
	onStop: () => void;
	onToggleFiles: () => void;
	onToggleTerminal: () => void;
	onOpenCommands: () => void;
	onOpenSettings: () => void;
}

interface ActionKeyProps {
	label: string;
	shortLabel?: string;
	icon?: LucideIcon;
	active?: boolean;
	disabled?: boolean;
	onPress: () => void;
}

function ActionKey(props: ActionKeyProps): React.JSX.Element {
	return (
		<button
			aria-label={props.label}
			aria-pressed={props.active || undefined}
			className={`mobile-key${props.active ? " active" : ""}${props.icon ? " action" : ""}`}
			disabled={props.disabled}
			onClick={props.onPress}
			tabIndex={-1}
			type="button"
		>
			{props.icon && <Lucide icon={props.icon} size={15} />}
			<span>{props.shortLabel ?? props.label}</span>
		</button>
	);
}

/**
 * A software-keyboard accessory for touch devices. Mobile keyboards omit
 * desktop modifiers and navigation keys, so Ctrl becomes a one-tap layer
 * containing Atomis' existing app commands instead of trying to synthesize
 * browser key events that iOS and Android handle inconsistently.
 */
export function MobileEditorControls(
	props: MobileEditorControlsProps,
): React.JSX.Element {
	const [ctrlLayer, setCtrlLayer] = useState(false);

	const editorCommand = (command: string): void => {
		const editor = props.editorRef.current;
		if (!editor) return;
		editor.focus();
		editor.trigger("mobile-keyboard", command, null);
	};
	const appCommand = (action: () => void): void => {
		setCtrlLayer(false);
		action();
	};

	return (
		<div
			aria-label="Mobile editor controls"
			className="mobile-editor-controls"
			onMouseDown={(event) => event.preventDefault()}
			role="toolbar"
		>
			{ctrlLayer ? (
				<>
					<ActionKey
						active
						label="Close Ctrl commands"
						onPress={() => setCtrlLayer(false)}
						shortLabel="Ctrl"
					/>
					<ActionKey
						disabled={props.runDisabled}
						icon={props.running ? "square" : "play"}
						label={props.running ? "Stop" : "Run"}
						onPress={() =>
							appCommand(props.running ? props.onStop : props.onRun)
						}
					/>
					<ActionKey
						icon="panel-left"
						label="Files"
						onPress={() => appCommand(props.onToggleFiles)}
					/>
					<ActionKey
						icon="terminal"
						label="Terminal"
						onPress={() => appCommand(props.onToggleTerminal)}
					/>
					<ActionKey
						icon="search"
						label="Commands"
						onPress={() => appCommand(props.onOpenCommands)}
					/>
					<ActionKey
						icon="settings"
						label="Settings"
						onPress={() => appCommand(props.onOpenSettings)}
					/>
				</>
			) : (
				<>
					<ActionKey label="Escape" onPress={props.onEscape} shortLabel="Esc" />
					<ActionKey
						label="Open Ctrl commands"
						onPress={() => setCtrlLayer(true)}
						shortLabel="Ctrl"
					/>
					<ActionKey label="Tab" onPress={() => editorCommand("tab")} />
					<ActionKey
						icon="chevron-left"
						label="Move cursor left"
						onPress={() => editorCommand("cursorLeft")}
						shortLabel=""
					/>
					<ActionKey
						icon="chevron-up"
						label="Move cursor up"
						onPress={() => editorCommand("cursorUp")}
						shortLabel=""
					/>
					<ActionKey
						icon="chevron-down"
						label="Move cursor down"
						onPress={() => editorCommand("cursorDown")}
						shortLabel=""
					/>
					<ActionKey
						icon="chevron-right"
						label="Move cursor right"
						onPress={() => editorCommand("cursorRight")}
						shortLabel=""
					/>
				</>
			)}
		</div>
	);
}
