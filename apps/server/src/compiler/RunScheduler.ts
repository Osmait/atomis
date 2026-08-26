import { randomUUID } from "node:crypto";
import type { Language, RuntimeServerEvent } from "@ziglive/protocol";
import type { Session } from "../sessions/SessionManager.js";
import type { LanguageRunner } from "./CompilerRunner.js";

export class RunScheduler {
	private timer: NodeJS.Timeout | undefined;
	private controller: AbortController | undefined;
	private activeRunId: string | undefined;
	private lastLanguage: Language;

	public constructor(
		private readonly session: Session,
		private readonly runners: Partial<Record<Language, LanguageRunner>>,
		private readonly send: (event: RuntimeServerEvent) => void,
	) {
		this.lastLanguage = session.language;
	}

	public documentUpdated(language?: Language): void {
		this.cancel("superseded");
		const target = language ?? this.lastLanguage;
		const snapshot = this.session.store.current();
		if (!this.session.settings.autoRun) {
			this.send({
				type: "run.state",
				documentVersion: snapshot.version,
				state: "idle",
			});
			return;
		}
		this.send({
			type: "run.state",
			documentVersion: snapshot.version,
			state: "debouncing",
		});
		this.timer = setTimeout(() => {
			void this.run(snapshot.version, target);
		}, this.session.settings.debounceMs);
	}

	public async run(version: number, language?: Language): Promise<void> {
		const snapshot = this.session.store.current();
		if (snapshot.version !== version) return;
		const target = language ?? this.lastLanguage;
		const runner = this.runners[target];
		if (!runner) {
			this.send({
				type: "server.error",
				recoverable: true,
				message: `No runner available for ${target}`,
			});
			return;
		}
		this.lastLanguage = target;
		this.cancel("new run");
		const runId = randomUUID();
		const controller = new AbortController();
		this.controller = controller;
		this.activeRunId = runId;
		const current = (): boolean =>
			!controller.signal.aborted &&
			this.session.store.current().version === version &&
			this.activeRunId === runId;
		const emit = (event: RuntimeServerEvent): void => {
			if (current()) this.send(event);
		};
		try {
			const outcome = await runner.run(
				this.session,
				snapshot,
				{
					...this.session.settings,
					manualProbeIds: [...this.session.settings.manualProbeIds],
				},
				runId,
				controller.signal,
				{
					state: (state) =>
						emit({ type: "run.state", documentVersion: version, runId, state }),
					catalog: (probes) =>
						emit({ type: "probe.catalog", documentVersion: version, probes }),
					testCatalog: (tests) =>
						emit({ type: "test.catalog", documentVersion: version, tests }),
					testResult: (result) =>
						emit({
							type: "test.result",
							documentVersion: version,
							runId,
							...result,
						}),
					testSummary: (summary) =>
						emit({
							type: "test.summary",
							documentVersion: version,
							runId,
							...summary,
						}),
					output: (stream, chunk, category, sourceLocation) => {
						const outputEvent = {
							type: "output",
							documentVersion: version,
							runId,
							category,
							stream,
							chunk,
							...(sourceLocation ? { sourceLocation } : {}),
						} as const;
						emit(outputEvent);
					},
					diagnostic: (owner, diagnostics) =>
						emit({
							type: "diagnostics",
							documentVersion: version,
							owner,
							diagnostics,
						}),
					probe: (event) =>
						emit({
							...event,
							type: "probe_value",
							sessionId: this.session.id,
							runId,
							documentVersion: version,
							timestamp: Date.now(),
							count: event.count ?? 1,
						}),
				},
			);
			if (!current()) return;
			emit({
				type: "run.state",
				documentVersion: version,
				runId,
				state: outcome.terminalState,
			});
			emit({
				type: "run.finished",
				documentVersion: version,
				runId,
				result: outcome.result,
			});
		} catch (error) {
			if (current())
				this.send({
					type: "server.error",
					recoverable: true,
					message: "Run pipeline failed",
					details:
						error instanceof Error
							? (error.stack ?? error.message)
							: String(error),
				});
		} finally {
			if (this.activeRunId === runId) {
				this.activeRunId = undefined;
				this.controller = undefined;
			}
		}
	}

	public cancel(_reason = "user"): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.controller?.abort();
		this.controller = undefined;
		this.activeRunId = undefined;
	}

	public close(): void {
		this.cancel("session close");
	}
}
