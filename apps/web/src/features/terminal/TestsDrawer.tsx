import type React from "react";
import type { TestCase, TestResultEvent } from "@atomis/protocol";
import {
	FAILING_STATUSES,
	type RunHistoryEntry,
} from "../../shared/lib/runSummary.js";
import { Lucide } from "../../shared/ui/Lucide.js";

interface TestsDrawerProps {
	testsTone: string;
	drawerScore: string;
	drawerSub: string;
	drawerTab: "tests" | "hist";
	onDrawerTab: (tab: "tests" | "hist") => void;
	onClose: () => void;
	tests: TestCase[];
	testResults: Map<string, TestResultEvent>;
	caseTone: (testId: string) => string;
	history: RunHistoryEntry[];
	onJump: (test: TestCase) => void;
	onRun: () => void;
	hintSource: string;
	hintEmpty: string;
}

/** The expanded tests drawer: big score, per-test rows with jump-to-line and
 * failure details, and the last runs under the History tab. */
export function TestsDrawer(props: TestsDrawerProps): React.JSX.Element {
	const { tests, testResults } = props;
	return (
		<div className="tests-drawer">
			<button
				className="drawer-handle"
				onClick={props.onClose}
				title="Hide tests (⌘T)"
			>
				<span />
			</button>
			<div className="drawer-head">
				<b className={`drawer-score ${props.testsTone}`}>
					{props.drawerScore}
				</b>
				<div className="drawer-sub-wrap">
					<span className="drawer-sub">{props.drawerSub}</span>
					<span className="case-bars">
						{tests.slice(0, 24).map((test) => (
							<span
								className={`case-bar ${props.caseTone(test.testId)}`}
								key={test.testId}
							/>
						))}
					</span>
				</div>
				<span className="drawer-tabs">
					<button
						className={props.drawerTab === "tests" ? "active" : ""}
						onClick={() => props.onDrawerTab("tests")}
					>
						Tests
					</button>
					<button
						className={props.drawerTab === "hist" ? "active" : ""}
						onClick={() => props.onDrawerTab("hist")}
					>
						History
					</button>
				</span>
				<button
					className="drawer-close"
					onClick={props.onClose}
					title="Close (⌘T)"
				>
					<Lucide icon="chevron-down" size={14} />
				</button>
			</div>

			{props.drawerTab === "hist" ? (
				<div className="drawer-list history-list">
					{props.history.map((entry) => (
						<div className="history-row" key={entry.n}>
							<Lucide
								icon={entry.ok ? "circle-check" : "circle-x"}
								size={13}
							/>
							<span className={entry.ok ? "ok" : "err"}>#{entry.n}</span>
							<span className="history-ms">{entry.ms}</span>
						</div>
					))}
					{!props.history.length && (
						<div className="empty-state">no runs yet</div>
					)}
				</div>
			) : (
				<div className="drawer-list cases-list">
					{tests.map((test) => {
						const testResult = testResults.get(test.testId);
						const failing =
							testResult && FAILING_STATUSES.has(testResult.status);
						return (
							<div
								className={`case-item${failing ? " failed" : ""}`}
								key={test.testId}
							>
								<button
									className="case-row"
									onClick={() => props.onJump(test)}
								>
									<span
										className={`case-mark${
											testResult
												? failing
													? " err"
													: testResult.status === "passed"
														? " ok"
														: ""
												: ""
										}`}
									>
										<Lucide
											icon={
												!testResult
													? "circle-dashed"
													: failing
														? "circle-x"
														: "circle-check"
											}
											size={14}
										/>
									</span>
									<span className="case-text">
										<span className="case-name">{test.name}</span>
										<span className="case-where">
											{test.path.replace(/^src\//, "")} · L{test.line}
										</span>
									</span>
									<span className="case-meta">
										{testResult && !failing
											? testResult.status === "passed"
												? testResult.durationMs < 0.05
													? "ok"
													: `${testResult.durationMs.toFixed(1)}ms`
												: testResult.status
											: `L${test.line}`}
									</span>
								</button>
								{failing && (
									<div className="case-detail">
										{testResult?.message && (
											<pre className="case-message">
												{testResult.message}
											</pre>
										)}
										<div className="case-actions">
											<button onClick={() => props.onJump(test)}>
												go to L{test.line}
											</button>
											<button onClick={props.onRun}>run tests</button>
										</div>
									</div>
								)}
							</div>
						);
					})}
					{[...testResults.values()]
						.filter((testResult) => !testResult.testId)
						.map((testResult) => (
							<div className="case-item unmatched" key={testResult.name}>
								<span
									className={`case-mark${FAILING_STATUSES.has(testResult.status) ? " err" : " ok"}`}
								>
									<Lucide
										icon={
											FAILING_STATUSES.has(testResult.status)
												? "circle-x"
												: "circle-check"
										}
										size={14}
									/>
								</span>
								<span className="case-name">{testResult.name}</span>
							</div>
						))}
					<div className="cases-hint">
						{tests.length
							? `${props.hintSource} · click to jump to its line`
							: props.hintEmpty}
					</div>
				</div>
			)}
		</div>
	);
}
