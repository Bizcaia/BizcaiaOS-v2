import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { BOOT_TOTAL_MS } from './pages/BootScreen';

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

  it('shows the boot screen at root then transitions into the application', () => {
    render(<App />);
    expect(screen.getByLabelText('BizcaiaOS starting')).toBeInTheDocument();
    expect(screen.queryByText('Mocked OpsApp')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(BOOT_TOTAL_MS);
    });

    expect(screen.getByText('Mocked OpsApp')).toBeInTheDocument();
    expect(window.location.hash).toBe('#app');
  });

  it('skips the boot screen when the URL already targets #app', () => {
    window.location.hash = '#app';
    render(<App />);
    expect(screen.queryByLabelText('BizcaiaOS starting')).not.toBeInTheDocument();
    expect(screen.getByText('Mocked OpsApp')).toBeInTheDocument();
  });
});
