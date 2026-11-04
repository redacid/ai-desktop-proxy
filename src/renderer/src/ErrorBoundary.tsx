import { Component } from 'react'

/** A rendering error shows what broke and how to recover, instead of leaving the window blank. */
export class ErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('Renderer crashed:', error)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <main>
        <section className="card" role="alert">
          <h2>The window hit an error</h2>
          <p className="detail">The proxy and headroom services keep running. Reload the window to try again.</p>
          <pre className="log">{error.stack ?? error.message}</pre>
          <div className="actions">
            <button className="primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </section>
      </main>
    )
  }
}
