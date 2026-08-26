import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"monaco-editor/esm/vs/editor/editor.api":
				"monaco-editor/editor/editor.api",
			"monaco-editor/esm/vs/editor/common/commands/shiftCommand":
				"monaco-editor/editor/common/commands/shiftCommand",
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": { target: "http://127.0.0.1:4317" },
			"/ws": { target: "ws://127.0.0.1:4317", ws: true },
		},
	},
	build: { outDir: "dist", sourcemap: true },
});
