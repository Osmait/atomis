import { open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DocumentSnapshot } from "@ziglive/protocol";

export class DocumentStore {
	private snapshot: DocumentSnapshot;

	public constructor(
		initial: DocumentSnapshot,
		private readonly sourcePath: string,
	) {
		this.snapshot = initial;
	}

	public current(): DocumentSnapshot {
		return this.snapshot;
	}

	public async update(
		version: number,
		source: string,
	): Promise<DocumentSnapshot> {
		if (version <= this.snapshot.version)
			throw new Error(
				`Regressive document version ${version}; current is ${this.snapshot.version}`,
			);
		const next: DocumentSnapshot = {
			...this.snapshot,
			version,
			source,
			updatedAt: Date.now(),
		};
		await this.atomicWrite(source);
		this.snapshot = next;
		return next;
	}

	private async atomicWrite(source: string): Promise<void> {
		const temporary = join(
			dirname(this.sourcePath),
			`.main-${process.pid}-${crypto.randomUUID()}.tmp`,
		);
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(source, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, this.sourcePath);
	}
}
