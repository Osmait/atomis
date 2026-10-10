import type React from "react";
import { MAX_INPUT_BYTES } from "@atomis/protocol";
import { inputBytes } from "../runtime/useRunInput.js";

interface InputPanelProps {
	value: string;
	onChange: (text: string) => void;
}

/** "3 lines", counting a last line without its newline. */
export function lineCountLabel(text: string): string {
	if (!text) return "empty";
	const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

function sizeLabel(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * The Input view: the text every run's program reads on stdin. A run never
 * waits for typing — reading past the end gives end of file, as from a
 * redirected file — so it works under Auto Run, with probes and tests.
 */
export function InputPanel(props: InputPanelProps): React.JSX.Element {
	const bytes = inputBytes(props.value);
	const tooLarge = bytes > MAX_INPUT_BYTES;
	return (
		<div className="input-panel">
			<p className="input-hint">
				Every run reads this on standard input — <code>input()</code>,{" "}
				<code>scanf</code>, <code>read_line</code>, <code>bufio.Scanner</code>…
				— then end of file.
			</p>
			<textarea
				aria-label="Program input"
				aria-invalid={tooLarge}
				className="input-text"
				onChange={(event) => props.onChange(event.target.value)}
				placeholder={"3\n5 7 9"}
				spellCheck={false}
				value={props.value}
			/>
			<footer className="input-footer">
				<span>{lineCountLabel(props.value)}</span>
				<span className={tooLarge ? "input-too-large" : ""}>
					{sizeLabel(bytes)} / 512 KiB
				</span>
				{props.value && (
					<button onClick={() => props.onChange("")}>Clear</button>
				)}
			</footer>
			{tooLarge && (
				<p className="input-too-large" role="alert">
					Too large to send: runs keep reading the last input that fit.
				</p>
			)}
		</div>
	);
}
