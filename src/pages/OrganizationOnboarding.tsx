import React, { useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Building2, Check, Database, ShieldCheck, Users, X } from 'lucide-react';
import { organizationApi, organizationApiMode } from '../api/organizationApi';

type Props = {
  onComplete: (organizationId: string) => void;
  onCancel?: () => void;
};

const slugify = (value: string) => value
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

export default function OrganizationOnboarding({ onComplete, onCancel }: Props) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [timezone, setTimezone] = useState('Asia/Manila');
  const [touchedSlug, setTouchedSlug] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const effectiveSlug = useMemo(() => touchedSlug ? slug : slugify(name), [name, slug, touchedSlug]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await organizationApi.onboardOrganization({ name, slug: effectiveSlug, timezone });
      onComplete(result.organizationId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Organization onboarding failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="onboarding-screen">
      <div className="onboarding-brand"><div className="brand-mark"><i /><i /><i /></div><span>bizcaia<span>os</span></span></div>
      {onCancel && <button className="onboarding-close" onClick={onCancel} aria-label="Close onboarding"><X size={20} /></button>}
      <div className="onboarding-layout">
        <section className="onboarding-story">
          <div className="onboarding-eyebrow">ORGANIZATION SETUP</div>
          <h1>Build your acquisition <em>operating system.</em></h1>
          <p>Create the secure workspace that will hold your projects, properties, people, and operating history.</p>
          <div className="onboarding-proof">
            <div><ShieldCheck size={19} /><span><strong>Tenant isolated</strong><small>Your organization becomes the database security boundary.</small></span></div>
            <div><Users size={19} /><span><strong>Role controlled</strong><small>You start as the first System Administrator.</small></span></div>
            <div><Database size={19} /><span><strong>Property centered</strong><small>Every record connects to one operational source of truth.</small></span></div>
          </div>
        </section>
        <section className="onboarding-card">
          <div className="step-chip">Step 1 of 2</div>
          <div className="onboarding-icon"><Building2 size={22} /></div>
          <h2>Name your organization</h2>
          <p>This creates your tenant and first administrator membership in one transaction.</p>
          <form onSubmit={submit}>
            <label htmlFor="organization-name">Organization name</label><input id="organization-name" required minLength={2} value={name} onChange={(event) => setName(event.target.value)} placeholder="North Corridor Land Holdings" />
            <label htmlFor="organization-slug">Workspace URL</label><div className="slug-input"><span>app.bizcaiaos.com/</span><input id="organization-slug" required value={effectiveSlug} onChange={(event) => { setTouchedSlug(true); setSlug(slugify(event.target.value)); }} placeholder="north-corridor" /></div>
            <label htmlFor="organization-timezone">Primary timezone</label><select id="organization-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)}><option>Asia/Manila</option><option>Asia/Singapore</option><option>Australia/Sydney</option><option>America/Los_Angeles</option><option>UTC</option></select>
            {error && <div className="form-error">{error}</div>}
            <button className="primary-button onboarding-submit" disabled={submitting || name.trim().length < 2 || effectiveSlug.length < 2}>{submitting ? 'Creating workspace…' : 'Create secure workspace'} <ArrowRight size={17} /></button>
          </form>
          <div className="onboarding-foot"><Check size={14} /> {organizationApiMode === 'demo' ? 'Preview mode — no database changes' : 'Connected to the onboarding API'}</div>
        </section>
      </div>
    </div>
  );
}
