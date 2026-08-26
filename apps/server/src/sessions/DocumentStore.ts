import { open, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentSnapshot as BaseDocumentSnapshot } from "@ziglive/protocol";

const MAX_PROJECT_FILES = 64;
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;

export interface ProjectFile {
	path: string;
	uri: string;
	source: string;
}

export type ProjectDocumentSnapshot = BaseDocumentSnapshot & {
	files: ProjectFile[];
};
type DocumentSnapshot = ProjectDocumentSnapshot;

export class DocumentStore {
	private snapshot: DocumentSnapshot;

	public constructor(
		initial: DocumentSnapshot,
		private readonly sourceRoot: string,
	) {
		this.snapshot = initial;
	}

	public current(): DocumentSnapshot {
		return this.snapshot;
	}

	public async update(
		version: number,
		path: string,
		source: string,
	): Promise<DocumentSnapshot> {
		this.assertVersion(version);
		if (!this.snapshot.files.some((file) => file.path === path))
			throw new Error(`File does not exist: ${path}`);
		const files = this.snapshot.files.map((file) =>
			file.path === path ? this.projectFile(path, source) : file,
		);
		this.assertProjectSize(files);
		await this.atomicWrite(path, source);
		return this.commit(version, files);
	}

	public async create(
		version: number,
		path: string,
		source: string,
	): Promise<DocumentSnapshot> {
		this.assertVersion(version);
		if (this.snapshot.files.length >= MAX_PROJECT_FILES)
			throw new Error(`A project can contain at most ${MAX_PROJECT_FILES} files`);
		if (this.snapshot.files.some((file) => file.path === path))
			throw new Error(`File already exists: ${path}`);
		const files = [...this.snapshot.files, this.projectFile(path, source)];
		this.assertProjectSize(files);
		await this.atomicWrite(path, source);
		return this.commit(version, files);
	}

	public async rename(
		version: number,
		path: string,
		newPath: string,
	): Promise<DocumentSnapshot> {
		this.assertVersion(version);
		if (path === "main.zig") throw new Error("main.zig cannot be renamed");
		const current = this.snapshot.files.find((file) => file.path === path);
		if (!current) throw new Error(`File does not exist: ${path}`);
		if (this.snapshot.files.some((file) => file.path === newPath))
			throw new Error(`File already exists: ${newPath}`);
		const destination = join(this.sourceRoot, newPath);
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await rename(join(this.sourceRoot, path), destination);
		return this.commit(
			version,
			this.snapshot.files.map((file) =>
				file.path === path ? this.projectFile(newPath, current.source) : file,
			),
		);
	}

	public async delete(version: number, path: string): Promise<DocumentSnapshot> {
		this.assertVersion(version);
		if (path === "main.zig") throw new Error("main.zig cannot be deleted");
		if (!this.snapshot.files.some((file) => file.path === path))
			throw new Error(`File does not exist: ${path}`);
		await rm(join(this.sourceRoot, path), { force: true });
		return this.commit(
			version,
			this.snapshot.files.filter((file) => file.path !== path),
		);
	}

	private assertVersion(version: number): void {
		if (version <= this.snapshot.version)
			throw new Error(
				`Regressive document version ${version}; current is ${this.snapshot.version}`,
			);
	}

	private assertProjectSize(files: ProjectFile[]): void {
		const bytes = files.reduce(
			(total, file) => total + Buffer.byteLength(file.source, "utf8"),
			0,
		);
		if (bytes > MAX_PROJECT_BYTES)
			throw new Error(`Project source exceeds ${MAX_PROJECT_BYTES} bytes`);
	}

	private projectFile(path: string, source: string): ProjectFile {
		return {
			path,
			uri: pathToFileURL(join(this.sourceRoot, path)).href,
			source,
		};
	}

	private commit(version: number, files: ProjectFile[]): DocumentSnapshot {
		const sorted = [...files].sort((left, right) =>
			left.path.localeCompare(right.path),
		);
		const main = sorted.find((file) => file.path === "main.zig");
		if (!main) throw new Error("Project entry point main.zig is missing");
		this.snapshot = {
			...this.snapshot,
			version,
			uri: main.uri,
			source: main.source,
			files: sorted,
			updatedAt: Date.now(),
		};
		return this.snapshot;
	}

	private async atomicWrite(path: string, source: string): Promise<void> {
		const destination = join(this.sourceRoot, path);
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		const temporary = join(
			dirname(destination),
			`.ziglive-${process.pid}-${crypto.randomUUID()}.tmp`,
		);
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(source, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, destination);
	}
}
