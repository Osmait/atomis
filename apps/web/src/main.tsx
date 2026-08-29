import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
// The API-only Monaco entry does not register UI contributions. Keep the
// bundle Zig-focused while enabling the controls used by our LSP providers.
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/format/browser/formatActions";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition";
import "monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import "monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { hydratePreferences } from "./state/storage.js";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles.css";

self.MonacoEnvironment = {
	getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

// Settings live on the server so every device agrees on them, and the
// loaders that read them run during the first render — so fetch them before
// mounting rather than repainting the whole UI a moment later. A server that
// cannot answer falls back to this browser's own storage.
// hydratePreferences never rejects — a server that cannot answer leaves the
// browser's own storage in charge — so awaiting it here cannot strand the page.
await hydratePreferences();
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
