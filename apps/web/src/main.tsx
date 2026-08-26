import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
// The API-only Monaco entry does not register UI contributions. Keep the
// bundle Zig-focused while enabling the controls used by our LSP providers.
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions";
import "monaco-editor/editor/contrib/format/browser/formatActions";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import "monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

self.MonacoEnvironment = {
	getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
