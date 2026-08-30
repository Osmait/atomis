/**
 * The wire contract, checked at compile time.
 *
 * The types in index.ts are hand-written; the ones under generated/ come
 * from the Rust types that actually serialize (`cargo test export_bindings`).
 * Both sides were maintained by hand until now, so a field added to one and
 * forgotten on the other failed at runtime, on a device, or not at all.
 *
 * Nothing imports this file: it exists to be type-checked. Every line below
 * is a claim that fails the build when it stops being true.
 */

import type * as Rust from "./generated/index.js";
import type {
	AppDiagnostic,
	CreateSessionResponse,
	Dependency,
	DepsState,
	Language,
	LogSourceLocation,
	ProbeDescriptor,
	ProjectFile,
	RunResult,
	RunState,
	RuntimeServerEvent,
	TestCase,
	TestStatus,
	WorkspaceMeta,
	WorkspaceScaffold,
} from "./index.js";

/**
 * `T` must be exactly `true`. A failed check yields `false`, which is
 * rejected here — where a check that yielded `never` would have been
 * accepted, since `never` extends everything.
 */
type Expect<T extends true> = T;

/**
 * Mutual assignability is not enough (`{a: string}` and `{a: string, b?: x}`
 * pass it both ways). Comparing the two in an invariant position is exact.
 */
type Identical<A, B> = (<G>() => G extends A ? 1 : 2) extends <
	G,
>() => G extends B ? 1 : 2
	? true
	: false;

type Assignable<A, B> = [A] extends [B] ? true : false;

export type WireContract = [
	Expect<Identical<AppDiagnostic, Rust.AppDiagnostic>>,
	Expect<Identical<Dependency, Rust.Dependency>>,
	Expect<Identical<DepsState, Rust.DepsState>>,
	Expect<Identical<Language, Rust.Language>>,
	Expect<Identical<LogSourceLocation, Rust.LogSourceLocation>>,
	Expect<Identical<ProbeDescriptor, Rust.ProbeDescriptor>>,
	Expect<Identical<ProjectFile, Rust.ProjectFile>>,
	Expect<Identical<RunResult, Rust.RunResult>>,
	Expect<Identical<RunState, Rust.RunState>>,
	Expect<Identical<TestCase, Rust.TestCase>>,
	Expect<Identical<TestStatus, Rust.TestStatus>>,
	Expect<Identical<WorkspaceMeta, Rust.WorkspaceMeta>>,
	Expect<Identical<WorkspaceScaffold, Rust.WorkspaceScaffold>>,

	/**
	 * Not identical by design: `toolchains` and `degraded` are free-form maps
	 * on the Rust side, keyed by language only by convention, so the client's
	 * narrower type is a promise Rust does not make.
	 */
	Expect<Assignable<CreateSessionResponse, Rust.CreateSessionResponse>>,

	/**
	 * The union that grew apart twice this week. The client side is a
	 * superset: `lsp.capabilities` is raised by the LSP client in the browser
	 * and the server never sends it. So every server event must be handled,
	 * and that one is the only extra allowed.
	 */
	Expect<Assignable<Rust.ServerEvent, RuntimeServerEvent>>,
	Expect<
		Identical<
			Exclude<RuntimeServerEvent["type"], Rust.ServerEvent["type"]>,
			"lsp.capabilities"
		>
	>,
];
