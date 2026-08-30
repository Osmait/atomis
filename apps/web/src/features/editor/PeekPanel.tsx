import type React from "react";
import type { Language } from "@atomis/protocol";
import {
	applyBitop,
	bitArray,
	bitsForType,
	bytesLE,
	flipBit,
	formatInt,
	parseBitopLine,
	parseIntegerPreview,
	type ValueFmt,
} from "../../shared/lib/lowlevel.js";
import type { InlineValue } from "../../shared/lib/runtimeState.js";

interface PeekPanelProps {
	value: InlineValue;
	lineText: string;
	language: Language;
	fmt: ValueFmt;
	override: bigint | undefined;
	previousValue: bigint | undefined;
	onFlip: (next: bigint) => void;
	onReset: () => void;
	onClose: () => void;
}

/**
 * Anchored low-level inspector for one probed value: bit grid (clickable,
 * local what-if flips), bit-operation rows, little-endian memory bytes,
 * struct field layout and base conversions. Rendered inside a Monaco view
 * zone under the probe's line.
 */
export function PeekPanel({
	value,
	lineText,
	language,
	fmt,
	override,
	previousValue,
	onFlip,
	onReset,
	onClose,
}: PeekPanelProps): React.JSX.Element {
	const width = value.bits ?? bitsForType(value.typeName, language);
	const parsed = parseIntegerPreview(value.preview);
	const current = override ?? parsed;
	const isInt = current !== undefined && width !== undefined;
	const showBits = isInt && width <= 64;
	const showBytes = isInt && width >= 8 && width <= 128;

	const bitop = isInt ? parseBitopLine(lineText) : undefined;
	const previous = override === undefined ? previousValue : undefined;
	const bitopValid =
		bitop !== undefined &&
		previous !== undefined &&
		parsed !== undefined &&
		width !== undefined &&
		applyBitop(previous, bitop, width) ===
			applyBitop(parsed, { operator: "|", operand: 0n }, width);

	const shortType = value.fields
		? (value.typeName.split(".").pop() ?? value.typeName)
		: value.typeName;
	const subParts = [shortType];
	if (width !== undefined) subParts.push(`${width} bits`);
	else if (value.sizeBytes !== undefined)
		subParts.push(`${value.sizeBytes} B`);

	return (
		<div className="peek-panel">
			<header className="peek-header">
				<b>{value.name}</b>
				<span className="peek-sub">{subParts.join(" · ")}</span>
				<span className="peek-actions">
					{override !== undefined && (
						<button onClick={onReset} title="Restore the real value">
							reset
						</button>
					)}
					<button onClick={onClose} title="Close (click the value)">
						esc
					</button>
				</span>
			</header>

			{showBits && (
				<div className="peek-bits">
					{bitArray(current, width).map((bit, index) => (
						<button
							className={`peek-bit${bit ? " on" : ""}`}
							key={`bit-${width - 1 - index}`}
							onClick={() => onFlip(flipBit(current, width, index))}
							title={`bit ${width - 1 - index}`}
						>
							<span>{bit}</span>
							<em>{width - 1 - index}</em>
						</button>
					))}
				</div>
			)}

			{bitopValid && previous !== undefined && width !== undefined && (
				<div className="peek-bitop">
					{(
						[
							["", previous],
							[bitop.operator, bitop.operand],
							["=", parsed ?? 0n],
						] as const
					).map(([label, rowValue], rowIndex) => (
						<div
							className={`peek-bitop-row${rowIndex === 2 ? " result" : ""}`}
							key={label || "a"}
						>
							<span className="peek-bitop-op">{label}</span>
							{bitArray(rowValue, width).map((bit, index) => (
								<span
									className={`peek-cell${bit ? " on" : ""}`}
									key={`cell-${width - 1 - index}`}
								>
									{bit}
								</span>
							))}
						</div>
					))}
				</div>
			)}

			{showBytes && (
				<div className="peek-bytes">
					<span className="peek-bytes-label">
						bytes en memoria (little endian)
					</span>
					<div className="peek-bytes-row">
						{bytesLE(current, width).map((byte, index) => (
							<span className="peek-byte" key={`byte-${index}`}>
								<b>{byte.toString(16).toUpperCase().padStart(2, "0")}</b>
								<em>+{index}</em>
							</span>
						))}
					</div>
				</div>
			)}

			{value.fields && value.fields.length > 0 && (
				<div className="peek-fields">
					<div className="peek-field-row peek-field-head">
						<span>field</span>
						<span>type</span>
						<span>offset</span>
						<span>size</span>
						<span>value</span>
					</div>
					{value.fields.map((field) => {
						const fieldInt = parseIntegerPreview(field.preview);
						const fieldBits = bitsForType(field.typeName, language);
						return (
							<div className="peek-field-row" key={field.name}>
								<span className="peek-field-name">{field.name}</span>
								<span className="peek-field-type">{field.typeName}</span>
								<span>+{field.offset}</span>
								<span>{field.size} B</span>
								<span className="peek-field-value">
									{fieldInt !== undefined
										? formatInt(fieldInt, fieldBits ?? field.size * 8, fmt)
										: field.preview}
								</span>
							</div>
						);
					})}
				</div>
			)}

			<div className="peek-rows">
				{value.sizeBytes !== undefined && (
					<div className="peek-kv">
						<span>size</span>
						<b>{value.sizeBytes} B</b>
					</div>
				)}
				{value.alignBytes !== undefined && (
					<div className="peek-kv">
						<span>align</span>
						<b>{value.alignBytes}</b>
					</div>
				)}
				{isInt && (
					<>
						<div className="peek-kv">
							<span>dec</span>
							<b>{formatInt(current, width, "dec")}</b>
						</div>
						<div className="peek-kv">
							<span>hex</span>
							<b>{formatInt(current, width, "hex")}</b>
						</div>
						<div className="peek-kv">
							<span>oct</span>
							<b>{formatInt(current, width, "oct")}</b>
						</div>
						<div className="peek-kv">
							<span>bin</span>
							<b>{formatInt(current, width, "bin")}</b>
						</div>
					</>
				)}
			</div>

			<div className="peek-note">
				{override !== undefined
					? "bits edited locally · the program never changes — reset to go back"
					: value.fields
						? "compiler-real offsets and sizes"
						: "click a bit to try local what-ifs"}
			</div>
		</div>
	);
}
