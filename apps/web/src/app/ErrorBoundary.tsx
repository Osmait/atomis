import React from "react";

interface ErrorBoundaryProps {
	children: React.ReactNode;
}

interface ErrorBoundaryState {
	error?: Error;
}

/**
 * The app's one class component, because React exposes render-time crashes
 * only through a class's getDerivedStateFromError. Without it, a single
 * throw anywhere in render unmounted the entire tree — a blank page with
 * the reason buried in the console.
 *
 * The fallback reuses the startup screen's look: the files live on the
 * server, so a reload genuinely recovers.
 */
export class ErrorBoundary extends React.Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	public override state: ErrorBoundaryState = {};

	public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	public override render(): React.ReactNode {
		if (!this.state.error) return this.props.children;
		return (
			<main className="startup">
				<img alt="" className="startup-logo" src="/logo.png" />
				<h1>Atomis</h1>
				<h2>The interface crashed</h2>
				<pre>{this.state.error.message || String(this.state.error)}</pre>
				<p>
					Your files live on the server and survive this. Reloading starts
					fresh.
				</p>
				<button onClick={() => window.location.reload()}>Reload</button>
			</main>
		);
	}
}
