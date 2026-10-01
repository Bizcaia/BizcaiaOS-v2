import React, { useEffect, useState, type ReactNode } from 'react';
import SignIn from '../pages/SignIn';
import type { SupabaseAuth } from './supabaseAuth';

type SessionState = 'checking' | 'signed_in' | 'signed_out';

type Props = {
  /** null when sign-in is off (demo mode, or Supabase not configured). */
  auth: SupabaseAuth | null;
  onCancel?: () => void;
  children: (controls: { signOut?: () => Promise<void> }) => ReactNode;
};

/**
 * Shows the sign-in screen until Supabase Auth has a session, then the
 * workspace. Signing out unmounts the workspace, so its organization state is
 * reset for the next user. Without auth it renders the workspace unchanged.
 */
export default function AuthGate({ auth, onCancel, children }: Props) {
  const [state, setState] = useState<SessionState>(auth ? 'checking' : 'signed_in');

  useEffect(() => {
    if (!auth) return;
    let active = true;
    void auth.currentSession().then((session) => {
      if (active) setState(session ? 'signed_in' : 'signed_out');
    });
    const unsubscribe = auth.onSessionChange((signedIn) => {
      if (active) setState(signedIn ? 'signed_in' : 'signed_out');
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [auth]);

  if (!auth) return <>{children({})}</>;
  if (state === 'checking') {
    return (
      <div className="ops-shell">
        <main className="ops-main">
          <p>Checking your session…</p>
        </main>
      </div>
    );
  }
  if (state === 'signed_out') {
    return <SignIn onSignIn={(email, password) => auth.signIn(email, password)} onCancel={onCancel} />;
  }
  return <>{children({ signOut: () => auth.signOut() })}</>;
}
