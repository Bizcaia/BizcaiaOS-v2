import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BootScreen, {
  BOOT_ARTWORK_SRC,
  BOOT_REDUCED_MS,
  BOOT_STATUSES,
  BOOT_TOTAL_MS,
} from './BootScreen';

describe('BootScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.restoreAllMocks();
  });

  it('renders the brand artwork and the first boot status', () => {
    render(<BootScreen onComplete={() => undefined} />);
    expect(screen.getByLabelText('BizcaiaOS starting')).toBeInTheDocument();
    const artwork = screen.getByRole('img', {
      name: 'BizcaiaOS — Land Acquisition Operating System',
    });
    expect(artwork).toHaveAttribute('src', BOOT_ARTWORK_SRC);
    expect(screen.getByText(BOOT_STATUSES[0])).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('advances statuses then calls onComplete once without leaking timers', () => {
    const onComplete = vi.fn();
    const { unmount } = render(<BootScreen onComplete={onComplete} />);

    act(() => {
      vi.advanceTimersByTime(BOOT_TOTAL_MS - 1);
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText(BOOT_STATUSES[BOOT_STATUSES.length - 1])).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);

    unmount();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('uses a short transition when prefers-reduced-motion is set', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const onComplete = vi.fn();
    render(<BootScreen onComplete={onComplete} />);
    expect(screen.getByText('SYSTEM READY')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(BOOT_REDUCED_MS - 1);
    });
    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
