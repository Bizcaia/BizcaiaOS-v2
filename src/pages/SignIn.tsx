import React, { useState, type FormEvent } from 'react';
import { ArrowRight, Check, LockKeyhole, X } from 'lucide-react';

type Props = {
  onSignIn: (email: string, password: string) => Promise<void>;
  onCancel?: () => void;
};

/**
 * Email and password sign-in for live mode. There is deliberately no sign-up:
 * accounts are created by an administrator, not by visitors.
 */
export default function SignIn({ onSignIn, onCancel }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await onSignIn(email, password);
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Sign-in failed. Try again.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="onboarding-screen">
      <div className="onboarding-brand"><div className="brand-mark"><i /><i /><i /></div><span>bizcaia<span>os</span></span></div>
      {onCancel && <button className="onboarding-close" onClick={onCancel} aria-label="Back to website"><X size={20} /></button>}
      <div className="onboarding-layout">
        <section className="onboarding-story">
          <div className="onboarding-eyebrow">SECURE WORKSPACE</div>
          <h1>Sign in to <em>BizcaiaOS.</em></h1>
          <p>Use the email and password your organization administrator set up for you.</p>
        </section>
        <section className="onboarding-card">
          <div className="onboarding-icon"><LockKeyhole size={22} /></div>
          <h2>Sign in</h2>
          <p>You are signed out. Sign in to open your organization&apos;s workspace.</p>
          <form onSubmit={submit}>
            <label htmlFor="sign-in-email">Email</label>
            <input id="sign-in-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            <label htmlFor="sign-in-password">Password</label>
            <input id="sign-in-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary-button onboarding-submit" disabled={submitting || !email.trim() || !password}>
              {submitting ? 'Signing in…' : 'Sign in'} <ArrowRight size={17} />
            </button>
          </form>
          <div className="onboarding-foot"><Check size={14} /> Accounts are created by your organization administrator.</div>
        </section>
      </div>
    </div>
  );
}
