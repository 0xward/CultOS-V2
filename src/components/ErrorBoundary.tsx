import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error.message };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[CultOS ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{
          minHeight: '100vh', background: '#080512',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 16, fontFamily: 'monospace', padding: 32,
        }}>
          <div style={{ fontSize: 48 }}>◈</div>
          <div style={{ fontSize: 14, color: '#EF4444', fontWeight: 700, letterSpacing: 2 }}>
            CRITICAL_EXCEPTION
          </div>
          <div style={{
            fontSize: 11, color: 'rgba(255,255,255,0.4)', maxWidth: 480,
            textAlign: 'center', lineHeight: 1.8, padding: '16px 24px',
            background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 12,
          }}>
            {this.state.errorMessage || 'AN UNHANDLED FAULT HAS OCCURRED IN THE ORACLE CORE.'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)',
              borderRadius: 8, padding: '10px 24px', color: '#A855F7',
              cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700,
              fontSize: 11, letterSpacing: 2,
            }}
          >
            REINITIALIZE SYSTEM
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
