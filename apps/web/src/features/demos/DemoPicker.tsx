import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Language } from "@atomis/protocol";
import { WEB_LANGUAGE_PACKS } from "../editor/languagePacks.js";
import { FileIcon } from "../files/FileIcon.js";
import { Lucide } from "../../shared/ui/Lucide.js";
import { DEMO_KINDS, demosOf, type Demo, type DemoKind } from "./catalog.js";

interface DemoPickerProps {
	/** Whether this server can run a language; demos it cannot are shown, off. */
	runnable: (language: Language) => boolean;
	onOpen: (demo: Demo) => void;
	onClose: () => void;
	kinds?: readonly DemoKind[];
}

/** A kind matches on its own words; a language matches by name. */
function matches(kind: DemoKind, demo: Demo, query: string): boolean {
	if (!query) return true;
	const words = `${kind.title} ${kind.summary} ${WEB_LANGUAGE_PACKS[demo.language].label} ${demo.language}`;
	return query
		.toLowerCase()
		.split(/\s+/)
		.every((word) => words.toLowerCase().includes(word));
}

/**
 * The demo gallery: each idea once, with the languages it comes in. A demo
 * opens in a new scratch session, so trying one never touches your work.
 */
export function DemoPicker(props: DemoPickerProps): React.JSX.Element {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const { onClose } = props;

	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const groups = useMemo(
		() =>
			(props.kinds ?? DEMO_KINDS)
				.map((kind) => ({
					kind,
					demos: demosOf(kind).filter((demo) => matches(kind, demo, query.trim())),
				}))
				.filter((group) => group.demos.length > 0),
		[props.kinds, query],
	);
	const first = groups
		.flatMap((group) => group.demos)
		.find((demo) => props.runnable(demo.language));

	return (
		<div className="palette-overlay" onClick={onClose} role="presentation">
			<div
				aria-label="Demos"
				className="palette demo-picker"
				onClick={(event) => event.stopPropagation()}
				role="dialog"
			>
				<div className="palette-input-row">
					<span className="palette-glyph">
						<Lucide icon="flask-conical" size={14} />
					</span>
					<input
						aria-label="Filter demos"
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === "Enter" && first) props.onOpen(first);
						}}
						placeholder="Filter: repl, python, rust…"
						ref={inputRef}
						spellCheck={false}
						value={query}
					/>
				</div>
				<div className="palette-results">
					{groups.map(({ kind, demos }) => (
						<section className="demo-kind" key={kind.id}>
							<h3>{kind.title}</h3>
							<p>{kind.summary}</p>
							<div className="demo-languages">
								{demos.map((demo) => {
									const pack = WEB_LANGUAGE_PACKS[demo.language];
									const runnable = props.runnable(demo.language);
									return (
										<button
											aria-label={`${kind.title} in ${pack.label}`}
											className="demo-language"
											disabled={!runnable}
											key={demo.id}
											onClick={() => props.onOpen(demo)}
											title={runnable ? `Open in ${pack.label}` : `${pack.label} is not installed here`}
										>
											<FileIcon path={pack.entryFile} />
											<span>{pack.label}</span>
										</button>
									);
								})}
							</div>
						</section>
					))}
					{!groups.length && <p className="palette-empty">No demo matches.</p>}
				</div>
				<footer>
					Opens in a new scratch session — your workspace stays as it is.
				</footer>
			</div>
		</div>
	);
}
