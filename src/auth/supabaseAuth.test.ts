import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const createClient = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', () => ({ createClient }));

import {
  AuthRequiredError,
  createSupabaseAuth,
  getSupabaseAuth,
  initializeSupabaseAuth,
  installAuthBridge,
  supabaseAuthConfig,
  type SupabaseAuthClient,
} from './supabaseAuth';

const config = { url: 'https://project-ref.supabase.test', publishableKey: 'test-publishable-key' };

type Listener = (event: string, session: Session | null) => void;

/** A deterministic stand-in for supabase.auth: no network, no real project. */
function fakeAuthClient(initialToken: string | null = null) {
  let session: Session | null = initialToken ? ({ access_token: initialToken } as Session) : null;
  const listeners = new Set<Listener>();
  const unsubscribe = vi.fn();
  const client = {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => {
      session = null;
      listeners.forEach((listener) => listener('SIGNED_OUT', null));
      return { error: null };
    }),
    onAuthStateChange: vi.fn((listener: Listener) => {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe } } };
    }),
  };
  return {
    client: client as unknown as SupabaseAuthClient,
    raw: client,
    unsubscribe,
    setToken(token: string | null) {
      session = token ? ({ access_token: token } as Session) : null;
      listeners.forEach((listener) => listener(token ? 'TOKEN_REFRESHED' : 'SIGNED_OUT', session));
    },
  };
}

describe('supabaseAuthConfig', () => {
  it('needs both public values and trims them', () => {
    expect(supabaseAuthConfig({})).toBeNull();
    expect(supabaseAuthConfig({ VITE_SUPABASE_URL: config.url })).toBeNull();
    expect(supabaseAuthConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey })).toBeNull();
    expect(
      supabaseAuthConfig({ VITE_SUPABASE_URL: ` ${config.url} `, VITE_SUPABASE_PUBLISHABLE_KEY: ` ${config.publishableKey} ` }),
    ).toEqual(config);
  });
});

describe('initializeSupabaseAuth', () => {
  beforeEach(() => {
    createClient.mockReset();
    delete window.__BIZCAIAOS_AUTH__;
  });
  afterEach(() => {
    initializeSupabaseAuth({ liveMode: false, config: null });
    delete window.__BIZCAIAOS_AUTH__;
  });

  it('creates the Supabase client from the public URL and publishable key only', () => {
    const fake = fakeAuthClient();
    createClient.mockReturnValue({ auth: fake.client });

    const auth = initializeSupabaseAuth({ liveMode: true, config });

    expect(auth).not.toBeNull();
    expect(getSupabaseAuth()).toBe(auth);
    expect(createClient).toHaveBeenCalledWith(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    expect(window.__BIZCAIAOS_AUTH__).toBeDefined();
  });

  it('stays off in demo mode and leaves the bridge alone', () => {
    expect(initializeSupabaseAuth({ liveMode: false, config })).toBeNull();
    expect(getSupabaseAuth()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(window.__BIZCAIAOS_AUTH__).toBeUndefined();
  });

  it('stays off in live mode when the Supabase values are not configured', () => {
    expect(initializeSupabaseAuth({ liveMode: true, config: null })).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(window.__BIZCAIAOS_AUTH__).toBeUndefined();
  });
});

describe('createSupabaseAuth', () => {
  it('signed out: the token bridge refuses with a 401 AuthRequiredError', async () => {
    const auth = createSupabaseAuth(fakeAuthClient(null).client);
    await expect(auth.currentSession()).resolves.toBeNull();
    const failure = auth.getAccessToken();
    await expect(failure).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(failure).rejects.toMatchObject({ status: 401, code: 'auth_required' });
  });

  it('treats a session lookup error as signed out', async () => {
    const fake = fakeAuthClient('token-a');
    fake.raw.getSession.mockResolvedValueOnce({ data: { session: null }, error: new Error('storage unavailable') } as never);
    await expect(createSupabaseAuth(fake.client).getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('signed in: the bridge returns the current access token', async () => {
    const auth = createSupabaseAuth(fakeAuthClient('token-a').client);
    const target = {} as Window;
    installAuthBridge(auth, target);
    await expect(target.__BIZCAIAOS_AUTH__!.getAccessToken()).resolves.toBe('token-a');
  });

  it('reads the session on every call, so a refreshed token is used immediately', async () => {
    const fake = fakeAuthClient('token-a');
    const auth = createSupabaseAuth(fake.client);
    await expect(auth.getAccessToken()).resolves.toBe('token-a');
    fake.setToken('token-b');
    await expect(auth.getAccessToken()).resolves.toBe('token-b');
    expect(fake.raw.getSession).toHaveBeenCalledTimes(2);
  });

  it('signs in with email and password', async () => {
    const fake = fakeAuthClient();
    await createSupabaseAuth(fake.client).signIn('  user@example.com ', 'correct horse');
    expect(fake.raw.signInWithPassword).toHaveBeenCalledWith({ email: 'user@example.com', password: 'correct horse' });
  });

  it('turns sign-in failures into safe messages', async () => {
    const fake = fakeAuthClient();
    const auth = createSupabaseAuth(fake.client);
    fake.raw.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' },
    } as never);
    await expect(auth.signIn('user@example.com', 'wrong')).rejects.toThrow('Email or password is incorrect.');
    fake.raw.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'rate limited', status: 429 } } as never);
    await expect(auth.signIn('user@example.com', 'wrong')).rejects.toThrow('Too many sign-in attempts');
    fake.raw.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'upstream detail', status: 500 } } as never);
    await expect(auth.signIn('user@example.com', 'wrong')).rejects.toThrow('Sign-in failed. Check your connection and try again.');
  });

  it('signs out and then refuses tokens', async () => {
    const fake = fakeAuthClient('token-a');
    const auth = createSupabaseAuth(fake.client);
    await auth.signOut();
    expect(fake.raw.signOut).toHaveBeenCalledTimes(1);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('reports session changes and unsubscribes', () => {
    const fake = fakeAuthClient();
    const auth = createSupabaseAuth(fake.client);
    const seen: boolean[] = [];
    const stop = auth.onSessionChange((signedIn) => seen.push(signedIn));
    fake.setToken('token-a');
    fake.setToken(null);
    expect(seen).toEqual([true, false]);
    stop();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('API calls through the bridge', () => {
  afterEach(() => {
    delete window.__BIZCAIAOS_AUTH__;
    vi.unstubAllGlobals();
  });

  it('send the Supabase access token as the Bearer token', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'user-1', email: 'user@example.com', displayName: 'User', organizations: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    installAuthBridge(createSupabaseAuth(fakeAuthClient('supabase-access-token').client));
    const { organizationApi } = await import('../api/organizationApi');

    await organizationApi.getMe();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/me',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer supabase-access-token' }) }),
    );
  });
});
