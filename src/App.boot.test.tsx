import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./pages/OpsApp', () => ({
  default: ({ onExit }: { onExit: () => void }) => (
    <div>
      <p>Mocked OpsApp</p>
      <button type="button" onClick={onExit}>
        Exit workspace
      </button>
    </div>
  ),
}));

describe('App boot entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.location.hash = '';
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('opens the application at root without the boot screen', () => {
    render(<App />);
    expect(screen.queryByLabelText('BizcaiaOS starting')).not.toBeInTheDocument();
    expect(screen.getByText('Mocked OpsApp')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('opens the application when the URL already targets #app', () => {
    window.location.hash = '#app';
    render(<App />);
    expect(screen.queryByLabelText('BizcaiaOS starting')).not.toBeInTheDocument();
    expect(screen.getByText('Mocked OpsApp')).toBeInTheDocument();
  });
});
