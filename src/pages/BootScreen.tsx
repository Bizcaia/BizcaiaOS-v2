import { useEffect, useRef, useState } from 'react';
import './BootScreen.css';

/** Static public asset — served from /brand/ in production (Vite public/). */
export const BOOT_ARTWORK_SRC = '/brand/bizcaiaos-boot.jpg';

const BOOT_STATUSES = [
  'INITIALIZING BIZCAIAOS',
  'LOADING PROPERTY INTELLIGENCE',
  'LOADING ACQUISITION PIPELINE',
  'LOADING WORKSPACE',
  'SYSTEM READY',
] as const;

/** Full sequence length for motion-enabled users (~2s). */
const BOOT_TOTAL_MS = 2000;
/** Reduced-motion: brief hold then complete. */
const BOOT_REDUCED_MS = 320;

type Props = {
  onComplete: () => void;
};

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Full-viewport BizcaiaOS boot sequence shown at the application entry.
 * Uses the supplied brand artwork as the primary visual; does not recreate the logo in CSS.
 * Does not touch auth, API, or tenancy — presentation only.
 */
export default function BootScreen({ onComplete }: Props) {
  const [statusIndex, setStatusIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const reduced = prefersReducedMotion();
    const timers: number[] = [];
    let cancelled = false;

    const finish = () => {
      if (!cancelled) onCompleteRef.current();
    };

    if (reduced) {
      setStatusIndex(BOOT_STATUSES.length - 1);
      setProgress(100);
      timers.push(window.setTimeout(finish, BOOT_REDUCED_MS));
      return () => {
        cancelled = true;
        timers.forEach((id) => window.clearTimeout(id));
      };
    }

    const stepMs = BOOT_TOTAL_MS / BOOT_STATUSES.length;
    BOOT_STATUSES.forEach((_, index) => {
      timers.push(
        window.setTimeout(() => {
          if (cancelled) return;
          setStatusIndex(index);
          setProgress(Math.round(((index + 1) / BOOT_STATUSES.length) * 100));
        }, Math.round(index * stepMs)),
      );
    });
    timers.push(window.setTimeout(finish, BOOT_TOTAL_MS));

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  const status = BOOT_STATUSES[statusIndex] ?? BOOT_STATUSES[0];

  return (
    <div className="boot-screen" role="main" aria-label="BizcaiaOS starting">
      <div className="boot-frame">
        <img
          className="boot-artwork"
          src={BOOT_ARTWORK_SRC}
          alt="BizcaiaOS — Land Acquisition Operating System"
          width={1024}
          height={1024}
          decoding="async"
        />

        <div className="boot-status-block">
          <p className="boot-status" aria-live="polite" aria-atomic="true">
            {status}
          </p>
          <div
            className="boot-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="System initialization progress"
          >
            <span className="boot-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export { BOOT_STATUSES, BOOT_TOTAL_MS, BOOT_REDUCED_MS };
