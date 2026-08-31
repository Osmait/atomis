import type * as Monaco from "monaco-editor";
import {
	answerServerRequest,
	asShape,
	completionInsertText,
	fromMonacoBounds,
	normalizeHoverContents,
	toMonacoPosition,
	toMonacoRange,
	type JsonValue,
	type LspDiagnostic,
	type LspLocation,
	type LspPosition,
	type LspRange,
	type LspTextEdit,
	type RpcMessage,
} from "./protocol.js";

function position(value: LspPosition): Monaco.Position {
	return toMonacoPosition(value) as Monaco.Position;
}
function range(value: LspRange): Monaco.Range {
	return toMonacoRange(value) as Monaco.Range;
}

function completionKind(
	monaco: typeof Monaco,
	kind: number | undefined,
): Monaco.languages.CompletionItemKind {
	const kinds = monaco.languages.CompletionItemKind;
	return (
		[
			kinds.Text,
			kinds.Method,
			kinds.Function,
			kinds.Constructor,
			kinds.Field,
			kinds.Variable,
			kinds.Class,
			kinds.Interface,
			kinds.Module,
			kinds.Property,
			kinds.Unit,
			kinds.Value,
			kinds.Enum,
			kinds.Keyword,
			kinds.Snippet,
			kinds.Color,
			kinds.File,
			kinds.Reference,
			kinds.Folder,
			kinds.EnumMember,
			kinds.Constant,
			kinds.Struct,
			kinds.Event,
			kinds.Operator,
			kinds.TypeParameter,
		][(kind ?? 6) - 1] ?? kinds.Variable
	);
}

/** A request pending longer than this is answered by no one: the server
 * died mid-call, and the promise would otherwise hang forever, stacking
 * every later request behind it. */
const REQUEST_TIMEOUT_MS = 15_000;

export class LspClient {
	private socket: WebSocket | undefined;
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{
			method: string;
			/** Clears the timeout on its way; so does `reject`. */
			resolve: (value: JsonValue | null) => void;
			reject: (reason: Error) => void;
		}
	>();
	private readonly disposables: Monaco.IDisposable[] = [];
	private readonly openedModels = new Map<string, Monaco.editor.ITextModel>();
	private readonly pendingOpens = new Map<string, Monaco.editor.ITextModel>();
	private initialized = false;
	private closed = false;
	private lastVersion = 0;
	/** Last didChange version on the wire; LSP versions must only grow. */
	private sentVersion = 0;
	private capabilities: Record<string, JsonValue> = {};

	/**
	 * Fires once, when the socket closes for good. The owner caches clients
	 * by language; a dead one handed out of that cache answers nothing, so
	 * this is where the owner drops it and lets the next ensure build anew.
	 */
	public onClose: (() => void) | undefined;

	public constructor(
		private readonly monaco: typeof Monaco,
		private readonly model: Monaco.editor.ITextModel,
		private readonly workspaceUri: string,
		private readonly onCapabilities: (
			capabilities: Record<string, JsonValue>,
		) => void,
		private readonly onDiagnostics: (
			uri: string,
			diagnostics: LspDiagnostic[],
		) => void,
		private readonly onStatus: (status: string) => void,
		private readonly languageId: string = "zig",
		private readonly serverName: string = "zls",
	) {}

	public connect(url: string, documentVersion: number): void {
		this.socket = new WebSocket(url);
		this.socket.addEventListener("open", () => {
			void this.initialize(documentVersion);
		});
		this.socket.addEventListener("message", (event) =>
			this.receive(String(event.data)),
		);
		this.socket.addEventListener("close", () => {
			this.onStatus(`${this.serverName} disconnected`);
			this.markClosed();
		});
		this.socket.addEventListener("error", () =>
			this.onStatus(`${this.serverName} unavailable`),
		);
	}

	private async initialize(documentVersion: number): Promise<void> {
		let result: { capabilities: Record<string, JsonValue> } | null = null;
		try {
			result = await this.request<{
				capabilities: Record<string, JsonValue>;
			}>("initialize", {
			processId: null,
			rootUri: this.workspaceUri,
			workspaceFolders: [{ uri: this.workspaceUri, name: "Atomis session" }],
			clientInfo: { name: "Atomis", version: "0.1.0" },
			capabilities: {
				workspace: {
					configuration: true,
					workspaceFolders: true,
					applyEdit: true,
				},
				textDocument: {
					synchronization: { didSave: true, dynamicRegistration: false },
					completion: {
						completionItem: {
							snippetSupport: true,
							documentationFormat: ["markdown", "plaintext"],
						},
					},
					hover: { contentFormat: ["markdown", "plaintext"] },
					definition: {},
					formatting: {},
					codeAction: {
						codeActionLiteralSupport: {
							codeActionKind: { valueSet: ["", "quickfix", "refactor"] },
						},
					},
					semanticTokens: {
						requests: { full: true },
						tokenTypes: [],
						tokenModifiers: [],
						formats: ["relative"],
					},
					inlayHint: { dynamicRegistration: false },
					publishDiagnostics: { relatedInformation: true },
				},
			},
		});
		} catch (error) {
			this.onStatus(
				`Language server initialize failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (!result) return;
		this.capabilities = result.capabilities;
		this.onCapabilities(result.capabilities);
		this.notify("initialized", {});
		this.initialized = true;
		this.open(this.model, documentVersion);
		// Models opened while the socket was still connecting queued up: their
		// didOpen would have been dropped pre-initialize. Send them now.
		const queued = [...this.pendingOpens.values()];
		this.pendingOpens.clear();
		for (const model of queued) this.open(model, this.lastVersion);
		this.registerProviders();
		this.onStatus(`${this.serverName} connected`);
	}

	public open(model: Monaco.editor.ITextModel, version: number): void {
		const uri = model.uri.toString();
		this.lastVersion = Math.max(this.lastVersion, version);
		this.sentVersion = Math.max(this.sentVersion, version);
		if (!this.initialized) {
			// The server ignores anything before initialize completes; queue the
			// model so the real didOpen goes out right after the handshake.
			if (!this.openedModels.has(uri)) this.pendingOpens.set(uri, model);
			return;
		}
		if (this.openedModels.has(uri)) return;
		this.openedModels.set(uri, model);
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: this.languageId,
				version,
				text: model.getValue(),
			},
		});
	}

	public change(
		model: Monaco.editor.ITextModel,
		version: number,
		source: string,
	): void {
		this.open(model, version);
		// Between the socket opening and initialize completing, the didOpen
		// above is only queued — a didChange now would describe a document
		// the server never saw open. The queued didOpen sends the model's
		// current text after the handshake, which already carries this change.
		if (!this.initialized) return;
		// The runtime's document counter usually grows, but a remote edit
		// re-announced to the LSP re-serves the last value; pad the wire
		// version monotonic instead of trusting the caller's.
		this.sentVersion = Math.max(version, this.sentVersion + 1);
		this.notify("textDocument/didChange", {
			textDocument: { uri: model.uri.toString(), version: this.sentVersion },
			contentChanges: [{ text: source }],
		});
	}

	public close(uri: string): void {
		this.pendingOpens.delete(uri);
		if (!this.openedModels.delete(uri)) return;
		this.notify("textDocument/didClose", { textDocument: { uri } });
	}

	private registerProviders(): void {
		const capabilities = this.capabilities;
		if (capabilities.completionProvider)
			this.disposables.push(
				this.monaco.languages.registerCompletionItemProvider(this.languageId, {
					...((
						capabilities.completionProvider as { triggerCharacters?: string[] }
					).triggerCharacters
						? {
								triggerCharacters: (
									capabilities.completionProvider as {
										triggerCharacters: string[];
									}
								).triggerCharacters,
							}
						: {}),
					provideCompletionItems: async (model, at) => {
						let response: { items?: JsonValue[] } | JsonValue[] | null;
						try {
							response = await this.request<
								{ items?: JsonValue[] } | JsonValue[] | null
							>("textDocument/completion", this.documentPosition(model, at));
						} catch (error) {
							this.onStatus(
								`ZLS completion failed: ${error instanceof Error ? error.message : String(error)}`,
							);
							return { suggestions: [] };
						}
						const items = Array.isArray(response)
							? response
							: (response?.items ?? []);
						return {
							suggestions: items.map((raw) => {
								const item = asShape<{
									label: string;
									detail?: string;
									documentation?: string | { value?: string };
									kind?: number;
									insertText?: string;
									insertTextFormat?: number;
									textEdit?: LspTextEdit;
									sortText?: string;
									filterText?: string;
								}>(raw);
								const documentation =
									typeof item.documentation === "string"
										? item.documentation
										: item.documentation?.value;
								return {
									label: item.label,
									detail: item.detail,
									documentation,
									kind: completionKind(this.monaco, item.kind),
									insertText: completionInsertText(item),
									...(item.insertTextFormat === 2
										? {
												insertTextRules:
													this.monaco.languages.CompletionItemInsertTextRule
														.InsertAsSnippet,
											}
										: {}),
									...(item.textEdit
										? { range: range(item.textEdit.range) }
										: {}),
									sortText: item.sortText,
									filterText: item.filterText,
								} as Monaco.languages.CompletionItem;
							}),
						};
					},
				}),
			);

		if (capabilities.hoverProvider)
			this.disposables.push(
				this.monaco.languages.registerHoverProvider(this.languageId, {
					provideHover: async (model, at) => {
						const hover = await this.request<{
							contents?: JsonValue;
							range?: LspRange;
						} | null>("textDocument/hover", this.documentPosition(model, at));
						if (!hover) return null;
						const contents = normalizeHoverContents(hover.contents);
						return {
							contents,
							...(hover.range ? { range: range(hover.range) } : {}),
						};
					},
				}),
			);

		if (capabilities.definitionProvider)
			this.disposables.push(
				this.monaco.languages.registerDefinitionProvider(this.languageId, {
					provideDefinition: async (model, at) => {
						const response = await this.request<LspLocation | LspLocation[] | null>(
							"textDocument/definition",
							this.documentPosition(model, at),
						);
						if (!response) return [];
						return (Array.isArray(response) ? response : [response]).map(
							(item) => ({
								uri: this.monaco.Uri.parse(item.uri),
								range: range(item.range),
							}),
						);
					},
				}),
			);

		if (capabilities.referencesProvider)
			this.disposables.push(
				this.monaco.languages.registerReferenceProvider(this.languageId, {
					provideReferences: async (model, at) => {
						const response = await this.request<LspLocation[] | null>(
							"textDocument/references",
							{
								...(this.documentPosition(model, at) as object),
								context: { includeDeclaration: true },
							},
						);
						return (response ?? []).map((item) => ({
							uri: this.monaco.Uri.parse(item.uri),
							range: range(item.range),
						}));
					},
				}),
			);

		if (capabilities.documentFormattingProvider)
			this.disposables.push(
				this.monaco.languages.registerDocumentFormattingEditProvider(this.languageId, {
					provideDocumentFormattingEdits: async (model) =>
						this.textEdits(
							await this.request<LspTextEdit[] | null>(
								"textDocument/formatting",
								{
									textDocument: { uri: model.uri.toString() },
									options: { tabSize: 4, insertSpaces: true },
								},
							),
						),
				}),
			);

		const semantic = asShape<
			| {
					legend?: { tokenTypes?: string[]; tokenModifiers?: string[] };
					full?: JsonValue;
			  }
			| undefined
		>(capabilities.semanticTokensProvider);
		if (semantic?.legend && semantic.full)
			this.disposables.push(
				this.monaco.languages.registerDocumentSemanticTokensProvider(this.languageId, {
					getLegend: () => ({
						tokenTypes: semantic.legend?.tokenTypes ?? [],
						tokenModifiers: semantic.legend?.tokenModifiers ?? [],
					}),
					provideDocumentSemanticTokens: async (model) => {
						const response = await this.request<{
							data: number[];
							resultId?: string;
						} | null>("textDocument/semanticTokens/full", {
							textDocument: { uri: model.uri.toString() },
						});
						if (!response) return null;
						return {
							data: new Uint32Array(response.data),
							...(response.resultId ? { resultId: response.resultId } : {}),
						};
					},
					releaseDocumentSemanticTokens: () => undefined,
				}),
			);

		if (capabilities.inlayHintProvider)
			this.disposables.push(
				this.monaco.languages.registerInlayHintsProvider(this.languageId, {
					provideInlayHints: async (model, requestedRange) => {
						const hints = await this.request<
							| {
									position: LspPosition;
									label: string | { value: string }[];
									tooltip?: string;
							  }[]
							| null
						>("textDocument/inlayHint", {
							textDocument: { uri: model.uri.toString() },
							range: fromMonacoBounds(
								requestedRange.startLineNumber,
								requestedRange.startColumn,
								requestedRange.endLineNumber,
								requestedRange.endColumn,
							),
						});
						return {
							hints: (hints ?? []).map((hint) => ({
								position: position(hint.position),
								label:
									typeof hint.label === "string"
										? hint.label
										: hint.label.map((part) => part.value).join(""),
								...(hint.tooltip ? { tooltip: hint.tooltip } : {}),
								kind: this.monaco.languages.InlayHintKind.Type,
							})),
							dispose: () => undefined,
						};
					},
				}),
			);

		if (capabilities.codeActionProvider)
			this.disposables.push(
				this.monaco.languages.registerCodeActionProvider(this.languageId, {
					provideCodeActions: async (model, selectedRange, context) => {
						const actions = await this.request<
							| {
									title: string;
									kind?: string;
									edit?: { changes?: Record<string, LspTextEdit[]> };
									command?: {
										title: string;
										command: string;
										arguments?: JsonValue[];
									};
							  }[]
							| null
						>("textDocument/codeAction", {
							textDocument: { uri: model.uri.toString() },
							range: fromMonacoBounds(
								selectedRange.startLineNumber,
								selectedRange.startColumn,
								selectedRange.endLineNumber,
								selectedRange.endColumn,
							),
							context: {
								diagnostics: context.markers.map((marker) => ({
									message: marker.message,
									range: fromMonacoBounds(
										marker.startLineNumber,
										marker.startColumn,
										marker.endLineNumber,
										marker.endColumn,
									),
								})),
							},
						});
						return {
							actions: (actions ?? []).map(
								(action) =>
									({
										title: action.title,
										...(action.kind ? { kind: action.kind } : {}),
										...(action.edit
											? {
													edit: {
														edits: Object.entries(
															action.edit.changes ?? {},
														).flatMap(([uri, edits]) =>
															edits.map((edit) => ({
																resource: this.monaco.Uri.parse(uri),
																textEdit: {
																	range: range(edit.range),
																	text: edit.newText,
																},
															})),
														),
													},
												}
											: {}),
										...(action.command
											? {
													command: {
														id: action.command.command,
														title: action.command.title,
														...(action.command.arguments
															? { arguments: action.command.arguments }
															: {}),
													},
												}
											: {}),
									}) as Monaco.languages.CodeAction,
							),
							dispose: () => undefined,
						};
					},
				}),
			);
	}

	private textEdits(edits: LspTextEdit[] | null): Monaco.languages.TextEdit[] {
		return (edits ?? []).map((edit) => ({
			range: range(edit.range),
			text: edit.newText,
		}));
	}
	private documentPosition(
		model: Monaco.editor.ITextModel,
		at: Monaco.Position,
	): object {
		return {
			textDocument: { uri: model.uri.toString() },
			position: { line: at.lineNumber - 1, character: at.column - 1 },
		};
	}

	private receive(raw: string): void {
		let message: RpcMessage;
		try {
			message = JSON.parse(raw) as RpcMessage;
		} catch {
			return;
		}
		if (typeof message.id === "number" && !message.method) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				// Transient server errors (e.g. rust-analyzer before its VFS
				// loads) resolve to null so feature requests degrade silently;
				// only a failed initialize is worth surfacing.
				if (pending.method === "initialize")
					pending.reject(new Error(message.error.message ?? "LSP error"));
				else pending.resolve(null);
			} else pending.resolve(message.result ?? null);
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const params = asShape<{
				uri?: string;
				diagnostics?: LspDiagnostic[];
			}>(message.params);
			if (!params.uri) return;
			const model = this.monaco.editor.getModel(
				this.monaco.Uri.parse(params.uri),
			);
			if (!model) return;
			const diagnostics = params.diagnostics ?? [];
			this.monaco.editor.setModelMarkers(
				model,
				this.serverName,
				diagnostics.map((diagnostic) => ({
					...range(diagnostic.range),
					message: diagnostic.message,
					...(diagnostic.code !== undefined
						? { code: String(diagnostic.code) }
						: {}),
					source: diagnostic.source ?? this.serverName,
					severity:
						[
							0,
							this.monaco.MarkerSeverity.Error,
							this.monaco.MarkerSeverity.Warning,
							this.monaco.MarkerSeverity.Info,
							this.monaco.MarkerSeverity.Hint,
						][diagnostic.severity ?? 1] ?? this.monaco.MarkerSeverity.Error,
				})),
			);
			this.onDiagnostics(params.uri, diagnostics);
		} else if (message.method === "window/showMessage") {
			this.onStatus(
				String(
					asShape<{ message?: string } | undefined>(message.params)?.message ??
						"Language server message",
				),
			);
		} else if (message.method === "atomis/lspRestarted") {
			this.onStatus("Language server restarted; reconnect the page to reinitialize");
		}
		if (message.id !== undefined && message.method)
			this.answerServerRequest(message);
	}

	private answerServerRequest(message: RpcMessage): void {
		this.socket?.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: answerServerRequest(message.method, message.params),
			}),
		);
	}

	private notify(method: string, params: object): void {
		if (this.socket?.readyState === WebSocket.OPEN)
			this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	}

	private request<T>(method: string, params: object): Promise<T> {
		// A dead socket answers nothing: short-circuit with the same value a
		// transient server error resolves to, so providers degrade silently.
		if (this.closed) return Promise.resolve(asShape<T>(null));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				if (method === "initialize")
					reject(new Error(`${this.serverName} initialize timed out`));
				else resolve(asShape<T>(null));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, {
				method,
				resolve: (value) => {
					clearTimeout(timer);
					resolve(asShape<T>(value));
				},
				reject: (reason) => {
					clearTimeout(timer);
					reject(reason);
				},
			});
			this.socket?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	/**
	 * The server is gone: every caller still waiting gets its answer now —
	 * null, the transient-failure value — because nothing will ever arrive.
	 * Before this, one hover against a dead server left its promise pending
	 * forever, and every later request piled up behind it in `pending`.
	 */
	private failPending(): void {
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const entry of entries) {
			if (entry.method === "initialize")
				entry.reject(new Error(`${this.serverName} connection closed`));
			else entry.resolve(null);
		}
	}

	private markClosed(): void {
		if (this.closed) return;
		this.closed = true;
		this.failPending();
		this.onClose?.();
	}

	public dispose(): void {
		for (const uri of this.openedModels.keys())
			this.notify("textDocument/didClose", { textDocument: { uri } });
		this.openedModels.clear();
		this.pendingOpens.clear();
		for (const disposable of this.disposables) disposable.dispose();
		// Closed by the owner, who is already dropping this client from its
		// cache — flip the flag first so the socket's own close event cannot
		// re-enter through onClose while the owner iterates that cache.
		this.closed = true;
		this.socket?.close();
		this.failPending();
	}
}
