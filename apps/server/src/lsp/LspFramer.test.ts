import { describe, expect, it } from "vitest";
import { LspFramer, LspFramingError } from "./LspFramer.js";

describe("LspFramer", () => {
	it("handles fragmented header and body", () => {
		const frame = LspFramer.frame({ jsonrpc: "2.0", result: "😀" });
		const framer = new LspFramer();
		const output = [
			frame.subarray(0, 5),
			frame.subarray(5, 25),
			frame.subarray(25, frame.length - 2),
			frame.subarray(frame.length - 2),
		].flatMap((part) => framer.push(part));
		expect(output).toEqual([{ jsonrpc: "2.0", result: "😀" }]);
	});
	it("handles concatenated frames", () => {
		const framer = new LspFramer();
		expect(
			framer.push(
				Buffer.concat([LspFramer.frame({ id: 1 }), LspFramer.frame({ id: 2 })]),
			),
		).toEqual([{ id: 1 }, { id: 2 }]);
	});
	it("uses UTF-8 byte lengths", () => {
		const frame = LspFramer.frame({ value: "é😀" });
		expect(new LspFramer().push(frame)).toEqual([{ value: "é😀" }]);
	});
	it("rejects invalid and oversized lengths", () => {
		expect(() =>
			new LspFramer().push(Buffer.from("Content-Length: nope\r\n\r\n{}")),
		).toThrow(LspFramingError);
		expect(() =>
			new LspFramer(2).push(Buffer.from("Content-Length: 3\r\n\r\n{} ")),
		).toThrow(/limit/);
	});
	it("detects unexpected close", () => {
		const framer = new LspFramer();
		framer.push(Buffer.from("Content-Length: 9\r\n\r\n{}"));
		expect(() => framer.end()).toThrow(/inside a frame/);
	});
});
