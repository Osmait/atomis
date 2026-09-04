// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../../shared/stores/appearance.js";
import { SettingsModal } from "./SettingsModal.js";

vi.mock("../../shared/lib/fonts.js", () => ({
	APP_SIZES: [13],
	DEFAULT_FONT: "jetbrains",
	DEFAULT_SIZE: 13,
	detectAvailableFonts: () => new Set(["jetbrains"]),
	fontStack: () => "monospace",
	isAppSize: (size: number) => size === 13,
	MONO_FONTS: [
		{
			id: "jetbrains",
			label: "JetBrains Mono",
			family: "JetBrains Mono",
			bundled: true,
		},
	],
}));

afterEach(cleanup);

describe("SettingsModal default template", () => {
	it("lists every template, marks the current one, and reports changes", () => {
		const onDefaultTemplate = vi.fn();
		render(
			<SettingsModal
				defaultTemplate="zig"
				font={DEFAULT_APPEARANCE.font}
				fontSize={DEFAULT_APPEARANCE.fontSize}
				leader={DEFAULT_APPEARANCE.leader}
				onClose={vi.fn()}
				onDefaultTemplate={onDefaultTemplate}
				onFont={vi.fn()}
				onLeader={vi.fn()}
				onPreview={vi.fn()}
				onSize={vi.fn()}
				onTheme={vi.fn()}
				onValueFmt={vi.fn()}
				previewTheme={undefined}
				theme={DEFAULT_APPEARANCE.theme}
				toggles={[]}
				valueFmt="dec"
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
		const group = screen.getByRole("group", { name: "Default template" });
		expect(within(group).getAllByRole("button")).toHaveLength(7);
		expect(
			within(group).getByTitle("Start new workspaces with Zig").getAttribute(
				"aria-pressed",
			),
		).toBe("true");
		expect(screen.getByText("main.rs")).toBeTruthy();

		fireEvent.click(within(group).getByTitle("Start new workspaces with Rust"));
		expect(onDefaultTemplate).toHaveBeenCalledWith("rust");
	});
});
