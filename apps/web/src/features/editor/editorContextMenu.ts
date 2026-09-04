export interface EditorContextMenuState {
	x: number;
	y: number;
	copyText?: string;
	copyLabel?: string;
	allowPaste?: boolean;
}

interface ContextualCopy {
	text: string;
	label: string;
}

const COPY_TARGETS: ReadonlyArray<{
	selector: string;
	label: string;
}> = [
	{ selector: ".error-lens-message", label: "Copy diagnostic" },
	{ selector: ".test-lens-message", label: "Copy test result" },
	{ selector: ".inline-value", label: "Copy value" },
	{ selector: ".inline-log", label: "Copy log" },
	{ selector: ".monaco-hover", label: "Copy hover" },
];

function asElement(target: EventTarget | null): Element | null {
	if (target instanceof Element) return target;
	return target instanceof Node ? target.parentElement : null;
}

function normalizeCopyText(text: string): string {
	return text
		.replaceAll("\u00A0", " ")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function selectionInside(
	container: Element,
	selection: Selection | null,
): string | undefined {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return undefined;
	}
	const commonAncestor = selection.getRangeAt(0).commonAncestorContainer;
	const commonElement =
		commonAncestor instanceof Element
			? commonAncestor
			: commonAncestor.parentElement;
	if (!commonElement || !container.contains(commonElement)) return undefined;
	const selectedText = normalizeCopyText(selection.toString());
	return selectedText || undefined;
}

/** Return the visible, non-model text represented by the clicked editor widget. */
export function getContextualEditorCopy(
	target: EventTarget | null,
	selection: Selection | null = window.getSelection(),
): ContextualCopy | undefined {
	const element = asElement(target);
	if (!element) return undefined;
	for (const candidate of COPY_TARGETS) {
		const container = element.closest(candidate.selector);
		if (!container) continue;
		const selectedText = selectionInside(container, selection);
		const visibleText = normalizeCopyText(
			container instanceof HTMLElement
				? container.innerText || container.textContent || ""
				: container.textContent || "",
		);
		const text = selectedText ?? visibleText;
		return text ? { text, label: candidate.label } : undefined;
	}
	return undefined;
}

/** Tell a reference peek's Monaco instance apart from the main editor. */
export function isNestedMonacoEditor(
	target: EventTarget | null,
): boolean {
	const element = asElement(target);
	const closestEditor = element?.closest(".monaco-editor");
	return Boolean(closestEditor?.parentElement?.closest(".monaco-editor"));
}

export function getMonacoEditorTarget(
	target: EventTarget | null,
): HTMLElement | null {
	const editor = asElement(target)?.closest(".monaco-editor");
	return editor instanceof HTMLElement ? editor : null;
}
