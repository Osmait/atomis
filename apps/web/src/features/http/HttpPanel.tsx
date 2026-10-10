import type React from "react";
import { HTTP_METHODS, type HttpDraft, type HttpExchange, type HttpMethod } from "./httpClient.js";
import { samplePath, type Endpoint } from "./endpoints.js";

interface HttpPanelProps {
	/** Run the program as a server: PORT, a long life, the proxy. */
	serve: boolean;
	onServeChange: (on: boolean) => void;
	/** A server run is running right now. */
	serving: boolean;
	port: number;
	draft: HttpDraft;
	onDraftChange: (draft: HttpDraft) => void;
	onSend: () => void;
	sending: boolean;
	exchange?: HttpExchange;
	history: HttpExchange[];
	onPick: (exchange: HttpExchange) => void;
	/** The routes the source declares. */
	endpoints: Endpoint[];
	/** Shows a route's declaration in the editor. */
	onJump: (file: string, line: number) => void;
}

/** The last answer each route got, by "METHOD /path" as sent. */
function lastAnswers(history: HttpExchange[]): Map<string, HttpExchange> {
	const answers = new Map<string, HttpExchange>();
	for (const exchange of history) {
		const key = `${exchange.request.method} ${exchange.request.path.split("?")[0]}`;
		if (!answers.has(key)) answers.set(key, exchange);
	}
	return answers;
}

function statusTone(status: number | undefined): string {
	if (status === undefined) return "error";
	if (status < 300) return "ok";
	if (status < 400) return "redirect";
	return status < 500 ? "client" : "error";
}

function sizeLabel(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * The HTTP view: run the program as a server and call it — a request
 * builder, the answer, and what was sent before. Requests go through the
 * Atomis proxy to the program's own port, so they work wherever Atomis is
 * reachable, a hosted one included.
 */
export function HttpPanel(props: HttpPanelProps): React.JSX.Element {
	const { draft, exchange } = props;
	const set = (patch: Partial<HttpDraft>): void => props.onDraftChange({ ...draft, ...patch });
	const contentType = exchange?.headers.find(([name]) => name === "content-type")?.[1];
	const answers = lastAnswers(props.history);
	const pick = (endpoint: Endpoint): void =>
		set({
			// ANY: the code accepts whatever method; keep the one chosen.
			method:
				endpoint.method === "ANY" || !HTTP_METHODS.includes(endpoint.method as HttpMethod)
					? draft.method
					: (endpoint.method as HttpMethod),
			path: samplePath(endpoint.path),
		});
	return (
		<div className="http-panel">
			<div className="http-serve">
				<label>
					<input
						checked={props.serve}
						onChange={(event) => props.onServeChange(event.target.checked)}
						type="checkbox"
					/>
					<span>Run as a server</span>
				</label>
				<span className={`http-serve-state${props.serving ? " on" : ""}`}>
					{props.serve
						? props.serving
							? `● serving on PORT ${props.port}`
							: "starting…"
						: "off"}
				</span>
			</div>
			<p className="http-hint">
				{props.serve ? (
					<>
						The program keeps running and listens on <code>PORT</code> ({props.port}) — read it from the
						environment. An edit restarts it; 15 minutes without a request stops it.
					</>
				) : (
					<>
						Turn it on to keep the program running as a server on <code>PORT</code> and call it from
						here.
					</>
				)}
			</p>

			<section aria-label="Endpoints" className="http-endpoints">
				<h4>
					Endpoints{props.endpoints.length ? ` (${props.endpoints.length})` : ""}
				</h4>
				{props.endpoints.length === 0 && (
					<p className="http-hint">
						None found in the code yet — routes like <code>{'app.get("/items")'}</code>,{" "}
						<code>{'@app.route("/items")'}</code> or <code>{'http.HandleFunc("GET /items", …)'}</code>{" "}
						show up here.
					</p>
				)}
				{props.endpoints.map((endpoint) => {
					const answer = answers.get(
						`${endpoint.method === "ANY" ? draft.method : endpoint.method} ${samplePath(endpoint.path)}`,
					);
					return (
						<div className="http-endpoint" key={`${endpoint.method} ${endpoint.path}`}>
							<button
								aria-label={`${endpoint.method} ${endpoint.path}`}
								className="http-endpoint-pick"
								onClick={() => pick(endpoint)}
								type="button"
							>
								<b className={`http-method ${endpoint.method.toLowerCase()}`}>{endpoint.method}</b>
								<span className="http-endpoint-path">{endpoint.path}</span>
								{answer?.status !== undefined && (
									<span className={`http-status ${statusTone(answer.status)}`}>{answer.status}</span>
								)}
							</button>
							<button
								className="http-endpoint-source"
								onClick={() => props.onJump(endpoint.file, endpoint.line)}
								title={`${endpoint.via} · go to ${endpoint.file}:${endpoint.line}`}
								type="button"
							>
								{endpoint.file}:{endpoint.line}
							</button>
						</div>
					);
				})}
			</section>

			<form
				className="http-request"
				onSubmit={(event) => {
					event.preventDefault();
					props.onSend();
				}}
			>
				<select
					aria-label="Method"
					onChange={(event) => set({ method: event.target.value as HttpMethod })}
					value={draft.method}
				>
					{HTTP_METHODS.map((method) => (
						<option key={method}>{method}</option>
					))}
				</select>
				<input
					aria-label="Path"
					autoCapitalize="off"
					autoCorrect="off"
					onChange={(event) => set({ path: event.target.value })}
					onKeyDown={(event) => event.stopPropagation()}
					placeholder="/items?limit=5"
					spellCheck={false}
					value={draft.path}
				/>
				<button disabled={props.sending} type="submit">
					{props.sending ? "…" : "Send"}
				</button>
			</form>
			<details className="http-section">
				<summary>Headers{draft.headers.trim() ? ` (${draft.headers.trim().split("\n").length})` : ""}</summary>
				<textarea
					aria-label="Request headers"
					onChange={(event) => set({ headers: event.target.value })}
					onKeyDown={(event) => event.stopPropagation()}
					placeholder={"Authorization: Bearer …\nAccept: application/json"}
					spellCheck={false}
					value={draft.headers}
				/>
			</details>
			{draft.method !== "GET" && (
				<textarea
					aria-label="Request body"
					className="http-body-input"
					onChange={(event) => set({ body: event.target.value })}
					onKeyDown={(event) => event.stopPropagation()}
					placeholder={'{ "name": "Ada" }'}
					spellCheck={false}
					value={draft.body}
				/>
			)}

			{exchange && (
				<section aria-label="Response" className="http-response">
					{exchange.error ? (
						<p className="http-error" role="alert">
							{exchange.error}
						</p>
					) : (
						<>
							<header>
								<b className={`http-status ${statusTone(exchange.status)}`}>
									{exchange.status} {exchange.statusText}
								</b>
								<span>{exchange.ms} ms</span>
								<span>{sizeLabel(exchange.bytes)}</span>
								{contentType && <span>{contentType.split(";")[0]}</span>}
							</header>
							<pre className="http-response-body">{exchange.body || "(empty body)"}</pre>
							<details className="http-section">
								<summary>Headers ({exchange.headers.length})</summary>
								<ul className="http-headers">
									{exchange.headers.map(([name, value]) => (
										<li key={name}>
											<b>{name}</b>: {value}
										</li>
									))}
								</ul>
							</details>
						</>
					)}
				</section>
			)}

			{props.history.length > 1 && (
				<section aria-label="History" className="http-history">
					<h4>History</h4>
					{props.history.map((past) => (
						<button key={past.id} onClick={() => props.onPick(past)} type="button">
							<b>{past.request.method}</b>
							<span className="http-history-path">{past.request.path}</span>
							<span className={`http-status ${statusTone(past.status)}`}>{past.status ?? "—"}</span>
							<span>{past.ms} ms</span>
						</button>
					))}
				</section>
			)}
		</div>
	);
}
