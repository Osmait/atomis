import type * as Monaco from "monaco-editor";

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string };
}

interface LspPosition {
	line: number;
	character: number;
}
interface LspRange {
	start: LspPosition;
	end: LspPosition;
}
interface LspTextEdit {
	range: LspRange;
	newText: string;
}
interface LspDiagnostic {
	range: LspRange;
	message: string;
	severity?: number;
	code?: string | number;
	source?: string;
}
interface Location {
	uri: string;
	range: LspRange;
}

function position(position: LspPosition): Monaco.Position {
	return {
		lineNumber: position.line + 1,
		column: position.character + 1,
	} as Monaco.Position;
}
function range(value: LspRange): Monaco.Range {
	return {
		startLineNumber: value.start.line + 1,
		startColumn: value.start.character + 1,
		endLineNumber: value.end.line + 1,
		endColumn: value.end.character + 1,
	} as Monaco.Range;
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

export class LspClient {
	private socket: WebSocket | undefined;
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (reason: Error) => void }
	>();
	private readonly disposables: Monaco.IDisposable[] = [];
	private capabilities: Record<string, unknown> = {};

	public constructor(
		private readonly monaco: typeof Monaco,
		private readonly model: Monaco.editor.ITextModel,
		private readonly workspaceUri: string,
		private readonly onCapabilities: (
			capabilities: Record<string, unknown>,
		) => void,
		private readonly onDiagnostics: (diagnostics: LspDiagnostic[]) => void,
		private readonly onStatus: (status: string) => void,
	) {}

	public connect(url: string, documentVersion: number): void {
		this.socket = new WebSocket(url);
		this.socket.addEventListener("open", () => {
			void this.initialize(documentVersion);
		});
		this.socket.addEventListener("message", (event) =>
			this.receive(String(event.data)),
		);
		this.socket.addEventListener("close", () =>
			this.onStatus("ZLS disconnected"),
		);
		this.socket.addEventListener("error", () =>
			this.onStatus("ZLS unavailable"),
		);
	}

	private async initialize(documentVersion: number): Promise<void> {
		const result = await this.request<{
			capabilities: Record<string, unknown>;
		}>("initialize", {
			processId: null,
			rootUri: this.workspaceUri,
			workspaceFolders: [{ uri: this.workspaceUri, name: "ZigLive session" }],
			clientInfo: { name: "ZigLive", version: "0.1.0" },
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
		this.capabilities = result.capabilities;
		this.onCapabilities(result.capabilities);
		this.notify("initialized", {});
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri: this.model.uri.toString(),
				languageId: "zig",
				version: documentVersion,
				text: this.model.getValue(),
			},
		});
		this.registerProviders();
		this.onStatus("ZLS connected");
	}

	public change(version: number, source: string): void {
		this.notify("textDocument/didChange", {
			textDocument: { uri: this.model.uri.toString(), version },
			contentChanges: [{ text: source }],
		});
	}

	public save(): void {
		this.notify("textDocument/didSave", {
			textDocument: { uri: this.model.uri.toString() },
			text: this.model.getValue(),
		});
	}

	private registerProviders(): void {
		const capabilities = this.capabilities;
		if (capabilities.completionProvider)
			this.disposables.push(
				this.monaco.languages.registerCompletionItemProvider("zig", {
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
					provideCompletionItems: async (_model, at) => {
						let response: { items?: unknown[] } | unknown[] | null;
						try {
							response = await this.request<
								{ items?: unknown[] } | unknown[] | null
							>("textDocument/completion", this.documentPosition(at));
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
								const item = raw as {
									label: string;
									detail?: string;
									documentation?: string | { value?: string };
									kind?: number;
									insertText?: string;
									insertTextFormat?: number;
									textEdit?: LspTextEdit;
									sortText?: string;
									filterText?: string;
								};
								const documentation =
									typeof item.documentation === "string"
										? item.documentation
										: item.documentation?.value;
								return {
									label: item.label,
									detail: item.detail,
									documentation,
									kind: completionKind(this.monaco, item.kind),
									insertText:
										item.textEdit?.newText ?? item.insertText ?? item.label,
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
				this.monaco.languages.registerHoverProvider("zig", {
					provideHover: async (_model, at) => {
						const hover = await this.request<{
							contents?: unknown;
							range?: LspRange;
						} | null>("textDocument/hover", this.documentPosition(at));
						if (!hover) return null;
						const raw = Array.isArray(hover.contents)
							? hover.contents
							: [hover.contents];
						const contents = raw.filter(Boolean).map((entry) => {
							if (typeof entry === "string") return { value: entry };
							const value = entry as { value?: string; language?: string };
							return {
								value: value.language
									? `\`\`\`${value.language}\n${value.value ?? ""}\n\`\`\``
									: (value.value ?? ""),
							};
						});
						return {
							contents,
							...(hover.range ? { range: range(hover.range) } : {}),
						};
					},
				}),
			);

		if (capabilities.definitionProvider)
			this.disposables.push(
				this.monaco.languages.registerDefinitionProvider("zig", {
					provideDefinition: async (_model, at) => {
						const response = await this.request<Location | Location[] | null>(
							"textDocument/definition",
							this.documentPosition(at),
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

		if (capabilities.documentFormattingProvider)
			this.disposables.push(
				this.monaco.languages.registerDocumentFormattingEditProvider("zig", {
					provideDocumentFormattingEdits: async () =>
						this.textEdits(
							await this.request<LspTextEdit[] | null>(
								"textDocument/formatting",
								{
									textDocument: { uri: this.model.uri.toString() },
									options: { tabSize: 4, insertSpaces: true },
								},
							),
						),
				}),
			);

		const semantic = capabilities.semanticTokensProvider as
			| {
					legend?: { tokenTypes?: string[]; tokenModifiers?: string[] };
					full?: unknown;
			  }
			| undefined;
		if (semantic?.legend && semantic.full)
			this.disposables.push(
				this.monaco.languages.registerDocumentSemanticTokensProvider("zig", {
					getLegend: () => ({
						tokenTypes: semantic.legend?.tokenTypes ?? [],
						tokenModifiers: semantic.legend?.tokenModifiers ?? [],
					}),
					provideDocumentSemanticTokens: async () => {
						const response = await this.request<{
							data: number[];
							resultId?: string;
						} | null>("textDocument/semanticTokens/full", {
							textDocument: { uri: this.model.uri.toString() },
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
				this.monaco.languages.registerInlayHintsProvider("zig", {
					provideInlayHints: async (_model, requestedRange) => {
						const hints = await this.request<
							| {
									position: LspPosition;
									label: string | { value: string }[];
									tooltip?: string;
							  }[]
							| null
						>("textDocument/inlayHint", {
							textDocument: { uri: this.model.uri.toString() },
							range: {
								start: {
									line: requestedRange.startLineNumber - 1,
									character: requestedRange.startColumn - 1,
								},
								end: {
									line: requestedRange.endLineNumber - 1,
									character: requestedRange.endColumn - 1,
								},
							},
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
				this.monaco.languages.registerCodeActionProvider("zig", {
					provideCodeActions: async (_model, selectedRange, context) => {
						const actions = await this.request<
							| {
									title: string;
									kind?: string;
									edit?: { changes?: Record<string, LspTextEdit[]> };
									command?: {
										title: string;
										command: string;
										arguments?: unknown[];
									};
							  }[]
							| null
						>("textDocument/codeAction", {
							textDocument: { uri: this.model.uri.toString() },
							range: {
								start: {
									line: selectedRange.startLineNumber - 1,
									character: selectedRange.startColumn - 1,
								},
								end: {
									line: selectedRange.endLineNumber - 1,
									character: selectedRange.endColumn - 1,
								},
							},
							context: {
								diagnostics: context.markers.map((marker) => ({
									message: marker.message,
									range: {
										start: {
											line: marker.startLineNumber - 1,
											character: marker.startColumn - 1,
										},
										end: {
											line: marker.endLineNumber - 1,
											character: marker.endColumn - 1,
										},
									},
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
	private documentPosition(at: Monaco.Position): object {
		return {
			textDocument: { uri: this.model.uri.toString() },
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
			if (message.error)
				pending.reject(new Error(message.error.message ?? "LSP error"));
			else pending.resolve(message.result);
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as {
				uri?: string;
				diagnostics?: LspDiagnostic[];
			};
			if (params.uri !== this.model.uri.toString()) return;
			const diagnostics = params.diagnostics ?? [];
			this.monaco.editor.setModelMarkers(
				this.model,
				"zls",
				diagnostics.map((diagnostic) => ({
					...range(diagnostic.range),
					message: diagnostic.message,
					...(diagnostic.code !== undefined
						? { code: String(diagnostic.code) }
						: {}),
					source: diagnostic.source ?? "zls",
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
			this.onDiagnostics(diagnostics);
		} else if (message.method === "window/showMessage") {
			this.onStatus(
				String(
					(message.params as { message?: string })?.message ?? "ZLS message",
				),
			);
		} else if (message.method === "ziglive/zlsRestarted") {
			this.onStatus("ZLS restarted; reconnect the page to reinitialize");
		}
		if (message.id !== undefined && message.method)
			this.answerServerRequest(message);
	}

	private answerServerRequest(message: RpcMessage): void {
		let result: unknown = null;
		if (message.method === "workspace/configuration")
			result = ((message.params as { items?: unknown[] })?.items ?? []).map(
				() => ({}),
			);
		else if (message.method === "workspace/applyEdit")
			result = {
				applied: false,
				failureReason: "Server initiated edits are not supported",
			};
		this.socket?.send(
			JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
		);
	}

	private notify(method: string, params: unknown): void {
		if (this.socket?.readyState === WebSocket.OPEN)
			this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	}

	private request<T>(method: string, params: unknown): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			this.socket?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	public dispose(): void {
		this.notify("textDocument/didClose", {
			textDocument: { uri: this.model.uri.toString() },
		});
		for (const disposable of this.disposables) disposable.dispose();
		this.socket?.close();
		for (const pending of this.pending.values())
			pending.reject(new Error("LSP client disposed"));
		this.pending.clear();
	}
}
