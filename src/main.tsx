import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { organizationApiMode } from './api/organizationApi';
import { initializeSupabaseAuth, supabaseAuthConfig } from './auth/supabaseAuth';
import './styles.css';

// C-01: live mode signs in through Supabase Auth and feeds its access token to
// the API clients. Demo mode needs no sign-in.
initializeSupabaseAuth({
  liveMode: organizationApiMode === 'live',
  config: supabaseAuthConfig(import.meta.env),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
