import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { VALUE_FMTS, type ValueFmt } from "../lowlevel.js";
import { Lucide } from "./Lucide.js";

import {
	APP_THEMES,
	isUsableLeader,
	leaderLabel,
	LEADER_OPTIONS,
	type LeaderKey,
} from "../shared/stores/appearance.js";
import {
	APP_SIZES,
	detectAvailableFonts,
	fontStack,
	MONO_FONTS,
} from "../shared/lib/fonts.js";
import { paletteOf, type AppTheme, type Palette } from "../shared/lib/themes.js";

/** Which tab a behaviour toggle belongs to. */
export type ToggleGroup = "run" | "editor" | "appearance";

interface Toggle {
	label: string;
	hint: string;
	group: ToggleGroup;
	on: boolean;
	disabled?: boolean;
	act: () => void;
}

const TABS = [
	{ id: "run", label: "Run", icon: "play" },
	{ id: "editor", label: "Editor", icon: "code" },
	{ id: "appearance", label: "Appearance", icon: "palette" },
	{ id: "keyboard", label: "Keyboard", icon: "keyboard" },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface SettingsModalProps {
	toggles: Toggle[];
	valueFmt: ValueFmt;
	onValueFmt: (fmt: ValueFmt) => void;
	theme: AppTheme;
	onTheme: (theme: AppTheme) => void;
	/** Hovering a theme paints the window without committing to it. */
	previewTheme: AppTheme | undefined;
	onPreview: (theme: AppTheme | undefined) => void;
	font: string;
	onFont: (id: string) => void;
	fontSize: number;
	onSize: (size: number) => void;
	leader: LeaderKey;
	onLeader: (leader: LeaderKey) => void;
	onClose: () => void;
}

/**
 * A miniature of the editor in a palette: enough of the real thing —
 * gutter, keywords, a string, a comment, the status strip — to tell two
 * themes apart without applying either.
 */
function ThemePreview({ palette }: { palette: Palette }): React.JSX.Element {
	return (
		<div
			className="theme-preview"
			style={{
				background: palette.panelBorder ?? palette.base,
				borderColor: palette.surface0,
			}}
		>
			<div
				className="theme-preview-side"
				style={{ background: palette.panelSide ?? palette.mantle }}
			>
				<span style={{ background: palette.surface1 }} />
				<span style={{ background: palette.surface0 }} />
				<span style={{ background: palette.surface0 }} />
			</div>
			<div
				className="theme-preview-code"
				style={{
					background: palette.panelEditor ?? palette.surface,
					color: palette.text,
				}}
			>
				<div>
					<span style={{ color: palette.dim }}>1</span>
					<span style={{ color: palette.mauve, fontWeight: 700 }}>const</span>
					<span style={{ color: palette.text }}>std</span>
					<span style={{ color: palette.sky }}>=</span>
					<span style={{ color: palette.peach }}>@import</span>
					<span style={{ color: palette.green }}>&quot;std&quot;</span>
				</div>
				<div>
					<span style={{ color: palette.dim }}>2</span>
					<span style={{ color: palette.mauve, fontWeight: 700 }}>fn</span>
					<span style={{ color: palette.blue }}>main</span>
					<span style={{ color: palette.yellow }}>!void</span>
				</div>
				<div>
					<span style={{ color: palette.dim }}>3</span>
					<span style={{ color: palette.overlayDim, fontStyle: "italic" }}>
						{"// inline values"}
					</span>
					<span style={{ color: palette.teal }}>42</span>
				</div>
				<div>
					<span style={{ color: palette.dim }}>4</span>
					<span style={{ color: palette.red }}>error</span>
					<span style={{ color: palette.yellow }}>warn</span>
					<span style={{ color: palette.subtext }}>ok</span>
				</div>
			</div>
		</div>
	);
}

function ToggleRow({ toggle }: { toggle: Toggle }): React.JSX.Element {
	return (
		<button
			className="settings-toggle"
			disabled={toggle.disabled}
			onClick={toggle.act}
		>
			<span className="settings-toggle-label">{toggle.label}</span>
			{toggle.hint && (
				<span className="settings-toggle-hint">{toggle.hint}</span>
			)}
			<span className={`switch${toggle.on ? " on" : ""}`}>
				<span className="knob" />
			</span>
		</button>
	);
}

/**
 * Preferences dialog (⌘,), split into tabs by what a setting affects rather
 * than one long scroll: Run, Editor, Appearance and Keyboard.
 */
export function SettingsModal({
	toggles,
	valueFmt,
	onValueFmt,
	theme,
	onTheme,
	previewTheme,
	onPreview,
	font,
	onFont,
	fontSize,
	onSize,
	leader,
	onLeader,
	onClose,
}: SettingsModalProps): React.JSX.Element {
	const [tab, setTab] = useState<TabId>("run");

	const [capturing, setCapturing] = useState(false);
	// Measuring every family touches the canvas, so do it once per opening
	// rather than on each render.
	const installed = useMemo(() => detectAvailableFonts(), []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				// While recording, Escape backs out of the recording only —
				// otherwise there would be no way to change your mind.
				if (capturing) setCapturing(false);
				else onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [capturing, onClose]);

	// Recording swallows the next key press, whatever it is: the dialog's own
	// shortcuts must not fire while the point is to capture them.
	useEffect(() => {
		if (!capturing) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			// A modifier on its own is the user still reaching for the key.
			if (!isUsableLeader(event.key)) return;
			onLeader(event.key);
			setCapturing(false);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [capturing, onLeader]);

	const groupToggles = (group: ToggleGroup): Toggle[] =>
		toggles.filter((toggle) => toggle.group === group);

	return (
		<div
			className="settings-backdrop"
			onClick={onClose}
			onKeyDown={() => {}}
			role="presentation"
		>
			<div
				className="settings-modal"
				onClick={(event) => event.stopPropagation()}
				onKeyDown={() => {}}
				role="dialog"
				aria-label="Settings"
			>
				<header className="settings-header">
					<Lucide icon="settings" size={15} />
					<span>Settings</span>
					<button className="settings-close" onClick={onClose} title="Close">
						<Lucide icon="x" size={14} />
					</button>
				</header>

				<div className="settings-tabs" role="tablist">
					{TABS.map((entry) => (
						<button
							aria-selected={tab === entry.id}
							className={`settings-tab${tab === entry.id ? " active" : ""}`}
							key={entry.id}
							onClick={() => setTab(entry.id)}
							role="tab"
						>
							<Lucide icon={entry.icon} size={13} />
							{entry.label}
						</button>
					))}
				</div>

				<div className="settings-body">
					{tab === "run" && (
						<>
							<section className="settings-section">
								<div className="settings-title">Behaviour</div>
								{groupToggles("run").map((toggle) => (
									<ToggleRow key={toggle.label} toggle={toggle} />
								))}
							</section>
							<section className="settings-section">
								<div className="settings-title">Inline values</div>
								<div className="settings-pills fmt-switch">
									{VALUE_FMTS.map((fmt, index) => (
										<button
											className={valueFmt === fmt ? "active" : ""}
											key={fmt}
											onClick={() => onValueFmt(fmt)}
											title={`⌘${index + 1}`}
										>
											{fmt}
										</button>
									))}
								</div>
							</section>
						</>
					)}

					{tab === "editor" && (
						<section className="settings-section">
							<div className="settings-title">Editor</div>
							{groupToggles("editor").map((toggle) => (
								<ToggleRow key={toggle.label} toggle={toggle} />
							))}
						</section>
					)}

					{tab === "appearance" && (
						<>
							<section className="settings-section">
								<div className="settings-title">Theme</div>
								<ThemePreview palette={paletteOf(previewTheme ?? theme)} />
								<div
									className="theme-grid"
									onMouseLeave={() => onPreview(undefined)}
								>
									{APP_THEMES.map((entry) => (
										<button
											className={`theme-card${theme === entry.id ? " active" : ""}`}
											key={entry.id}
											onClick={() => onTheme(entry.id)}
											onFocus={() => onPreview(entry.id)}
											onMouseEnter={() => onPreview(entry.id)}
										>
											<span className="theme-swatches">
												<span
													style={{ background: entry.palette.surface }}
												/>
												<span style={{ background: entry.palette.mauve }} />
												<span style={{ background: entry.palette.green }} />
												<span style={{ background: entry.palette.peach }} />
											</span>
											{entry.label}
										</button>
									))}
								</div>
							</section>
							<section className="settings-section">
								<div className="settings-title">Typography</div>
								<div className="font-grid">
									{MONO_FONTS
										// Installed first: what you can actually use here.
										.toSorted(
											(left, right) =>
												Number(installed.has(right.id)) -
												Number(installed.has(left.id)),
										)
										.map((entry) => {
											const here = installed.has(entry.id);
											return (
												<button
													className={`font-card${font === entry.id ? " active" : ""}${here ? "" : " missing"}`}
													key={entry.id}
													onClick={() => onFont(entry.id)}
													style={here ? { fontFamily: fontStack(entry.id) } : {}}
													title={
														here
															? entry.label
															: `${entry.label} — not installed on this device`
													}
												>
													{entry.label}
													{!here && <span className="font-missing">·</span>}
												</button>
											);
										})}
								</div>
								<div className="settings-sizes">
									<span>Size</span>
									{APP_SIZES.map((size) => (
										<button
											className={fontSize === size ? "active" : ""}
											key={size}
											onClick={() => onSize(size)}
										>
											{size}
										</button>
									))}
								</div>
							</section>
							<section className="settings-section">
								<div className="settings-title">Window</div>
								{groupToggles("appearance").map((toggle) => (
									<ToggleRow key={toggle.label} toggle={toggle} />
								))}
							</section>
						</>
					)}

					{tab === "keyboard" && (
						<section className="settings-section">
							<div className="settings-title">Leader key</div>
							<div className="leader-row">
								<button
									className={`leader-capture${capturing ? " capturing" : ""}`}
									onClick={() => setCapturing((previous) => !previous)}
								>
									{capturing ? (
										"Press any key…"
									) : (
										<>
											Leader is <kbd>{leaderLabel(leader)}</kbd>
										</>
									)}
								</button>
								{capturing && (
									<span className="settings-toggle-hint">
										Esc to keep the current one
									</span>
								)}
							</div>
							<div className="settings-pills">
								{LEADER_OPTIONS.map((option) => (
									<button
										className={leader === option.key ? "active" : ""}
										key={option.key}
										onClick={() => onLeader(option.key)}
									>
										{option.label}
									</button>
								))}
							</div>
							<div className="settings-toggle-hint">
								leader+e tree · leader+t terminal · leader+h/l switches panel ·
								leader+o closes the other tabs · Shift+H/L cycles tabs ·
								j/k navigate
							</div>
						</section>
					)}
				</div>
			</div>
		</div>
	);
}
