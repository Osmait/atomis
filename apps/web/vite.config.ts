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
		port: Number(process.env.ATOMIS_WEB_PORT ?? 5173),
		strictPort: true,
		proxy: {
			"/api": {
				target: process.env.ATOMIS_PROXY ?? "http://127.0.0.1:4317",
			},
			"/ws": {
				target: (process.env.ATOMIS_PROXY ?? "http://127.0.0.1:4317").replace(
					"http",
					"ws",
				),
				ws: true,
			},
		},
	},
	build: {
		outDir: "dist",
		// Source maps are 15MB of the 20MB build, shipped to every deployment
		// and into the container image for the rare debugging session. The
		// source is public; anyone who needs a map can build one.
		sourcemap: false,
		rollupOptions: {
			output: {
				// Monaco changes when Monaco is upgraded; the app changes daily.
				// Splitting them means an app update re-downloads ~200KB instead
				// of 3.7MB, and the two arrive in parallel on a first visit.
				manualChunks: (id) => {
					if (!id.includes("node_modules")) return undefined;
					if (id.includes("monaco-editor")) return "monaco";
					if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
						return "react";
					return "vendor";
				},
			},
		},
	},
});
