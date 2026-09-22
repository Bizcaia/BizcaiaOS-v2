import React, { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle, Building2, Check, ChevronDown, Copy, MailPlus, MoreHorizontal,
  RefreshCw, Search, ShieldCheck, UserMinus, UserRoundCheck, Users, X,
} from 'lucide-react';
import {
  organizationApi,
  organizationApiMode,
  roleLabels,
  type Invitation,
  type Member,
  type Organization,
  type OrganizationRole,
} from '../api/organizationApi';

type Section = 'members' | 'invitations' | 'organization';
type Props = {
  organizationId: string;
  onPreviewOnboarding: () => void;
  notify: (message: string) => void;
};

const roles = Object.keys(roleLabels) as OrganizationRole[];
const inviteRoles = roles.filter((role) => role !== 'system_admin') as Exclude<OrganizationRole, 'system_admin'>[];

const initials = (name: string) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

export default function TeamManagement({ organizationId, onPreviewOnboarding, notify }: Props) {
  const [section, setSection] = useState<Section>('members');
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [currentUserId, setCurrentUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [lastToken, setLastToken] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [me, nextOrganization, nextMembers, nextInvitations] = await Promise.all([
        organizationApi.getMe(),
        organizationApi.getOrganization(organizationId),
        organizationApi.listMembers(organizationId),
        organizationApi.listInvitations(organizationId),
      ]);
      setCurrentUserId(me.id);
      setOrganization(nextOrganization);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load organization access');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [organizationId]);

  const visibleMembers = useMemo(() => members.filter((member) =>
    `${member.display_name} ${member.email} ${roleLabels[member.role]}`.toLowerCase().includes(search.toLowerCase()),
  ), [members, search]);

  const activeCount = members.filter((member) => member.is_active).length;
  const adminCount = members.filter((member) => member.is_active && member.role === 'system_admin').length;
  const pendingCount = invitations.filter((invitation) => invitation.status === 'pending').length;

  const updateMember = async (member: Member, input: { role?: OrganizationRole; isActive?: boolean }) => {
    setSaving(member.user_id);
    try {
      const updated = await organizationApi.updateMember(organizationId, member.user_id, input);
      setMembers((current) => current.map((entry) => entry.user_id === member.user_id ? { ...entry, role: updated.role, is_active: updated.is_active } : entry));
      notify('Member access updated.');
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : 'Member update failed');
    } finally {
      setSaving('');
    }
  };

  const removeMember = async () => {
    if (!removeTarget) return;
    setSaving(removeTarget.user_id);
    try {
      await organizationApi.removeMember(organizationId, removeTarget.user_id);
      setMembers((current) => current.filter((entry) => entry.user_id !== removeTarget.user_id));
      setRemoveTarget(null);
      notify('Member removed from the organization.');
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : 'Member removal failed');
    } finally {
      setSaving('');
    }
  };

  if (loading) return <TeamSkeleton />;
  if (error) return <div className="panel team-error"><AlertTriangle size={24} /><h2>Organization access could not be loaded</h2><p>{error}</p><button className="primary-button" onClick={() => void load()}><RefreshCw size={16} /> Retry</button></div>;

  return (
    <div className="team-page">
      <div className="admin-hero">
        <div><div className="eyebrow">ACCESS CONTROL</div><h1>Organization & people</h1><p>Manage the tenant profile, invitations, roles, and active access from one governed workspace.</p></div>
        <div className="admin-hero-actions"><span className={`api-mode ${organizationApiMode}`}><i />{organizationApiMode === 'demo' ? 'Preview data' : 'Live API'}</span><button className="secondary-button" onClick={onPreviewOnboarding}><Building2 size={16} /> Preview onboarding</button><button className="primary-button" onClick={() => setInviteOpen(true)}><MailPlus size={16} /> Invite member</button></div>
      </div>

      <div className="admin-metrics"><AdminMetric icon={<Users size={18} />} label="Active members" value={String(activeCount)} note={`${members.length - activeCount} inactive`} /><AdminMetric icon={<ShieldCheck size={18} />} label="System administrators" value={String(adminCount)} note="Protected minimum: 1" /><AdminMetric icon={<MailPlus size={18} />} label="Pending invitations" value={String(pendingCount)} note="Single-use access links" /></div>

      <div className="admin-tabs"><button className={section === 'members' ? 'active' : ''} onClick={() => setSection('members')}>Members</button><button className={section === 'invitations' ? 'active' : ''} onClick={() => setSection('invitations')}>Invitations <span>{pendingCount}</span></button><button className={section === 'organization' ? 'active' : ''} onClick={() => setSection('organization')}>Organization profile</button></div>

      {section === 'members' && <section className="panel team-panel"><div className="team-toolbar"><div><div className="panel-kicker">MEMBER DIRECTORY</div><h2>People with workspace access</h2></div><div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, email, or role" /></div></div><div className="member-table"><div className="member-row member-head"><span>Member</span><span>Role</span><span>Status</span><span>Joined</span><span /></div>{visibleMembers.map((member) => <div className="member-row" key={member.user_id}><div className="member-identity"><div className="member-avatar">{initials(member.display_name)}</div><span><strong>{member.display_name}{member.user_id === currentUserId && <em>You</em>}</strong><small>{member.email}</small></span></div><div className="select-wrap"><select aria-label={`Role for ${member.display_name}`} value={member.role} disabled={saving === member.user_id || member.user_id === currentUserId} onChange={(event) => void updateMember(member, { role: event.target.value as OrganizationRole })}>{roles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select><ChevronDown size={14} /></div><button className={`status-toggle ${member.is_active ? 'active' : ''}`} disabled={saving === member.user_id || member.user_id === currentUserId} onClick={() => void updateMember(member, { isActive: !member.is_active })}><i />{member.is_active ? 'Active' : 'Inactive'}</button><span className="joined-date">{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(member.created_at))}</span><button className="member-menu" disabled={member.user_id === currentUserId} onClick={() => setRemoveTarget(member)} aria-label={`Remove ${member.display_name}`}><MoreHorizontal size={18} /></button></div>)}</div></section>}

      {section === 'invitations' && <section className="panel team-panel"><div className="team-toolbar"><div><div className="panel-kicker">INVITATION CONTROL</div><h2>Pending and historical invitations</h2></div><button className="primary-button" onClick={() => setInviteOpen(true)}><MailPlus size={16} /> New invitation</button></div>{lastToken && <div className="token-banner"><ShieldCheck size={18} /><div><strong>One-time invitation token</strong><code>{lastToken}</code><small>Copy it now. Only its SHA-256 digest is persisted.</small></div><button className="secondary-button" onClick={() => { void navigator.clipboard.writeText(lastToken); notify('Invitation token copied.'); }}><Copy size={15} /> Copy</button></div>}<div className="invitation-list">{invitations.map((invitation) => <div className="invitation-row" key={invitation.id}><div className="mail-avatar"><MailPlus size={17} /></div><div><strong>{invitation.email}</strong><small>{roleLabels[invitation.role]} · Expires {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(invitation.expires_at))}</small></div><span className={`invitation-status ${invitation.status}`}>{invitation.status}</span>{invitation.status === 'pending' ? <button className="text-button danger-link" onClick={async () => { const updated = await organizationApi.revokeInvitation(organizationId, invitation.id); setInvitations((current) => current.map((entry) => entry.id === updated.id ? updated : entry)); notify('Invitation revoked.'); }}>Revoke</button> : <span />}</div>)}</div></section>}

      {section === 'organization' && organization && <OrganizationProfile organization={organization} onSaved={(next) => { setOrganization(next); notify('Organization profile saved.'); }} />}

      {inviteOpen && <InviteDialog organizationId={organizationId} onClose={() => setInviteOpen(false)} onCreated={(invitation, token) => { setInvitations((current) => [invitation, ...current]); setLastToken(token ?? ''); setInviteOpen(false); setSection('invitations'); notify('Invitation created.'); }} />}
      {removeTarget && <div className="modal-backdrop" onClick={() => setRemoveTarget(null)}><div className="modal compact-modal" onClick={(event) => event.stopPropagation()}><div className="danger-modal-icon"><UserMinus size={20} /></div><h2>Remove {removeTarget.display_name}?</h2><p>This revokes their access to the organization. Their historical activity remains attributed to them.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setRemoveTarget(null)}>Keep member</button><button className="danger-button" disabled={saving === removeTarget.user_id} onClick={() => void removeMember()}>{saving ? 'Removing…' : 'Remove access'}</button></div></div></div>}
    </div>
  );
}

function AdminMetric({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) { return <div className="admin-metric"><div className="admin-metric-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></div>; }

function InviteDialog({ organizationId, onClose, onCreated }: { organizationId: string; onClose: () => void; onCreated: (invitation: Invitation, token?: string) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<OrganizationRole, 'system_admin'>>('negotiator');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); setSubmitting(true); setError(''); try { const invitation = await organizationApi.createInvitation(organizationId, { email, role, expiresInHours: 72 }); onCreated(invitation, invitation.invitationToken); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Invitation failed'); } finally { setSubmitting(false); } };
  return <div className="modal-backdrop" onClick={onClose}><div className="modal invite-modal" onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><div className="panel-kicker">GRANT ACCESS</div><h2>Invite a team member</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><p>Choose the person’s functional role. Database policies will enforce the corresponding organization and property scope.</p><form onSubmit={submit}><label>Work email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" /></label><label>Organization role<select value={role} onChange={(event) => setRole(event.target.value as Exclude<OrganizationRole, 'system_admin'>)}>{inviteRoles.map((entry) => <option key={entry} value={entry}>{roleLabels[entry]}</option>)}</select></label><div className="role-explainer"><UserRoundCheck size={17} /><span><strong>{roleLabels[role]}</strong><small>{role === 'negotiator' ? 'Sees directly assigned properties.' : role === 'supervisor' ? 'Sees assigned properties and managed projects.' : role === 'viewer' ? 'Read-only organization portfolio.' : 'Receives function-specific access enforced by RLS.'}</small></span></div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={submitting}>{submitting ? 'Creating…' : 'Create invitation'} <MailPlus size={16} /></button></div></form></div></div>;
}

function OrganizationProfile({ organization, onSaved }: { organization: Organization; onSaved: (organization: Organization) => void }) {
  const [name, setName] = useState(organization.name);
  const [legalName, setLegalName] = useState(organization.legal_name ?? '');
  const [timezone, setTimezone] = useState(organization.timezone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(''); try { onSaved(await organizationApi.updateOrganization(organization.id, { name, legalName: legalName || null, timezone })); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Save failed'); } finally { setSaving(false); } };
  return <section className="panel profile-panel"><div className="profile-aside"><div className="organization-emblem"><Building2 size={28} /></div><h2>{organization.name}</h2><p>Workspace ID<br /><code>{organization.id}</code></p><div className="security-note"><ShieldCheck size={17} /><span><strong>RLS protected</strong><small>Organization ID is the tenant boundary.</small></span></div></div><form className="profile-form" onSubmit={submit}><div><div className="panel-kicker">ORGANIZATION PROFILE</div><h2>Workspace identity</h2><p>These values appear across member invitations and operating reports.</p></div><div className="form-grid"><label>Display name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Legal name<input value={legalName} onChange={(event) => setLegalName(event.target.value)} /></label><label>Workspace slug<input value={organization.slug} disabled /></label><label>Timezone<select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option>Asia/Manila</option><option>Asia/Singapore</option><option>Australia/Sydney</option><option>America/Los_Angeles</option><option>UTC</option></select></label></div>{error && <div className="form-error">{error}</div>}<div className="profile-actions"><span>Updated {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(organization.updated_at))}</span><button className="primary-button" disabled={saving}>{saving ? 'Saving…' : 'Save changes'} <Check size={16} /></button></div></form></section>;
}

function TeamSkeleton() { return <div className="team-skeleton"><div className="skeleton-title" /><div className="admin-metrics"><i /><i /><i /></div><div className="skeleton-panel" /></div>; }
