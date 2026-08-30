import type React from "react";
import type { Language } from "@atomis/protocol";

import { DepsPanel } from "./DepsPanel.js";
import { Terminal } from "./Terminal.js";
import { TestsDrawer } from "./TestsDrawer.js";
import {
	caseTone,
	isActive,
	isBusy,
	RUN_STATE_LABELS,
	stageLabel,
	totalFails,
	drawerScoreLabel,
	drawerSubLabel,
	termTone,
	testsTone,
} from "../../shared/lib/runSummary.js";
import { groupOutput } from "../../shared/lib/terminalFolds.js";
import type { useRuntimeEvents } from "../runtime/useRuntimeEvents.js";
import type { OwnedDiagnostic } from "../../shared/lib/diagnostics.js";
import type { TerminalTab } from "./Terminal.js";
import type { WebLanguagePack } from "../editor/languagePacks.js";

interface TerminalPaneProps {
	/** The whole runtime hook: output, tests, deps and the run's state. */
	runtime: ReturnType<typeof useRuntimeEvents>;
	allProblems: OwnedDiagnostic[];
	/** Compiler failures per file, which the shell already groups. */
	failsByFile: ReadonlyMap<string, number>;
	activeLanguage: Language;
	activePath: string;
	pack: WebLanguagePack;
	/** What the LSPs report, or the status line while they are quiet. */
	lspLabel: string;
	/** The version of the toolchain that would run this file. */
	toolchainLabel: string;
	entryFile: string;
	casesHintEmpty: string;
	casesHintSource: string;
	dockEffective: "right" | "bottom";
	termMax: boolean;
	narrow: boolean;
	focused: boolean;
	tab: TerminalTab;
	setTab: (tab: TerminalTab) => void;
	drawerTab: "tests" | "hist";
	setDrawerTab: (tab: "tests" | "hist") => void;
	run: () => void;
	jumpToLine: (path: string, line: number, column: number) => void;
	highlightLogSource: React.ComponentProps<typeof Terminal>["onEntryHover"];
	onEntryClick: React.ComponentProps<typeof Terminal>["onEntryClick"];
	onEntryLeave: () => void;
	onClearOutput: () => void;
	onCloseTerm: () => void;
	onDock: (dock: "right" | "bottom") => void;
	onToggleMax: () => void;
	onToggleFold: (key: string) => void;
	onAddDependency: (name: string) => void;
	onRemoveDependency: (name: string) => void;
	onOpenManifest: (manifest: string) => void;
	sandboxed: boolean;
}

/**
 * The docked panel: program output, problems, tests, history and
 * dependencies.
 *
 * Everything the panel says about a run — how output groups into rows, the
 * score in the drawer, the tone of its chips — is derived here. The shell
 * used to compute all of it and hand it straight back down, which is how a
 * component ends up with sixty-five props.
 */
export function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
	const {
		runtime,
		allProblems,
		failsByFile,
		activeLanguage,
		activePath,
		pack,
		lspLabel,
		toolchainLabel,
		entryFile,
		casesHintEmpty,
		casesHintSource,
		dockEffective,
		termMax,
		narrow,
		focused,
		tab,
		setTab,
		drawerTab,
		setDrawerTab,
		run,
		jumpToLine,
		highlightLogSource,
		onEntryClick,
		onEntryLeave,
		onClearOutput,
		onCloseTerm,
		onDock,
		onToggleMax,
		onToggleFold,
		onAddDependency,
		onRemoveDependency,
		onOpenManifest,
		sandboxed,
	} = props;
	const {
		runState,
		catalog,
		values,
		output,
		result,
		tests,
		testResults,
		testSummary,
		history,
		drawer,
		setDrawer,
		deps,
		depsSupported,
		depsManifest,
		depsHint,
		depsUntrusted,
		depsState,
		depsError,
		depsOutput,
		openFolds,
	} = runtime;

	// The same helpers the shell used: `isBusy` is not "not idle" — a failed
	// run is finished — and the failure count comes from the diagnostics the
	// shell already groups by file, not from the test statuses.
	const busy = isBusy(runState);
	const active = isActive(runState);
	const failingCount = totalFails(failsByFile);
	const testsDone = !busy && testSummary !== undefined;

	const outputRows = groupOutput(output);
	const tone = {
		tests: testsTone({ testsDone, testCount: tests.length, failingCount }),
		term: termTone({
			active,
			...(result !== undefined ? { result } : {}),
			failingCount,
		}),
	};
	const drawerScore = drawerScoreLabel({
		testCount: tests.length,
		testsDone,
		failingCount,
	});
	const drawerSub = drawerSubLabel({
		testCount: tests.length,
		testsDone,
		busy,
		failingCount,
		...(result !== undefined ? { executionMs: result.executionMs } : {}),
	});
	const drawerToneFor = (testId: string): string =>
		caseTone(testsDone, testResults.get(testId));

	return (
				<Terminal
					active={active}
					allProblems={allProblems}
					busy={busy}
					caseTone={drawerToneFor}
					dockEffective={dockEffective}
					drawer={drawer}
					drawerScore={drawerScore}
					entryFile={entryFile}
					focused={focused}
					lspLabel={lspLabel}
					narrow={narrow}
					onClearOutput={onClearOutput}
					onCloseTerm={onCloseTerm}
					onDock={onDock}
					onEntryClick={onEntryClick}
					onEntryHover={highlightLogSource}
					onEntryLeave={onEntryLeave}
					onOpenDrawer={() => setDrawer(true)}
					onProblemJump={(item) =>
						jumpToLine(
							item.path ?? `src/${entryFile}`,
							item.line,
							item.column,
						)
					}
					depsBusy={
						depsState === "installing" || depsState === "removing"
					}
					depsCount={deps.length}
					depsPanel={
						<DepsPanel
							dependencies={deps}
							language={activeLanguage}
							onAdd={onAddDependency}
							onOpenManifest={onOpenManifest}
							onRemove={onRemoveDependency}
							output={depsOutput}
							runsUntrustedCode={depsUntrusted}
							sandboxed={sandboxed}
							state={depsState}
							supported={depsSupported}
							{...(depsError ? { error: depsError } : {})}
							{...(depsHint ? { inputHint: depsHint } : {})}
							{...(depsManifest ? { manifest: depsManifest } : {})}
						/>
					}
					onTab={setTab}
					onToggleDrawer={() => setDrawer((previous) => !previous)}
					onToggleFold={onToggleFold}
					onToggleMax={onToggleMax}
					openFolds={openFolds}
					output={output}
					outputRows={outputRows}
					probesLabel={`${catalog.length} / ${values.size}`}
					runCommand={pack.runCommand}
					runStateLabel={RUN_STATE_LABELS[runState]}
					stageLabel={stageLabel(runState, activePath)}
					tab={tab}
					termMax={termMax}
					termTone={tone.term}
					testCommand={pack.testCommand}
					tests={tests}
					testsLabel={
						testSummary
							? `${testSummary.passed} ok · ${testSummary.failed} err · ${testSummary.skipped} skip${testSummary.leaked ? ` · ${testSummary.leaked} leak` : ""}`
							: tests.length
								? `${tests.length} detected`
								: "—"
					}
					testsTone={tone.tests}
					toolchainLabel={toolchainLabel}
					{...(result !== undefined ? { result } : {})}
				>
					<TestsDrawer
						caseTone={drawerToneFor}
						drawerScore={drawerScore}
						drawerSub={drawerSub}
						drawerTab={drawerTab}
						hintEmpty={casesHintEmpty}
						hintSource={casesHintSource}
						history={history}
						onClose={() => setDrawer(false)}
						onDrawerTab={setDrawerTab}
						onJump={(test) => jumpToLine(test.path, test.line, test.column)}
						onRun={run}
						testResults={testResults}
						tests={tests}
						testsTone={tone.tests}
					/>
				</Terminal>
	);
}
