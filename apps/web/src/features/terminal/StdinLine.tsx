import type React from "react";
import { useState } from "react";

interface StdinLineProps {
	/** A line the program reads, newline included. */
	onSend: (text: string) => void;
	/** End of file, after whatever is typed (Ctrl+D). */
	onEof: (text: string) => void;
}

/**
 * Where an interactive run's program gets its input: under the output it
 * answers, while it runs. Enter sends the line; Ctrl+D — or EOF, for a
 * keyboard without one — ends the input, as in a terminal.
 */
export function StdinLine(props: StdinLineProps): React.JSX.Element {
	const [value, setValue] = useState("");
	return (
		<form
			className="stdin-line"
			onSubmit={(event) => {
				event.preventDefault();
				props.onSend(`${value}\n`);
				setValue("");
			}}
		>
			<span aria-hidden className="stdin-prompt">
				stdin ›
			</span>
			<input
				aria-label="Input for the running program"
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				// The program is waiting on this field: focus is where typing
				// should go the moment it appears.
				autoFocus
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					// Keys typed for the program are not editor shortcuts.
					event.stopPropagation();
					if (event.key === "d" && event.ctrlKey) {
						event.preventDefault();
						props.onEof(value);
						setValue("");
					}
				}}
				spellCheck={false}
				value={value}
			/>
			<button type="submit">Send</button>
			<button
				onClick={() => {
					props.onEof(value);
					setValue("");
				}}
				title="End of file (Ctrl+D)"
				type="button"
			>
				EOF
			</button>
		</form>
	);
}
