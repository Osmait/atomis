import type React from "react";
import { useState } from "react";
import type { Dependency, DepsState } from "@atomis/protocol";
import { Lucide } from "../../shared/ui/Lucide.js";

interface DepsPanelProps {
	supported: boolean;
	language: string;
	manifest?: string;
	inputHint?: string;
	runsUntrustedCode: boolean;
	dependencies: Dependency[];
	state: DepsState;
	error?: string;
	output: string[];
	sandboxed: boolean;
	onAdd: (name: string) => void;
	onRemove: (name: string) => void;
	onOpenManifest: (manifest: string) => void;
}

/**
 * The dependency view: what the workspace declares, a field to add more,
 * and the installer's own output. Installing is the one moment Atomis
 * reaches the network, so the panel says so plainly.
 */
export function DepsPanel(props: DepsPanelProps): React.JSX.Element {
	const [name, setName] = useState("");
	const busy = props.state === "installing" || props.state === "removing";

	if (!props.supported)
		return (
			<div className="deps-panel">
				<p className="empty-state">
					{props.language} has no package manager Atomis drives yet —
					dependencies stay manual here.
				</p>
			</div>
		);

	const submit = (): void => {
		const wanted = name.trim();
		if (!wanted || busy) return;
		props.onAdd(wanted);
		setName("");
	};

	return (
		<div className="deps-panel">
			<div className="deps-add">
				<input
					aria-label="Add dependency"
					disabled={busy}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Enter") submit();
					}}
					placeholder={props.inputHint ?? "package name"}
					spellCheck={false}
					value={name}
				/>
				<button
					className="deps-install"
					disabled={busy || !name.trim()}
					onClick={submit}
				>
					{props.state === "installing" ? (
						<>
							<span className="spin">⟳</span> installing
						</>
					) : (
						"install"
					)}
				</button>
			</div>

			<p className="deps-note">
				{props.sandboxed
					? "Installing is the only step allowed online, and only over HTTPS from inside the sandbox."
					: "Sandbox off: the installer runs with your permissions."}
				{props.runsUntrustedCode
					? " This manager runs the package's own install scripts."
					: ""}
			</p>

			{props.error && <p className="deps-error">{props.error}</p>}

			<div className="deps-list">
				{props.dependencies.map((dependency) => (
					<div className="deps-row" key={dependency.name}>
						<span className="deps-name">{dependency.name}</span>
						<span className="deps-version">{dependency.version}</span>
						<button
							aria-label={`Remove ${dependency.name}`}
							disabled={busy}
							onClick={() => props.onRemove(dependency.name)}
							title="Remove"
						>
							<Lucide icon="trash-2" size={13} />
						</button>
					</div>
				))}
				{!props.dependencies.length && !busy && (
					<p className="empty-state">
						no dependencies yet
						{props.manifest ? ` — they live in ${props.manifest}` : ""}
					</p>
				)}
			</div>

			{props.output.length > 0 && (
				<pre className="deps-output">{props.output.join("")}</pre>
			)}

			{props.manifest && (
				<button
					className="deps-manifest"
					onClick={() => props.onOpenManifest(props.manifest ?? "")}
				>
					open {props.manifest}
				</button>
			)}
		</div>
	);
}
