import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

/**
 * C-01: Supabase Auth sign-in for live mode. The frontend only signs users in
 * and hands their access token to the BizcaiaOS API through
 * window.__BIZCAIAOS_AUTH__; it never reads data through Supabase directly.
 * Only the public project URL and publishable key reach the browser.
 */

/** The Supabase Auth calls BizcaiaOS uses; tests provide a fake. */
export type SupabaseAuthClient = Pick<
  SupabaseClient['auth'],
  'getSession' | 'signInWithPassword' | 'signOut' | 'onAuthStateChange'
>;

export type SupabaseAuthConfig = { url: string; publishableKey: string };

/** No usable session: the user must sign in again. */
export class AuthRequiredError extends Error {
  readonly status = 401;
  readonly code = 'auth_required';

  constructor(message = 'You are signed out. Sign in to continue.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export function supabaseAuthConfig(env: Record<string, string | undefined>): SupabaseAuthConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim();
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && publishableKey ? { url, publishableKey } : null;
}

function signInErrorMessage(error: { message?: string; status?: number; code?: string }) {
  if (error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message ?? '')) {
    return 'Email or password is incorrect.';
  }
  if (error.code === 'email_not_confirmed') return 'This email address has not been confirmed yet.';
  if (error.status === 429) return 'Too many sign-in attempts. Wait a moment and try again.';
  return 'Sign-in failed. Check your connection and try again.';
}

export function createSupabaseAuth(auth: SupabaseAuthClient) {
  const currentSession = async (): Promise<Session | null> => {
    const { data, error } = await auth.getSession();
    return error ? null : data.session;
  };

  return {
    currentSession,

    /**
     * The current access token. getSession() returns a refreshed session once
     * the stored one has expired, so every API call reads it fresh rather than
     * caching a token.
     */
    async getAccessToken(): Promise<string> {
      const token = (await currentSession())?.access_token;
      if (!token) throw new AuthRequiredError();
      return token;
    },

    /** Email and password only: BizcaiaOS has no public sign-up. */
    async signIn(email: string, password: string): Promise<void> {
      const { error } = await auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(signInErrorMessage(error));
    },

    async signOut(): Promise<void> {
      const { error } = await auth.signOut();
      if (error) throw new Error('Sign-out failed. Try again.');
    },

    /** Calls listener with whether a session exists; returns the unsubscribe. */
    onSessionChange(listener: (signedIn: boolean) => void): () => void {
      const { data } = auth.onAuthStateChange((_event, session) => listener(Boolean(session)));
      return () => data.subscription.unsubscribe();
    },
  };
}

export type SupabaseAuth = ReturnType<typeof createSupabaseAuth>;

/** Points the API clients' token bridge at Supabase Auth. */
export function installAuthBridge(auth: SupabaseAuth, target: Window = window) {
  target.__BIZCAIAOS_AUTH__ = { getAccessToken: () => auth.getAccessToken() };
}

let activeAuth: SupabaseAuth | null = null;

/**
 * Called once before the app renders. Demo mode, or live mode without the two
 * VITE_SUPABASE_* values, leaves sign-in off and the bridge untouched.
 */
export function initializeSupabaseAuth(options: {
  liveMode: boolean;
  config: SupabaseAuthConfig | null;
  createAuthClient?: (config: SupabaseAuthConfig) => SupabaseAuthClient;
  target?: Window;
}): SupabaseAuth | null {
  activeAuth = null;
  if (!options.liveMode || !options.config) return null;
  const createAuthClient =
    options.createAuthClient ??
    ((config: SupabaseAuthConfig) =>
      createClient(config.url, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      }).auth);
  activeAuth = createSupabaseAuth(createAuthClient(options.config));
  installAuthBridge(activeAuth, options.target);
  return activeAuth;
}

/** The Supabase Auth set up by initializeSupabaseAuth, or null when sign-in is off. */
export function getSupabaseAuth(): SupabaseAuth | null {
  return activeAuth;
}
