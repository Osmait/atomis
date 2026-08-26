const HEADER_END = Buffer.from("\r\n\r\n");

export class LspFramingError extends Error {}

export class LspFramer {
	private buffer = Buffer.alloc(0);
	private expectedBody: number | undefined;

	public constructor(private readonly maxMessageBytes = 8 * 1024 * 1024) {}

	public push(chunk: Buffer | Uint8Array): unknown[] {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
		const messages: unknown[] = [];
		while (true) {
			if (this.expectedBody === undefined) {
				const end = this.buffer.indexOf(HEADER_END);
				if (end < 0) {
					if (this.buffer.length > 8192)
						throw new LspFramingError("LSP header exceeds 8 KiB");
					break;
				}
				const header = this.buffer.subarray(0, end).toString("ascii");
				this.buffer = this.buffer.subarray(end + HEADER_END.length);
				const lengths = header
					.split("\r\n")
					.filter((line) => /^content-length:/i.test(line));
				if (lengths.length !== 1)
					throw new LspFramingError(
						"LSP frame must contain one Content-Length header",
					);
				const raw = lengths[0]?.slice(lengths[0].indexOf(":") + 1).trim() ?? "";
				if (!/^\d+$/.test(raw))
					throw new LspFramingError("Invalid LSP Content-Length");
				const length = Number(raw);
				if (
					!Number.isSafeInteger(length) ||
					length <= 0 ||
					length > this.maxMessageBytes
				) {
					throw new LspFramingError(
						`LSP body length ${raw} is outside the limit`,
					);
				}
				this.expectedBody = length;
			}
			if (this.buffer.length < this.expectedBody) break;
			const body = this.buffer.subarray(0, this.expectedBody);
			this.buffer = this.buffer.subarray(this.expectedBody);
			this.expectedBody = undefined;
			try {
				messages.push(JSON.parse(body.toString("utf8")) as unknown);
			} catch (error) {
				throw new LspFramingError(
					`Invalid LSP JSON: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return messages;
	}

	public end(): void {
		if (this.buffer.length !== 0 || this.expectedBody !== undefined)
			throw new LspFramingError("LSP stream closed inside a frame");
	}

	public static frame(message: unknown): Buffer {
		const body = Buffer.from(JSON.stringify(message), "utf8");
		return Buffer.concat([
			Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
			body,
		]);
	}
}
