export type FileKind =
	| "zig"
	| "zon"
	| "rs"
	| "go"
	| "ts"
	| "js"
	| "py"
	| "toml"
	| "txt"
	| "md"
	| "json"
	| "file";

export function fileKind(path: string): FileKind {
	if (path.endsWith(".zig")) return "zig";
	if (path.endsWith(".zon")) return "zon";
	if (path.endsWith(".rs")) return "rs";
	if (path.endsWith(".go")) return "go";
	if (path.endsWith(".ts")) return "ts";
	if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs"))
		return "js";
	if (path.endsWith(".py")) return "py";
	if (path.endsWith(".mod") || path.endsWith(".sum")) return "toml";
	if (path.endsWith(".toml")) return "toml";
	if (path.endsWith(".txt")) return "txt";
	if (path.endsWith(".md")) return "md";
	if (path.endsWith(".json")) return "json";
	return "file";
}

/** Rounded-square language badge used for the TS and JS marks. */
export function LangBadge({ label }: { label: string }): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<rect x="1.5" y="1.5" width="13" height="13" rx="2.6" fill="currentColor" />
			<text
				x="8"
				y="11.6"
				textAnchor="middle"
				fontSize="7.2"
				fontFamily="'JetBrains Mono', monospace"
				fontWeight="700"
				fill="var(--base, #11111b)"
			>
				{label}
			</text>
		</svg>
	);
}

/** Simplified Go mark: the language name in its brand cyan. */
export function GoMark(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<rect
				x="1"
				y="3"
				width="14"
				height="10"
				rx="3"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			/>
			<text
				x="8"
				y="11.2"
				textAnchor="middle"
				fontSize="7.4"
				fontFamily="'JetBrains Mono', monospace"
				fontWeight="700"
				fill="currentColor"
			>
				Go
			</text>
		</svg>
	);
}

/** Simplified Rust gear-R mark drawn with currentColor. */
export function RustGear(): React.JSX.Element {
	const teeth = Array.from({ length: 8 }, (_, index) => {
		const angle = (index * Math.PI) / 4;
		const x1 = 8 + Math.cos(angle) * 5;
		const y1 = 8 + Math.sin(angle) * 5;
		const x2 = 8 + Math.cos(angle) * 7.2;
		const y2 = 8 + Math.sin(angle) * 7.2;
		return (
			<line
				key={index}
				x1={x1.toFixed(2)}
				y1={y1.toFixed(2)}
				x2={x2.toFixed(2)}
				y2={y2.toFixed(2)}
				stroke="currentColor"
				strokeWidth="1.7"
			/>
		);
	});
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			{teeth}
			<circle
				cx="8"
				cy="8"
				r="5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			/>
			<text
				x="8"
				y="10.9"
				textAnchor="middle"
				fontSize="8.4"
				fontFamily="'JetBrains Mono', monospace"
				fontWeight="700"
				fill="currentColor"
			>
				R
			</text>
		</svg>
	);
}

/**
 * Official Zig mark (ziglang/logo, CC-BY-SA-4.0, Zig Software Foundation),
 * recolored via currentColor so tabs can dim it when inactive.
 */
export function ZigMark(): React.JSX.Element {
	return (
		<svg viewBox="0 0 153 140" aria-hidden="true" focusable="false">
			<g fill="currentColor">
				<polygon points="46,22 28,44 19,30" />
				<polygon points="46,22 33,33 28,44 22,44 22,95 31,95 20,100 12,117 0,117 0,22" />
				<polygon points="31,95 12,117 4,106" />
				<polygon points="56,22 62,36 37,44" />
				<polygon points="56,22 111,22 111,44 37,44 56,32" />
				<polygon points="116,95 97,117 90,104" />
				<polygon points="116,95 100,104 97,117 42,117 42,95" />
				<polygon points="150,0 52,117 3,140 101,22" />
				<polygon points="141,22 140,40 122,45" />
				<polygon points="153,22 153,117 106,117 120,105 125,95 131,95 131,45 122,45 132,36 141,22" />
				<polygon points="125,95 130,110 106,117" />
			</g>
		</svg>
	);
}

function DocumentIcon({ braces = false }: { braces?: boolean }): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<path
				d="M3.5 2 H9.3 L12.5 5.2 V14 H3.5 Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinejoin="round"
			/>
			<path
				d="M9.3 2 V5.2 H12.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.1"
				strokeLinejoin="round"
			/>
			{braces ? (
				<path
					d="M6.7 7.4 c-1 0 -.8 1 -.8 1.6 s-.9.9 -.9.9 .9.3 .9.9 -.2 1.6 .8 1.6 M9.3 7.4 c1 0 .8 1 .8 1.6 s.9.9 .9.9 -.9.3 -.9.9 .2 1.6 -.8 1.6"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.1"
					strokeLinecap="round"
				/>
			) : (
				<path
					d="M5.5 8.2 h5 M5.5 10.7 h3.4"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
				/>
			)}
		</svg>
	);
}

export function FileIcon({ path }: { path: string }): React.JSX.Element {
	const kind = fileKind(path);
	return (
		<i className={`file-glyph ${kind}`}>
			{kind === "zig" || kind === "zon" ? (
				<ZigMark />
			) : kind === "rs" ? (
				<RustGear />
			) : kind === "go" ? (
				<GoMark />
			) : kind === "ts" ? (
				<LangBadge label="TS" />
			) : kind === "js" ? (
				<LangBadge label="JS" />
			) : kind === "py" ? (
				<LangBadge label="Py" />
			) : (
				<DocumentIcon braces={kind === "json" || kind === "toml"} />
			)}
		</i>
	);
}

export function FolderIcon({ open = false }: { open?: boolean }): React.JSX.Element {
	return (
		<i className="folder-glyph">
			{open ? (
				<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
					<path
						d="M1.5 4.4 a1 1 0 0 1 1-1 h3.2 a1 1 0 0 1 .78.37 L7.6 5.1 h4.9 a1 1 0 0 1 1 1 v.9 H3.2 a1.2 1.2 0 0 0-1.15.86 L1.5 9.6 Z"
						fill="currentColor"
					/>
					<path
						d="M3.2 8 h10.9 a.8.8 0 0 1 .77 1.02 l-.98 3.4 a1 1 0 0 1-.96.73 H2.5 a.8.8 0 0 1-.77-1.02 l1-3.5 A.7.7 0 0 1 3.2 8 Z"
						fill="currentColor"
						opacity="0.75"
					/>
				</svg>
			) : (
				<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
					<path
						d="M1.5 4.4 a1 1 0 0 1 1-1 h3.2 a1 1 0 0 1 .78.37 L7.6 5.1 h5.9 a1 1 0 0 1 1 1 v6 a1 1 0 0 1-1 1 h-11 a1 1 0 0 1-1-1 Z"
						fill="currentColor"
					/>
				</svg>
			)}
		</i>
	);
}
