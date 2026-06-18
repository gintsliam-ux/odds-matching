import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Catches render errors in the tree below so a single buggy component
 *  doesn't blank the entire page. Renders a small, on-brand error card and
 *  exposes the message for quick triage. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Log to the console so the dev/inspector still sees the full stack.
    // eslint-disable-next-line no-console
    console.error('Render error caught by ErrorBoundary:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto my-12 max-w-xl rounded-md border border-[var(--live)]/40 bg-[var(--panel)] p-5">
        <div className="mb-2 text-[11px] font-bold tracking-widest text-[var(--live)]">
          SOMETHING WENT WRONG
        </div>
        <div className="text-[12px] leading-relaxed text-gray-300">
          {this.state.error.message || 'An unknown error occurred.'}
        </div>
        <button
          onClick={() => {
            this.setState({ error: null })
          }}
          className="mt-4 rounded border border-[var(--line)] px-3 py-1.5 text-[11px] font-bold tracking-widest text-gray-300 hover:bg-white/5"
        >
          TRY AGAIN
        </button>
      </div>
    )
  }
}
