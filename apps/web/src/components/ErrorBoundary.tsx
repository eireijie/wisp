import { Component, type ReactNode } from "react";

/** Shows a recoverable error screen instead of a blank page when rendering crashes. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Wisp crashed:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="min-h-full grid place-items-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <img src="/icon.svg" alt="" className="size-10 mx-auto" />
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted">Wisp hit an error on this screen. Your messages, agents and memory are safe on the hub.</p>
          <pre className="text-left text-xs bg-code rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">{error.message}</pre>
          <div className="flex justify-center gap-2">
            <button className="h-9 px-3 rounded-lg bg-accent text-accent-ink text-sm font-medium" onClick={() => location.reload()}>
              Reload
            </button>
            <button
              className="h-9 px-3 rounded-lg border border-line text-sm"
              onClick={() => {
                location.hash = "";
                location.reload();
              }}
            >
              Go to Chats
            </button>
          </div>
        </div>
      </div>
    );
  }
}
