import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import AuthGate from './AuthGate';
import { createSupabaseAuth, type SupabaseAuthClient } from './supabaseAuth';

type Listener = (event: string, session: Session | null) => void;

/** Fake supabase.auth whose password check accepts one known password. */
function fakeAuth(signedIn: boolean) {
  let session: Session | null = signedIn ? ({ access_token: 'token-a' } as Session) : null;
  const listeners = new Set<Listener>();
  const emit = (event: string) => listeners.forEach((listener) => listener(event, session));
  const client = {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    signInWithPassword: vi.fn(async ({ password }: { email: string; password: string }) => {
      if (password !== 'right-password') {
        return { data: {}, error: { message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' } };
      }
      session = { access_token: 'token-a' } as Session;
      emit('SIGNED_IN');
      return { data: {}, error: null };
    }),
    signOut: vi.fn(async () => {
      session = null;
      emit('SIGNED_OUT');
      return { error: null };
    }),
    onAuthStateChange: vi.fn((listener: Listener) => {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    }),
  };
  return { auth: createSupabaseAuth(client as unknown as SupabaseAuthClient), client };
}

function Workspace({ signOut }: { signOut?: () => Promise<void> }) {
  return (
    <div>
      <p>Workspace loaded</p>
      {signOut && <button onClick={() => void signOut()}>Sign out</button>}
    </div>
  );
}

describe('AuthGate', () => {
  it('renders the workspace unchanged when sign-in is off (demo mode)', () => {
    render(<AuthGate auth={null}>{(controls) => <Workspace {...controls} />}</AuthGate>);
    expect(screen.getByText('Workspace loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('shows email/password sign-in when signed out, with no public sign-up', async () => {
    const { auth } = fakeAuth(false);
    render(<AuthGate auth={auth}>{(controls) => <Workspace {...controls} />}</AuthGate>);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByText(/sign up|create account|register/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace loaded')).not.toBeInTheDocument();
  });

  it('opens the workspace after a successful sign-in', async () => {
    const { auth, client } = fakeAuth(false);
    render(<AuthGate auth={auth}>{(controls) => <Workspace {...controls} />}</AuthGate>);

    await userEvent.type(await screen.findByLabelText('Email'), 'user@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'right-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Workspace loaded')).toBeInTheDocument();
    expect(client.signInWithPassword).toHaveBeenCalledWith({ email: 'user@example.com', password: 'right-password' });
  });

  it('keeps the user on sign-in with a clear error when the password is wrong', async () => {
    const { auth } = fakeAuth(false);
    render(<AuthGate auth={auth}>{(controls) => <Workspace {...controls} />}</AuthGate>);

    await userEvent.type(await screen.findByLabelText('Email'), 'user@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.queryByText('Workspace loaded')).not.toBeInTheDocument();
  });

  it('returns to sign-in after signing out', async () => {
    const { auth, client } = fakeAuth(true);
    render(<AuthGate auth={auth}>{(controls) => <Workspace {...controls} />}</AuthGate>);

    await userEvent.click(await screen.findByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument());
    expect(client.signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Workspace loaded')).not.toBeInTheDocument();
  });
});
