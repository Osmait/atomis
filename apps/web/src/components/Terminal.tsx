import React, { useState } from "react";
import type { RunResult, TestCase } from "@atomis/protocol";
import { useDismissable } from "../hooks/useDismissable.js";
import type { OwnedDiagnostic } from "../shared/lib/diagnostics.js";
import type { TerminalRow } from "../shared/lib/terminalFolds.js";
import type { LogSourceLocation, TerminalEntry } from "../types.js";
import { Lucide } from "./Lucide.js";

export type TerminalTab = "output" | "problems" | "runtime" | "deps";

interface OutputEntryProps {
	entry: TerminalEntry;
	index: number;
	child?: boolean;
	baseTime: number | undefined;
	entryFile: string;
	onEntryClick: (location: LogSourceLocation) => void;
	onEntryHover: (location?: LogSourceLocation) => void;
	onEntryLeave: () => void;
}

function OutputEntry(props: OutputEntryProps): React.JSX.Element {
	const { entry } = props;
	const location = entry.sourceLocation;
	const originPath = location?.path ?? `src/${props.entryFile}`;
	return (
		<div
			className={`output-entry${location ? " has-source" : ""}${props.child ? " fold-child" : ""}`}
			onClick={() => {
				if (location) props.onEntryClick(location);
			}}
			onKeyDown={(event) => {
				if (location && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault();
					props.onEntryClick(location);
				}
			}}
			onMouseEnter={() => props.onEntryHover(location)}
			onMouseLeave={props.onEntryLeave}
			role={location ? "button" : undefined}
			tabIndex={location ? 0 : undefined}
			title={
				location
					? `Emitted by ${originPath}:${location.line}:${location.column} · execution #${location.executionIndex}`
					: undefined
			}
		>
			<span className="output-chevron">›</span>
			<pre className={entry.category}>{entry.chunk}</pre>
			<time>
				{((entry.receivedAt - (props.baseTime ?? entry.receivedAt)) / 1000).toFixed(3)}
				s
			</time>
			{location && (
				<span className="log-origin-tooltip">
					↳ {originPath}:{location.line}:{location.column} · execution #
					{location.executionIndex}
					{location.loop && (
						<>
							{" "}
							· loop {location.loop.line}:{location.loop.column} ·{" "}
							<b>
								{location.loop.variable}={location.loop.value}
							</b>
						</>
					)}
				</span>
			)}
		</div>
	);
}

interface TerminalProps {
	focused: boolean;
	narrow: boolean;
	dockEffective: "right" | "bottom";
	termMax: boolean;
	drawer: boolean;
	tab: TerminalTab;
	onTab: (tab: TerminalTab) => void;
	onDock: (dock: "right" | "bottom") => void;
	onToggleMax: () => void;
	onToggleDrawer: () => void;
	onOpenDrawer: () => void;
	onClearOutput: () => void;
	onCloseTerm: () => void;
	termTone: string;
	runCommand: string;
	testCommand: string;
	output: TerminalEntry[];
	outputRows: TerminalRow[];
	openFolds: Set<string>;
	onToggleFold: (key: string) => void;
	entryFile: string;
	busy: boolean;
	active: boolean;
	stageLabel: string;
	allProblems: OwnedDiagnostic[];
	onProblemJump: (item: OwnedDiagnostic) => void;
	onEntryClick: (location: LogSourceLocation) => void;
	onEntryHover: (location?: LogSourceLocation) => void;
	onEntryLeave: () => void;
	runStateLabel: string;
	result?: RunResult;
	probesLabel: string;
	testsLabel: string;
	toolchainLabel: string;
	lspLabel: string;
	testsTone: string;
	drawerScore: string;
	tests: TestCase[];
	caseTone: (testId: string) => string;
	depsPanel: React.ReactNode;
	depsCount: number;
	depsBusy: boolean;
	children?: React.ReactNode;
}

/** The dockable terminal: Salida/Problems/Runtime views behind the ⋮ menu,
 * log provenance hover/click, collapsible folds, and the slim tests bar that
 * expands into the drawer (passed as children). */
export function Terminal(props: TerminalProps): React.JSX.Element {
	const [menuOpen, setMenuOpen] = useState(false);
	useDismissable(menuOpen, ".term-menu-wrap", () => setMenuOpen(false));
	const { tab, allProblems } = props;
	const entryProps = {
		baseTime: props.output[0]?.receivedAt,
		entryFile: props.entryFile,
		onEntryClick: props.onEntryClick,
		onEntryHover: props.onEntryHover,
		onEntryLeave: props.onEntryLeave,
	};
	return (
		<section className={`side-panel${props.focused ? " kb-zone" : ""}`}>
			<header className="pane-header terminal-header">
				<span className={`run-dot ${props.termTone}`} />
				{tab !== "output" && (
					<span className="term-view-label">
						{tab === "problems"
							? `Problems${allProblems.length ? ` ${allProblems.length}` : ""}`
							: tab === "deps"
								? `Dependencies${props.depsCount ? ` ${props.depsCount}` : ""}`
								: "Runtime"}
					</span>
				)}
				<span className="term-menu-wrap">
					<button
						aria-label="Terminal options"
						className={`term-menu-btn${menuOpen ? " open" : ""}`}
						onClick={() => setMenuOpen((previous) => !previous)}
					>
						<Lucide icon="ellipsis-vertical" size={15} />
					</button>
					{menuOpen && (
						<div className="term-menu" role="menu">
							{!props.narrow && (
								<>
									<button
										className={
											props.dockEffective === "right" && !props.termMax
												? "on"
												: ""
										}
										onClick={() => {
											props.onDock("right");
											setMenuOpen(false);
										}}
										role="menuitem"
									>
										<Lucide icon="panel-right" size={13} />
										<span>Dock right</span>
									</button>
									<button
										className={
											props.dockEffective === "bottom" && !props.termMax
												? "on"
												: ""
										}
										onClick={() => {
											props.onDock("bottom");
											setMenuOpen(false);
										}}
										role="menuitem"
									>
										<Lucide icon="panel-bottom" size={13} />
										<span>Dock bottom</span>
									</button>
								</>
							)}
							<button
								className={props.termMax ? "on" : ""}
								onClick={() => {
									props.onToggleMax();
									setMenuOpen(false);
								}}
								role="menuitem"
							>
								<Lucide
									icon={props.termMax ? "minimize-2" : "maximize-2"}
									size={13}
								/>
								<span>
									{props.termMax ? "Restore size" : "Maximize"}
								</span>
							</button>
							<button
								className={props.drawer ? "on" : ""}
								onClick={() => {
									props.onToggleDrawer();
									setMenuOpen(false);
								}}
								role="menuitem"
							>
								<Lucide icon="flask-conical" size={13} />
								<span>{props.drawer ? "Hide tests" : "Show tests"}</span>
								<b>⌘T</b>
							</button>
							<span className="term-menu-sep" />
							<button
								className={tab === "output" ? "on" : ""}
								onClick={() => {
									props.onTab("output");
									setMenuOpen(false);
								}}
								role="menuitem"
							>
								<Lucide icon="terminal" size={13} />
								<span>Output</span>
							</button>
							<button
								aria-label={`Problems (${allProblems.length})`}
								className={tab === "problems" ? "on" : ""}
								onClick={() => {
									props.onTab("problems");
									setMenuOpen(false);
								}}
								role="menuitem"
							>
								<Lucide icon="triangle-alert" size={13} />
								<span>
									Problems
									{allProblems.length ? ` ${allProblems.length}` : ""}
								</span>
							</button>
							<button
								className={tab === "runtime" ? "on" : ""}
								onClick={() => {
									props.onTab("runtime");
									setMenuOpen(false);
								}}
								role="menuitem"
							>
								<Lucide icon="activity" size={13} />
								<span>Runtime</span>
							</button>
							<button
								className={tab === "deps" ? "on" : ""}
								onClick={() => {
									props.onTab("deps");
									setMenuOpen(false);
								}}
								role="menuitem"
							>
								<Lucide icon="package" size={13} />
								<span>
									Dependencies
									{props.depsCount ? ` ${props.depsCount}` : ""}
								</span>
								{props.depsBusy && <b className="spin">⟳</b>}
							</button>
							<span className="term-menu-sep" />
							<button
								onClick={() => {
									props.onClearOutput();
									setMenuOpen(false);
								}}
								role="menuitem"
							>
								<Lucide icon="eraser" size={13} />
								<span>Clear output</span>
							</button>
							<button
								onClick={() => {
									props.onCloseTerm();
									setMenuOpen(false);
								}}
								role="menuitem"
							>
								<Lucide icon="x" size={13} />
								<span>Close terminal</span>
								<b>⌘J</b>
							</button>
						</div>
					)}
				</span>
			</header>

			<div className="panel-content">
				{tab === "output" && (
					<div className={`output-list${props.drawer ? " dimmed" : ""}`}>
						<div className="terminal-command">
							<b>$</b> {props.runCommand}
							{props.tests.length
								? ` · ${props.testCommand} (${props.tests.length})`
								: ""}
						</div>
						{props.outputRows.map((row) =>
							row.kind === "line" ? (
								<OutputEntry
									entry={row.entry}
									index={row.index}
									key={row.index}
									{...entryProps}
								/>
							) : (
								<div className="fold-group" key={row.key}>
									<button
										className="fold-row"
										onClick={() => props.onToggleFold(row.key)}
									>
										<span>
											{props.openFolds.has(row.key) ? "▾" : "▸"} {row.label}{" "}
											({row.entries.length} lines)
										</span>
										<b>
											{props.openFolds.has(row.key) ? "hide" : "show"}
										</b>
									</button>
									{props.openFolds.has(row.key) &&
										row.entries.map((grouped) => (
											<OutputEntry
												child
												entry={grouped.entry}
												index={grouped.index}
												key={grouped.index}
												{...entryProps}
											/>
										))}
								</div>
							),
						)}
						{!props.output.length && !props.busy && (
							<p className="empty-state">Output will show up here.</p>
						)}
						{props.active && (
							<div className="run-stage">
								<span className="spin">⟳</span> {props.stageLabel}
							</div>
						)}
					</div>
				)}
				{tab === "problems" && (
					<ul className="problems-list">
						{allProblems.length ? (
							allProblems.map((item, index) => (
								<li
									className={`problem problem-${item.severity}`}
									key={`${item.owner}-${index}`}
								>
									<button onClick={() => props.onProblemJump(item)}>
										<i>{item.severity === "error" ? "×" : "△"}</i>
										<span>{item.message}</span>
										<small>
											{item.path ?? `src/${props.entryFile}`} · {item.owner} ·
											Ln {item.line}, Col {item.column}
										</small>
									</button>
								</li>
							))
						) : (
							<li className="empty-state">No diagnostics.</li>
						)}
					</ul>
				)}
				{tab === "deps" && props.depsPanel}
				{tab === "runtime" && (
					<div className="runtime-grid">
						<span>State</span>
						<b>{props.runStateLabel}</b>
						<span>Exit code</span>
						<b>{props.result?.exitCode ?? "—"}</b>
						<span>Signal</span>
						<b>{props.result?.signal ?? "—"}</b>
						<span>Timeout</span>
						<b>{props.result?.timedOut ? "yes" : "no"}</b>
						<span>Probes / values</span>
						<b>{props.probesLabel}</b>
						<span>Tests</span>
						<b>{props.testsLabel}</b>
						<span>Toolchain</span>
						<b>{props.toolchainLabel}</b>
						<span>LSP</span>
						<b className="capabilities">{props.lspLabel}</b>
					</div>
				)}
			</div>

			{tab === "output" && !props.drawer && (
				<button
					className="test-bar"
					onClick={props.onOpenDrawer}
					title="Show tests (⌘T)"
				>
					<Lucide icon="chevron-up" size={13} />
					<span className="test-bar-label">
						<span className={`run-dot ${props.testsTone}`} />
						Tests
					</span>
					<span className="case-bars">
						{props.tests.slice(0, 24).map((test) => (
							<span
								className={`case-bar ${props.caseTone(test.testId)}`}
								key={test.testId}
							/>
						))}
					</span>
					<b className={`test-score ${props.testsTone}`}>
						{props.drawerScore}
					</b>
					<span className="test-bar-kbd">⌘T</span>
				</button>
			)}

			{tab === "output" && props.drawer && props.children}
		</section>
	);
}
