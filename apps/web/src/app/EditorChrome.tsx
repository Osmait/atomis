import type React from "react";
import { FileIcon } from "../features/files/FileIcon.js";
import { Lucide } from "../shared/ui/Lucide.js";

interface EditorChromeProps {
	openTabs: string[];
	activePath: string;
	/** False hides the whole tab strip — one file needs no tab to pick it. */
	showTabs: boolean;
	stale: boolean;
	showTreeRestore: boolean;
	autoRun: boolean;
	runDisabled: boolean;
	active: boolean;
	onShowTree: () => void;
	onSelect: (path: string) => void;
	onCloseTab: (path: string) => void;
	onOpenPalette: () => void;
	onToggleAutoRun: () => void;
	onOpenSettings: () => void;
	onRun: () => void;
	onStop: () => void;
}

/** The editor's chrome row: buffer tabs with close buttons, the auto-run
 * toggle, the settings gear and the Run/Stop button. */
export function EditorChrome(props: EditorChromeProps): React.JSX.Element {
	return (
		<div className="editor-chrome">
			{props.showTreeRestore && (
				<button
					className="tree-restore"
					onClick={props.onShowTree}
					title="Show tree (⌘B)"
				>
					<Lucide icon="panel-left" size={14} />
				</button>
			)}
			{props.showTabs && (
				<div className="tab-pill" role="tablist">
					{props.openTabs.map((path) => (
						<div
							className={`buffer-tab${path === props.activePath ? " active" : ""}`}
							key={path}
							onClick={() => props.onSelect(path)}
							onKeyDown={(event) => {
								if (event.key === "Enter") props.onSelect(path);
							}}
							role="tab"
							aria-selected={path === props.activePath}
							tabIndex={0}
						>
							<FileIcon path={path} />
							<span>{path}</span>
							{props.stale && path === props.activePath && (
								<em className="stale-dot" />
							)}
							<span
								className="tab-close"
								onClick={(event) => {
									event.stopPropagation();
									props.onCloseTab(path);
								}}
								role="button"
								tabIndex={-1}
								title="Close tab"
							>
								✕
							</span>
						</div>
					))}
					<button
						className="tab-add"
						onClick={props.onOpenPalette}
						title="Find file (⌘K)"
					>
						+
					</button>
				</div>
			)}
			<div className="chrome-right">
				<button
					className={`auto-text${props.autoRun ? " on" : ""}`}
					disabled={props.runDisabled}
					onClick={props.onToggleAutoRun}
					title={
						props.autoRun
							? "Auto Run on — click to pause"
							: "Auto Run paused — click to enable"
					}
				>
					auto
				</button>
				<button
					className="chrome-icon"
					onClick={props.onOpenSettings}
					title="Settings (⌘,)"
				>
					<Lucide icon="settings" size={14} />
				</button>
				<button
					aria-label={props.active ? "Stop" : "Run"}
					className={`run-button${props.active ? " running" : ""}`}
					disabled={props.runDisabled}
					onClick={props.active ? props.onStop : props.onRun}
					title={props.active ? "Stop" : "Run (⌘↵)"}
				>
					{props.active ? (
						<span className="spin">⟳</span>
					) : (
						<Lucide icon="play" size={13} />
					)}
				</button>
			</div>
		</div>
	);
}
