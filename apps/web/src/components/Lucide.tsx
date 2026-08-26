import type React from "react";
import activity from "lucide-static/icons/activity.svg?raw";
import chevronDown from "lucide-static/icons/chevron-down.svg?raw";
import chevronRight from "lucide-static/icons/chevron-right.svg?raw";
import chevronUp from "lucide-static/icons/chevron-up.svg?raw";
import circleCheck from "lucide-static/icons/circle-check.svg?raw";
import circleDashed from "lucide-static/icons/circle-dashed.svg?raw";
import circleX from "lucide-static/icons/circle-x.svg?raw";
import ellipsisVertical from "lucide-static/icons/ellipsis-vertical.svg?raw";
import eraser from "lucide-static/icons/eraser.svg?raw";
import flaskConical from "lucide-static/icons/flask-conical.svg?raw";
import maximize2 from "lucide-static/icons/maximize-2.svg?raw";
import minimize2 from "lucide-static/icons/minimize-2.svg?raw";
import panelBottom from "lucide-static/icons/panel-bottom.svg?raw";
import panelLeft from "lucide-static/icons/panel-left.svg?raw";
import panelRight from "lucide-static/icons/panel-right.svg?raw";
import play from "lucide-static/icons/play.svg?raw";
import search from "lucide-static/icons/search.svg?raw";
import settings from "lucide-static/icons/settings.svg?raw";
import square from "lucide-static/icons/square.svg?raw";
import terminal from "lucide-static/icons/terminal.svg?raw";
import triangleAlert from "lucide-static/icons/triangle-alert.svg?raw";
import x from "lucide-static/icons/x.svg?raw";

const ICONS = {
	activity,
	"chevron-down": chevronDown,
	"chevron-right": chevronRight,
	"chevron-up": chevronUp,
	"circle-check": circleCheck,
	"circle-dashed": circleDashed,
	"circle-x": circleX,
	"ellipsis-vertical": ellipsisVertical,
	eraser,
	"flask-conical": flaskConical,
	"maximize-2": maximize2,
	"minimize-2": minimize2,
	"panel-bottom": panelBottom,
	"panel-left": panelLeft,
	"panel-right": panelRight,
	play,
	search,
	settings,
	square,
	terminal,
	"triangle-alert": triangleAlert,
	x,
} as const;

export type LucideIcon = keyof typeof ICONS;

/**
 * Lucide icon inlined as SVG markup (stroke="currentColor" inherits the text
 * color). Inline SVG works in every browser — CSS masks proved unreliable —
 * and Vite bundles the ?raw imports offline.
 */
export function Lucide({
	icon,
	size = 14,
}: {
	icon: LucideIcon;
	size?: number;
}): React.JSX.Element {
	return (
		<span
			aria-hidden
			className="lucide"
			// biome-ignore lint: static bundled SVG markup from lucide-static
			dangerouslySetInnerHTML={{ __html: ICONS[icon] }}
			style={{ width: size, height: size }}
		/>
	);
}
