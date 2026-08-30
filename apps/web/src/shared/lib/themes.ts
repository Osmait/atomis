/**
 * Theme palettes.
 *
 * A theme used to be three panel shades over one fixed Catppuccin Mocha
 * palette. Each one is now a full palette, and both the window (CSS custom
 * properties) and the editor (a Monaco theme) are generated from it, so
 * adding a theme means adding an entry here and nothing else.
 *
 * The dimmed and tinted variants are derived rather than declared: they are
 * always the same blend of an accent into the theme's own darkest colour, so
 * a new palette cannot forget one or pick an inconsistent one.
 */

export type Scheme = "dark" | "light";

export interface Palette {
	label: string;
	/** Drives `color-scheme`, so form controls and scrollbars match. */
	scheme: Scheme;
	/** Window backdrop — the darkest colour on a dark theme. */
	base: string;
	/** Side panels. */
	mantle: string;
	/** Editor surface. */
	surface: string;
	/** Borders, inputs, inactive selection. */
	surface0: string;
	/** Active selection. */
	surface1: string;
	text: string;
	subtext: string;
	overlay: string;
	overlayDim: string;
	/** Line numbers, disabled text. */
	dim: string;
	mauve: string;
	red: string;
	green: string;
	yellow: string;
	peach: string;
	blue: string;
	teal: string;
	sky: string;
	pink: string;
	/** Default to surface / mantle / base; only a variant overrides them. */
	panelEditor?: string;
	panelSide?: string;
	panelBorder?: string;
}

export const THEMES = {
	mocha: {
		label: "Mocha",
		scheme: "dark",
		base: "#11111b",
		mantle: "#181825",
		surface: "#1e1e2e",
		surface0: "#313244",
		surface1: "#45475a",
		text: "#cdd6f4",
		subtext: "#a6adc8",
		overlay: "#7f849c",
		overlayDim: "#6c7086",
		dim: "#585b70",
		mauve: "#cba6f7",
		red: "#f38ba8",
		green: "#a6e3a1",
		yellow: "#f9e2af",
		peach: "#fab387",
		blue: "#89b4fa",
		teal: "#94e2d5",
		sky: "#89dceb",
		pink: "#f5c2e7",
	},
	macchiato: {
		label: "Macchiato",
		scheme: "dark",
		base: "#181926",
		mantle: "#1e2030",
		surface: "#24273a",
		surface0: "#363a4f",
		surface1: "#494d64",
		text: "#cad3f5",
		subtext: "#b8c0e0",
		overlay: "#939ab7",
		overlayDim: "#8087a2",
		dim: "#6e738d",
		mauve: "#c6a0f6",
		red: "#ed8796",
		green: "#a6da95",
		yellow: "#eed49f",
		peach: "#f5a97f",
		blue: "#8aadf4",
		teal: "#8bd5ca",
		sky: "#91d7e3",
		pink: "#f5bde6",
	},
	frappe: {
		label: "Frappé",
		scheme: "dark",
		base: "#232634",
		mantle: "#292c3c",
		surface: "#303446",
		surface0: "#414559",
		surface1: "#51576d",
		text: "#c6d0f5",
		subtext: "#b5bfe2",
		overlay: "#949cbb",
		overlayDim: "#838ba7",
		dim: "#737994",
		mauve: "#ca9ee6",
		red: "#e78284",
		green: "#a6d189",
		yellow: "#e5c890",
		peach: "#ef9f76",
		blue: "#8caaee",
		teal: "#81c8be",
		sky: "#99d1db",
		pink: "#f4b8e4",
	},
	crust: {
		label: "Crust",
		scheme: "dark",
		base: "#0b0b12",
		mantle: "#11111b",
		surface: "#181825",
		surface0: "#2a2a3c",
		surface1: "#3d3f52",
		text: "#cdd6f4",
		subtext: "#a6adc8",
		overlay: "#7f849c",
		overlayDim: "#6c7086",
		dim: "#585b70",
		mauve: "#cba6f7",
		red: "#f38ba8",
		green: "#a6e3a1",
		yellow: "#f9e2af",
		peach: "#fab387",
		blue: "#89b4fa",
		teal: "#94e2d5",
		sky: "#89dceb",
		pink: "#f5c2e7",
	},
	tokyonight: {
		label: "Tokyo Night",
		scheme: "dark",
		base: "#15161e",
		mantle: "#16161e",
		surface: "#1a1b26",
		surface0: "#292e42",
		surface1: "#3b4261",
		text: "#c0caf5",
		subtext: "#a9b1d6",
		overlay: "#787c99",
		overlayDim: "#565f89",
		dim: "#414868",
		mauve: "#bb9af7",
		red: "#f7768e",
		green: "#9ece6a",
		yellow: "#e0af68",
		peach: "#ff9e64",
		blue: "#7aa2f7",
		teal: "#73daca",
		sky: "#7dcfff",
		pink: "#ff75a0",
	},
	gruvbox: {
		label: "Gruvbox",
		scheme: "dark",
		base: "#1d2021",
		mantle: "#282828",
		surface: "#32302f",
		surface0: "#3c3836",
		surface1: "#504945",
		text: "#ebdbb2",
		subtext: "#d5c4a1",
		overlay: "#bdae93",
		overlayDim: "#a89984",
		dim: "#928374",
		mauve: "#d3869b",
		red: "#fb4934",
		green: "#b8bb26",
		yellow: "#fabd2f",
		peach: "#fe8019",
		blue: "#83a598",
		teal: "#8ec07c",
		sky: "#689d6a",
		pink: "#d3869b",
	},
	nord: {
		label: "Nord",
		scheme: "dark",
		base: "#242933",
		mantle: "#2e3440",
		surface: "#3b4252",
		surface0: "#434c5e",
		surface1: "#4c566a",
		text: "#eceff4",
		subtext: "#e5e9f0",
		overlay: "#9aa5b8",
		overlayDim: "#7b88a1",
		dim: "#616e88",
		mauve: "#b48ead",
		red: "#bf616a",
		green: "#a3be8c",
		yellow: "#ebcb8b",
		peach: "#d08770",
		blue: "#81a1c1",
		teal: "#8fbcbb",
		sky: "#88c0d0",
		pink: "#b48ead",
	},
	dracula: {
		label: "Dracula",
		scheme: "dark",
		base: "#191a21",
		mantle: "#21222c",
		surface: "#282a36",
		surface0: "#343746",
		surface1: "#44475a",
		text: "#f8f8f2",
		subtext: "#d6d6d1",
		overlay: "#9ea0a8",
		overlayDim: "#6272a4",
		dim: "#6272a4",
		mauve: "#bd93f9",
		red: "#ff5555",
		green: "#50fa7b",
		yellow: "#f1fa8c",
		peach: "#ffb86c",
		blue: "#8be9fd",
		teal: "#8be9fd",
		sky: "#8be9fd",
		pink: "#ff79c6",
	},
	everforest: {
		label: "Everforest",
		scheme: "dark",
		base: "#232a2e",
		mantle: "#272e33",
		surface: "#2d353b",
		surface0: "#343f44",
		surface1: "#3d484d",
		text: "#d3c6aa",
		subtext: "#9da9a0",
		overlay: "#859289",
		overlayDim: "#7a8478",
		dim: "#7a8478",
		mauve: "#d699b6",
		red: "#e67e80",
		green: "#a7c080",
		yellow: "#dbbc7f",
		peach: "#e69875",
		blue: "#7fbbb3",
		teal: "#83c092",
		sky: "#7fbbb3",
		pink: "#d699b6",
	},
	rosepine: {
		label: "Rosé Pine",
		scheme: "dark",
		base: "#12101a",
		mantle: "#191724",
		surface: "#1f1d2e",
		surface0: "#26233a",
		surface1: "#403d52",
		text: "#e0def4",
		subtext: "#908caa",
		overlay: "#6e6a86",
		overlayDim: "#6e6a86",
		dim: "#524f67",
		mauve: "#c4a7e7",
		red: "#eb6f92",
		green: "#9ccfd8",
		yellow: "#f6c177",
		peach: "#ebbcba",
		blue: "#31748f",
		teal: "#9ccfd8",
		sky: "#9ccfd8",
		pink: "#ebbcba",
	},
	kanagawa: {
		label: "Kanagawa",
		scheme: "dark",
		base: "#16161d",
		mantle: "#1f1f28",
		surface: "#2a2a37",
		surface0: "#363646",
		surface1: "#54546d",
		text: "#dcd7ba",
		subtext: "#c8c093",
		overlay: "#938f7d",
		overlayDim: "#727169",
		dim: "#54546d",
		mauve: "#957fb8",
		red: "#e46876",
		green: "#98bb6c",
		yellow: "#e6c384",
		peach: "#ffa066",
		blue: "#7e9cd8",
		teal: "#7aa89f",
		sky: "#7fb4ca",
		pink: "#d27e99",
	},
	onedark: {
		label: "One Dark",
		scheme: "dark",
		base: "#1e2127",
		mantle: "#21252b",
		surface: "#282c34",
		surface0: "#3e4451",
		surface1: "#4b5263",
		text: "#abb2bf",
		subtext: "#9da5b4",
		overlay: "#7f848e",
		overlayDim: "#5c6370",
		dim: "#5c6370",
		mauve: "#c678dd",
		red: "#e06c75",
		green: "#98c379",
		yellow: "#e5c07b",
		peach: "#d19a66",
		blue: "#61afef",
		teal: "#56b6c2",
		sky: "#56b6c2",
		pink: "#c678dd",
	},
	latte: {
		label: "Latte",
		scheme: "light",
		base: "#dce0e8",
		mantle: "#e6e9ef",
		surface: "#eff1f5",
		surface0: "#ccd0da",
		surface1: "#bcc0cc",
		text: "#4c4f69",
		subtext: "#5c5f77",
		overlay: "#7c7f93",
		overlayDim: "#8c8fa1",
		dim: "#9ca0b0",
		mauve: "#8839ef",
		red: "#d20f39",
		green: "#40a02b",
		yellow: "#df8e1d",
		peach: "#fe640b",
		blue: "#1e66f5",
		teal: "#179299",
		sky: "#04a5e5",
		pink: "#ea76cb",
	},
	solarized: {
		label: "Solarized",
		scheme: "light",
		base: "#eee8d5",
		mantle: "#f5efdc",
		surface: "#fdf6e3",
		surface0: "#e4dcc3",
		surface1: "#d6cdb3",
		text: "#073642",
		subtext: "#586e75",
		overlay: "#657b83",
		overlayDim: "#839496",
		dim: "#93a1a1",
		mauve: "#6c71c4",
		red: "#dc322f",
		green: "#859900",
		yellow: "#b58900",
		peach: "#cb4b16",
		blue: "#268bd2",
		teal: "#2aa198",
		sky: "#268bd2",
		pink: "#d33682",
	},
} as const satisfies Record<string, Palette>;

export type AppTheme = keyof typeof THEMES;

export const THEME_IDS = Object.keys(THEMES) as AppTheme[];

export const DEFAULT_THEME: AppTheme = "mocha";

export function isAppTheme(value: string | undefined): value is AppTheme {
	return value !== undefined && value in THEMES;
}

export function paletteOf(theme: AppTheme): Palette {
	return THEMES[theme];
}

/** `#rrggbb` → the three channels. Malformed input reads as black. */
function channels(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.slice(1), 16);
	return Number.isNaN(value)
		? [0, 0, 0]
		: [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** `amount` of the way from `from` to `to`, per channel. */
function mix(from: string, to: string, amount: number): string {
	const left = channels(from);
	const right = channels(to);
	const blend = left.map((channel, index) =>
		Math.round(channel + ((right[index] ?? 0) - channel) * amount),
	);
	return `#${blend.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The CSS custom properties the stylesheet reads. Everything tinted is a
 * blend into the theme's own `base`, which is what keeps a wash subtle on a
 * dark palette and pale on a light one without either being special-cased.
 */
export function cssVariables(palette: Palette): Record<string, string> {
	const tint = (accent: string, amount: number): string =>
		mix(palette.base, accent, amount);
	return {
		"--base": palette.base,
		"--mantle": palette.mantle,
		"--surface": palette.surface,
		"--surface0": palette.surface0,
		"--surface0-dim": mix(palette.base, palette.surface0, 0.68),
		"--surface1": palette.surface1,
		"--text": palette.text,
		"--subtext": palette.subtext,
		"--overlay": palette.overlay,
		"--overlay-dim": palette.overlayDim,
		"--dim": palette.dim,
		"--mauve": palette.mauve,
		"--mauve-bright": mix(palette.mauve, "#ffffff", 0.3),
		"--mauve-dim": tint(palette.mauve, 0.13),
		"--mauve-border": tint(palette.mauve, 0.3),
		"--red": palette.red,
		"--red-dim": tint(palette.red, 0.1),
		"--red-border": tint(palette.red, 0.2),
		"--green": palette.green,
		"--green-dim": tint(palette.green, 0.37),
		"--green-bg": tint(palette.green, 0.16),
		"--green-border": tint(palette.green, 0.28),
		"--yellow": palette.yellow,
		"--peach": palette.peach,
		"--blue": palette.blue,
		"--teal": palette.teal,
		"--sky": palette.sky,
		"--pink": palette.pink,
		"--panel-editor": palette.panelEditor ?? palette.surface,
		"--panel-side": palette.panelSide ?? palette.mantle,
		"--panel-border": palette.panelBorder ?? palette.base,
	};
}
