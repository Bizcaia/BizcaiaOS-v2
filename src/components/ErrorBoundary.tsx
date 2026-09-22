import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; error?: Error };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };
  static getDerivedStateFromError(error: Error): State { return { hasError: true, error }; }
  render() {
    if (!this.state.hasError) return this.props.children;
    return <main style={{ padding: 40, fontFamily: 'Inter, sans-serif' }}><h1>Something went wrong</h1><p>{this.state.error?.message ?? 'Unexpected application error.'}</p><button onClick={() => window.location.reload()}>Reload</button></main>;
  }
}
