import type React from "react";
import type { RunState } from "@atomis/protocol";
import type { FocusZone } from "../state/keyboardNav.js";
import { RUN_STATE_LABELS } from "../state/runSummary.js";
import { Lucide } from "./Lucide.js";

interface StatusBarProps {
	leaderPending: boolean;
	focusZone: FocusZone;
	vimModeLabel: string;
	vimStatusRef: React.RefObject<HTMLDivElement | null>;
	valuesCount: number;
	runState: RunState;
	activePath: string;
	degradedMessages: string[];
	timingLabel: string;
	cursor: { line: number; column: number };
}

/** The global status bar: mode chip (vim/zone/leader), vim command slot,
 * run state, active path, degraded warnings, timings and cursor. */
export function StatusBar(props: StatusBarProps): React.JSX.Element {
	return (
		<footer className="global-status">
			<span
				className={`mode-chip mode-${
					props.leaderPending || props.focusZone !== "editor"
						? "zone"
						: props.vimModeLabel.toLowerCase()
				}`}
			>
				{props.leaderPending
					? "LEADER"
					: props.focusZone === "tree"
						? "ÁRBOL"
						: props.focusZone === "term"
							? "TERMINAL"
							: props.vimModeLabel}
			</span>
			<div className="vim-mode-slot">
				<div className="vim-status" ref={props.vimStatusRef} />
			</div>
			<span className="branch-status">
				⎇ main <b>+{props.valuesCount}</b>
			</span>
			<span className={`run-state state-${props.runState}`}>
				{RUN_STATE_LABELS[props.runState]}
			</span>
			<span className="status-path">src/{props.activePath}</span>
			{props.degradedMessages.length > 0 && (
				<span className="degraded">{props.degradedMessages.join(" · ")}</span>
			)}
			<span className="status-spacer" />
			<span className="status-timing">{props.timingLabel}</span>
			<strong className="cursor-status">
				{props.cursor.line}:{props.cursor.column}
			</strong>
		</footer>
	);
}

interface ZenPillProps {
	tone: string;
	status: string;
	runDisabled: boolean;
	active: boolean;
	onRun: () => void;
	onStop: () => void;
	onExit: () => void;
}

/** Zen mode's floating pill: state dot, summary, Run/Stop and exit. */
export function ZenPill(props: ZenPillProps): React.JSX.Element {
	return (
		<div className="zen-pill">
			<span className={`zen-dot ${props.tone}`} />
			<span className="zen-status">{props.status}</span>
			<button
				className="zen-run"
				disabled={props.runDisabled}
				onClick={props.active ? props.onStop : props.onRun}
			>
				<Lucide icon={props.active ? "square" : "play"} size={12} /> Run
			</button>
			<button className="zen-exit" onClick={props.onExit}>
				salir ⌘.
			</button>
		</div>
	);
}
