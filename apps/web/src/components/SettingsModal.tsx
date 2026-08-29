import type React from "react";
import { useEffect, useState } from "react";
import { VALUE_FMTS, type ValueFmt } from "../lowlevel.js";
import { Lucide } from "./Lucide.js";

import {
	APP_FONTS,
	APP_SIZES,
	APP_THEMES,
	LEADER_OPTIONS,
	type LeaderKey,
} from "../state/appearance.js";
import { paletteOf, type AppTheme, type Palette } from "../state/themes.js";

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
	fontIndex: number;
	onFont: (index: number) => void;
	sizeIndex: number;
	onSize: (index: number) => void;
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
	fontIndex,
	onFont,
	sizeIndex,
	onSize,
	leader,
	onLeader,
	onClose,
}: SettingsModalProps): React.JSX.Element {
	const [tab, setTab] = useState<TabId>("run");

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

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
								<div className="settings-pills">
									{APP_FONTS.map((font, index) => (
										<button
											className={fontIndex === index ? "active" : ""}
											key={font.label}
											onClick={() => onFont(index)}
											style={{ fontFamily: font.css }}
										>
											{font.label}
										</button>
									))}
								</div>
								<div className="settings-sizes">
									<span>Size</span>
									{APP_SIZES.map((size, index) => (
										<button
											className={sizeIndex === index ? "active" : ""}
											key={size}
											onClick={() => onSize(index)}
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
							<div className="settings-pills">
								{LEADER_OPTIONS.map((option) => (
									<button
										className={leader === option.id ? "active" : ""}
										key={option.id}
										onClick={() => onLeader(option.id)}
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
