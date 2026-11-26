import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Last-resort guard: shows a recovery screen instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Unhandled UI error", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal">
        <h1>Something went wrong</h1>
        <p>Marmara PDF hit an unexpected error. Unsaved changes are kept in crash recovery and will be offered when you reopen.</p>
        <pre>{this.state.error.message}</pre>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
