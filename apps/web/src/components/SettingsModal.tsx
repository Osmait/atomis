import type React from "react";
import { useEffect } from "react";
import { VALUE_FMTS, type ValueFmt } from "../lowlevel.js";
import { Lucide } from "./Lucide.js";

import {
	APP_FONTS,
	APP_SIZES,
	APP_THEMES,
	LEADER_OPTIONS,
	type AppTheme,
	type LeaderKey,
} from "../state/appearance.js";

interface Toggle {
	label: string;
	hint: string;
	on: boolean;
	disabled?: boolean;
	act: () => void;
}

interface SettingsModalProps {
	toggles: Toggle[];
	valueFmt: ValueFmt;
	onValueFmt: (fmt: ValueFmt) => void;
	theme: AppTheme;
	onTheme: (theme: AppTheme) => void;
	fontIndex: number;
	onFont: (index: number) => void;
	sizeIndex: number;
	onSize: (index: number) => void;
	leader: LeaderKey;
	onLeader: (leader: LeaderKey) => void;
	onClose: () => void;
}

/** Preferences dialog (⌘,): behaviour toggles, inline-value format, theme
 * and typography — the design's Ajustes modal. */
export function SettingsModal({
	toggles,
	valueFmt,
	onValueFmt,
	theme,
	onTheme,
	fontIndex,
	onFont,
	sizeIndex,
	onSize,
	leader,
	onLeader,
	onClose,
}: SettingsModalProps): React.JSX.Element {
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
				aria-label="Ajustes"
			>
				<header className="settings-header">
					<Lucide icon="settings" size={15} />
					<span>Ajustes</span>
					<button className="settings-close" onClick={onClose} title="Cerrar">
						<Lucide icon="x" size={14} />
					</button>
				</header>

				<section className="settings-section">
					<div className="settings-title">Comportamiento</div>
					{toggles.map((toggle) => (
						<button
							className="settings-toggle"
							disabled={toggle.disabled}
							key={toggle.label}
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
					))}
				</section>

				<section className="settings-section">
					<div className="settings-title">Valores en línea</div>
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

				<section className="settings-section">
					<div className="settings-title">Tema</div>
					<div className="settings-pills">
						{APP_THEMES.map((entry) => (
							<button
								className={`theme-pill${theme === entry.id ? " active" : ""}`}
								key={entry.id}
								onClick={() => onTheme(entry.id)}
							>
								<span
									className="theme-dot"
									style={{ background: entry.dot }}
								/>
								{entry.label}
							</button>
						))}
					</div>
				</section>

				<section className="settings-section">
					<div className="settings-title">Tipografía</div>
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
						<span>Tamaño</span>
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
					<div className="settings-title">Teclado</div>
					<div className="settings-toggle-hint">
						leader+e árbol · leader+t terminal · leader+h/l cambia de panel ·
						leader+o cierra otras pestañas · Shift+H/L cambia de pestaña ·
						j/k navegan
					</div>
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
				</section>
			</div>
		</div>
	);
}
