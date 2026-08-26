import { randomUUID } from "node:crypto";
import type { RuntimeServerEvent } from "@ziglive/protocol";
import type { Session } from "../sessions/SessionManager.js";
import type { CompilerRunner } from "./CompilerRunner.js";

export class RunScheduler {
	private timer: NodeJS.Timeout | undefined;
	private controller: AbortController | undefined;
	private activeRunId: string | undefined;

	public constructor(
		private readonly session: Session,
		private readonly runner: CompilerRunner,
		private readonly send: (event: RuntimeServerEvent) => void,
	) {}

	public documentUpdated(): void {
		this.cancel("superseded");
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
			void this.run(snapshot.version);
		}, this.session.settings.debounceMs);
	}

	public async run(version: number): Promise<void> {
		const snapshot = this.session.store.current();
		if (snapshot.version !== version) return;
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
			const outcome = await this.runner.run(
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
					output: (stream, chunk, category) => {
						const outputEvent = {
							type: "output",
							documentVersion: version,
							runId,
							category,
							stream,
							chunk,
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
