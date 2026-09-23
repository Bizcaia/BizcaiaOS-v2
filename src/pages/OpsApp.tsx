import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FolderKanban, LayoutDashboard, Map, Plus, Search, ShieldCheck } from 'lucide-react';
import { organizationApi, organizationApiMode, type Member, type OrganizationRole } from '../api/organizationApi';
import {
  DEMO_ORGANIZATION_ID,
  operationsApi,
  type AcquisitionStage,
  type AgreementSignature,
  type DocumentCategory,
  type DocumentStatus,
  type Negotiation,
  type NegotiationEvent,
  type NegotiationEventType,
  type NegotiationStatus,
  type Owner,
  type OwnerType,
  type Project,
  type PaymentStatus,
  type PaymentType,
  type Property,
  type PropertyDocument,
  type PropertyOwner,
  type PropertyPayment,
  type PropertyTask,
  type TaskPriority,
  type TaskStatus,
  type TimelineEntry,
} from '../api/operationsApi';
import TeamManagement from './TeamManagement';
import OrganizationOnboarding from './OrganizationOnboarding';

const stageLabels: Record<AcquisitionStage, string> = {
  identified: 'Identified',
  initial_contact: 'Initial contact',
  owner_validation: 'Owner validation',
  property_validation: 'Property validation',
  documentation: 'Documentation',
  negotiation: 'Negotiation',
  commercial_review: 'Commercial review',
  legal_review: 'Legal review',
  agreement_preparation: 'Agreement preparation',
  signing: 'Signing',
  payment_closing: 'Payment / closing',
  acquisition_complete: 'Complete',
  on_hold: 'On hold',
  withdrawn: 'Withdrawn',
};

const ownerTypeLabels: Record<OwnerType, string> = {
  individual: 'Individual',
  corporate: 'Corporate',
  estate: 'Estate',
  government: 'Government',
  other: 'Other',
};

const negotiationStatusLabels: Record<NegotiationStatus, string> = {
  open: 'Open',
  paused: 'Paused',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  closed: 'Closed',
};

const eventTypeLabels: Record<NegotiationEventType, string> = {
  offer: 'Offer',
  counteroffer: 'Counteroffer',
  meeting: 'Meeting',
  call: 'Call',
  message: 'Message',
  note: 'Note',
  other: 'Other',
};

const negotiationManagerRoles: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];

const documentCategoryLabels: Record<DocumentCategory, string> = {
  ownership_evidence: 'Ownership evidence',
  title_deed: 'Title deed',
  tax_declaration: 'Tax declaration',
  legal_opinion: 'Legal opinion',
  survey_plan: 'Survey plan',
  agreement_draft: 'Agreement draft',
  agreement_executed: 'Agreement executed',
  payment_proof: 'Payment proof',
  other: 'Other',
};

const documentStatusLabels: Record<DocumentStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  verified: 'Verified',
  rejected: 'Rejected',
  superseded: 'Superseded',
};

const documentWriteRoles: OrganizationRole[] = ['system_admin', 'land_acquisition_manager', 'legal_documentation'];

const taskStatusLabels: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const taskPriorityLabels: Record<TaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const taskManagerRoles: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];
const taskSelfAssignCreateRoles: OrganizationRole[] = ['legal_documentation', 'finance'];

const paymentTypeLabels: Record<PaymentType, string> = {
  deposit: 'Deposit',
  installment: 'Installment',
  final_payment: 'Final payment',
};

const paymentStatusLabels: Record<PaymentStatus, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const paymentWriteRoles: OrganizationRole[] = ['system_admin', 'land_acquisition_manager', 'finance'];

const agreementSignatureWriteRoles: OrganizationRole[] = ['system_admin', 'land_acquisition_manager', 'legal_documentation'];

type OpsTab = 'dashboard' | 'projects' | 'properties' | 'team';

const propertyCreateRoles: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];
const ownerManagerRoles: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];
const negotiatorAssignmentRoles: OrganizationRole[] = ['negotiator'];
const managerAssignmentRoles: OrganizationRole[] = ['system_admin', 'land_acquisition_manager', 'supervisor'];

function assignmentChoices(members: Member[], roles: OrganizationRole[]) {
  return members.filter((member) => member.is_active && roles.includes(member.role));
}

function allowedPropertyPatchKeys(role: OrganizationRole): Set<string> {
  switch (role) {
    case 'system_admin':
    case 'land_acquisition_manager':
      return new Set([
        'acquisitionStage',
        'acquisitionStatus',
        'titleNumber',
        'taxDeclaration',
        'lotNumber',
        'areaHectares',
        'municipality',
        'province',
        'barangay',
        'assignedNegotiatorId',
        'assignedManagerId',
        'legalStatus',
        'documentationStatus',
        'paymentStatus',
        'readinessPercent',
        'risk',
        'metadata',
      ]);
    case 'supervisor':
      return new Set(['readinessPercent', 'risk', 'metadata']);
    case 'legal_documentation':
      return new Set(['legalStatus', 'documentationStatus']);
    case 'finance':
      return new Set(['paymentStatus']);
    default:
      return new Set();
  }
}

export default function OpsApp({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<OpsTab>('dashboard');
  const [properties, setProperties] = useState<Property[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [selected, setSelected] = useState<Property | null>(null);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<AcquisitionStage | ''>('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreateProperty, setShowCreateProperty] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [role, setRole] = useState<OrganizationRole>('viewer');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [orgContextError, setOrgContextError] = useState('');
  const isDemo = organizationApiMode === 'demo';
  const canManageProperties = propertyCreateRoles.includes(role);
  const canManageOwners = ownerManagerRoles.includes(role);

  useEffect(() => {
    if (isDemo) {
      setOrganizationId(DEMO_ORGANIZATION_ID);
      setShowOnboarding(false);
      setOrgContextError('');
    }
    let cancelled = false;
    void organizationApi
      .getMe()
      .then((me) => {
        if (cancelled) return;
        const activeOrg = me.organizations[0];
        setCurrentUserId(me.id);
        if (isDemo) {
          setRole(activeOrg?.role ?? 'system_admin');
          return;
        }
        if (!activeOrg) {
          setOrganizationId(null);
          setShowOnboarding(true);
          setOrgContextError('');
          return;
        }
        setOrganizationId(activeOrg.id);
        setRole(activeOrg.role ?? 'viewer');
        setShowOnboarding(false);
        setOrgContextError('');
      })
      .catch((error) => {
        if (!cancelled && !isDemo) {
          setOrganizationId(null);
          setOrgContextError(error instanceof Error ? error.message : 'Unable to load organization context');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isDemo]);

  const load = async () => {
    if (!organizationId) return;
    setLoading(true);
    const [listedProperties, listedProjects, listedMembers, listedOwners] = await Promise.all([
      operationsApi.listProperties(organizationId, {
        search,
        stage: stage || undefined,
        projectId: selectedProjectId || undefined,
      }),
      operationsApi.listProjects(organizationId),
      organizationApi.listMembers(organizationId),
      operationsApi.listOwners(organizationId),
    ]);
    setProperties(listedProperties);
    setProjects(listedProjects);
    setMembers(listedMembers.filter((member) => member.is_active));
    setOwners(listedOwners);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [organizationId, search, stage, selectedProjectId]);

  const dashboard = useMemo(
    () => ({
      total: properties.length,
      ready: properties.filter((property) => property.readiness_percent >= 80).length,
      negotiation: properties.filter((property) => property.acquisition_stage === 'negotiation').length,
      blocked: properties.filter((property) => property.legal_status === 'blocked' || property.risk === 'high').length,
    }),
    [properties],
  );

  if (showOnboarding) {
    return (
      <OrganizationOnboarding
        onComplete={(nextOrganizationId) => {
          setOrganizationId(nextOrganizationId);
          setShowOnboarding(false);
        }}
        onCancel={isDemo || organizationId ? () => setShowOnboarding(false) : onExit}
      />
    );
  }
  if (orgContextError) {
    return (
      <div className="ops-shell">
        <main className="ops-main">
          <p className="form-error">{orgContextError}</p>
        </main>
      </div>
    );
  }
  if (!organizationId) {
    return (
      <div className="ops-shell">
        <main className="ops-main">
          <p>Loading organization…</p>
        </main>
      </div>
    );
  }

  const titles: Record<OpsTab, string> = {
    dashboard: 'Portfolio overview',
    projects: 'Projects',
    properties: 'Properties',
    team: 'Organization & people',
  };

  return (
    <div className="ops-shell">
      <aside className="ops-sidebar">
        <div className="ops-brand">
          <span className="logo-mark">
            <i />
            <i />
            <i />
          </span>
          <strong>
            bizcaia<span>os</span>
          </strong>
        </div>
        <nav>
          <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => { setTab('dashboard'); setSelected(null); }}>
            <LayoutDashboard size={17} /> Dashboard
          </button>
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => { setTab('projects'); setSelected(null); }}>
            <FolderKanban size={17} /> Projects
          </button>
          <button className={tab === 'properties' ? 'active' : ''} onClick={() => { setTab('properties'); setSelected(null); }}>
            <Map size={17} /> Properties
          </button>
          <button className={tab === 'team' ? 'active' : ''} onClick={() => { setTab('team'); setSelected(null); }}>
            <ShieldCheck size={17} /> Team & access
          </button>
        </nav>
        <button className="ops-exit" onClick={onExit}>
          <ArrowLeft size={16} /> Website
        </button>
      </aside>
      <main className="ops-main">
        <header className="ops-header">
          <div>
            <span className="mini-label">NORTH CORRIDOR PROGRAM</span>
            <h1>{titles[tab]}</h1>
          </div>
          <div className="ops-header-actions">
            <span className={isDemo ? 'api-mode demo' : 'api-mode'}>
              <i /> {isDemo ? 'Preview workspace' : 'Live API'}
            </span>
            {tab === 'projects' && canManageProperties && (
              <button className="primary-button" onClick={() => setShowCreateProject(true)}>
                <Plus size={16} /> Add project
              </button>
            )}
            {tab === 'properties' && canManageProperties && (
              <button className="primary-button" onClick={() => setShowCreateProperty(true)}>
                <Plus size={16} /> Add property
              </button>
            )}
          </div>
        </header>
        {tab === 'team' ? (
          <TeamManagement organizationId={organizationId} onPreviewOnboarding={() => setShowOnboarding(true)} notify={() => {}} />
        ) : tab === 'dashboard' ? (
          <>
            <div className="ops-metrics">
              <Metric label="Properties" value={dashboard.total} />
              <Metric label="Acquisition-ready" value={dashboard.ready} />
              <Metric label="Active negotiations" value={dashboard.negotiation} />
              <Metric label="Blocked / high risk" value={dashboard.blocked} />
            </div>
            <section className="ops-panel">
              <div className="panel-head">
                <div>
                  <span className="panel-kicker">PIPELINE</span>
                  <h2>Properties by acquisition stage</h2>
                </div>
              </div>
              <div className="stage-grid">
                {Object.entries(stageLabels).map(([key, label]) => {
                  const count = properties.filter((property) => property.acquisition_stage === key).length;
                  return (
                    <button
                      key={key}
                      className="stage-card"
                      onClick={() => {
                        setStage(key as AcquisitionStage);
                        setTab('properties');
                      }}
                    >
                      <strong>{count}</strong>
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          </>
        ) : tab === 'projects' ? (
          <section className="ops-panel">
            {loading ? (
              <p>Loading projects…</p>
            ) : (
              <div className="property-list">
                {projects.map((project) => (
                  <button
                    className="property-row"
                    key={project.id}
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      setTab('properties');
                    }}
                  >
                    <div>
                      <strong>{project.code} — {project.name}</strong>
                      <small>{project.status} · {project.description ?? 'No description'}</small>
                    </div>
                    <span>Open properties</span>
                    <b />
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="ops-panel">
            <div className="property-toolbar">
              <div className="search-box">
                <Search size={16} />
                <input placeholder="Search property, lot, municipality" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
              <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} aria-label="Filter by project">
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.code} — {project.name}</option>
                ))}
              </select>
              <select value={stage} onChange={(event) => setStage(event.target.value as AcquisitionStage | '')}>
                <option value="">All stages</option>
                {Object.entries(stageLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            {loading ? (
              <p>Loading properties…</p>
            ) : (
              <div className="property-list">
                {properties.map((property) => (
                  <button
                    className="property-row"
                    key={property.id}
                    onClick={async () => setSelected(await operationsApi.getProperty(property.id))}
                  >
                    <div>
                      <strong>{property.property_reference}</strong>
                      <small>{property.lot_number ?? 'No lot number'} · {property.municipality ?? 'Location pending'}</small>
                    </div>
                    <span>{stageLabels[property.acquisition_stage]}</span>
                    <b>{property.readiness_percent}%</b>
                  </button>
                ))}
              </div>
            )}
            {selected && (
              <PropertyDrawer
                property={selected}
                members={members}
                owners={owners}
                projects={projects}
                role={role}
                currentUserId={currentUserId}
                canManageOwners={canManageOwners}
                onClose={() => setSelected(null)}
                onSaved={async () => {
                  setSelected(null);
                  await load();
                }}
              />
            )}
          </section>
        )}
        {showCreateProject && (
          <CreateProject
            organizationId={organizationId}
            onClose={() => setShowCreateProject(false)}
            onCreated={async () => {
              setShowCreateProject(false);
              await load();
            }}
          />
        )}
        {showCreateProperty && (
          <CreateProperty
            organizationId={organizationId}
            projects={projects}
            members={members}
            onClose={() => setShowCreateProperty(false)}
            onCreated={async () => {
              setShowCreateProperty(false);
              await load();
            }}
          />
        )}
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="ops-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PropertyDrawer({
  property,
  members,
  owners,
  projects,
  role,
  currentUserId,
  canManageOwners,
  onClose,
  onSaved,
}: {
  property: Property;
  members: Member[];
  owners: Owner[];
  projects: Project[];
  role: OrganizationRole;
  currentUserId: string | null;
  canManageOwners: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const allowed = allowedPropertyPatchKeys(role);
  const [stage, setStage] = useState(property.acquisition_stage);
  const [readiness, setReadiness] = useState(String(property.readiness_percent));
  const [risk, setRisk] = useState(property.risk);
  const [legalStatus, setLegalStatus] = useState(property.legal_status);
  const [documentationStatus, setDocumentationStatus] = useState(property.documentation_status);
  const [paymentStatus, setPaymentStatus] = useState(property.payment_status);
  const [negotiatorId, setNegotiatorId] = useState(property.assigned_negotiator_id ?? '');
  const [managerId, setManagerId] = useState(property.assigned_manager_id ?? '');
  const [linkedOwners, setLinkedOwners] = useState<PropertyOwner[]>(property.owners ?? []);
  const [ownerId, setOwnerId] = useState(owners[0]?.id ?? '');
  const [newOwnerName, setNewOwnerName] = useState('');
  const [newOwnerType, setNewOwnerType] = useState<OwnerType>('individual');
  const [newOwnerOrg, setNewOwnerOrg] = useState('');
  const [newOwnerContact, setNewOwnerContact] = useState('');
  const [ownershipPercent, setOwnershipPercent] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [ownerError, setOwnerError] = useState('');
  const [saving, setSaving] = useState(false);
  const canSave = allowed.size > 0;

  const refreshOwners = async () => {
    setLinkedOwners(await operationsApi.listPropertyOwners(property.id));
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="property-drawer" onClick={(event) => event.stopPropagation()}>
        <button className="drawer-close" onClick={onClose}>×</button>
        <span className="panel-kicker">PROPERTY</span>
        <h2>{property.property_reference}</h2>
        <p>{property.municipality}, {property.province}{property.barangay ? ` · ${property.barangay}` : ''}</p>
        <p className="drawer-meta">{property.project_code} — {property.project_name}</p>
        {allowed.has('acquisitionStage') && (
          <label>
            Acquisition stage
            <select value={stage} onChange={(event) => setStage(event.target.value as AcquisitionStage)}>
              {Object.entries(stageLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
        )}
        {allowed.has('readinessPercent') && (
          <label>
            Readiness %
            <input type="number" min="0" max="100" value={readiness} onChange={(event) => setReadiness(event.target.value)} />
          </label>
        )}
        {allowed.has('risk') && (
          <label>
            Risk
            <select value={risk} onChange={(event) => setRisk(event.target.value as Property['risk'])}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        )}
        {allowed.has('legalStatus') && (
          <label>
            Legal status
            <select value={legalStatus} onChange={(event) => setLegalStatus(event.target.value)}>
              <option value="unknown">Unknown</option>
              <option value="clear">Clear</option>
              <option value="under_review">Under review</option>
              <option value="blocked">Blocked</option>
            </select>
          </label>
        )}
        {allowed.has('documentationStatus') && (
          <label>
            Documentation status
            <input value={documentationStatus} onChange={(event) => setDocumentationStatus(event.target.value)} />
          </label>
        )}
        {allowed.has('paymentStatus') && (
          <label>
            Payment status
            <input value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)} />
          </label>
        )}
        {allowed.has('assignedNegotiatorId') && (
          <label>
            Assigned negotiator
            <select value={negotiatorId} onChange={(event) => setNegotiatorId(event.target.value)}>
              <option value="">Unassigned</option>
              {assignmentChoices(members, negotiatorAssignmentRoles).map((member) => (
                <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
              ))}
            </select>
          </label>
        )}
        {allowed.has('assignedManagerId') && (
          <label>
            Assigned manager
            <select value={managerId} onChange={(event) => setManagerId(event.target.value)}>
              <option value="">Unassigned</option>
              {assignmentChoices(members, managerAssignmentRoles).map((member) => (
                <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
              ))}
            </select>
          </label>
        )}
        <div className="drawer-summary">
          <span>Negotiator <b>{property.negotiator_name ?? 'Unassigned'}</b></span>
          <span>Manager <b>{property.manager_name ?? 'Unassigned'}</b></span>
          <span>Legal <b>{property.legal_status}</b></span>
        </div>
        {canSave && (
          <button
            className="primary-button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              const payload: Record<string, unknown> = {};
              if (allowed.has('acquisitionStage')) payload.acquisitionStage = stage;
              if (allowed.has('readinessPercent')) payload.readinessPercent = Number(readiness);
              if (allowed.has('risk')) payload.risk = risk;
              if (allowed.has('legalStatus')) payload.legalStatus = legalStatus;
              if (allowed.has('documentationStatus')) payload.documentationStatus = documentationStatus;
              if (allowed.has('paymentStatus')) payload.paymentStatus = paymentStatus;
              if (allowed.has('assignedNegotiatorId')) payload.assignedNegotiatorId = negotiatorId || null;
              if (allowed.has('assignedManagerId')) payload.assignedManagerId = managerId || null;
              await operationsApi.updateProperty(property.id, payload);
              await onSaved();
            }}
          >
            Save changes
          </button>
        )}
        <section className="owner-block">
          <h3>Owners</h3>
          {ownerError && <p className="form-error">{ownerError}</p>}
          {linkedOwners.length === 0 ? (
            <p>No owners linked yet.</p>
          ) : (
            <ul className="owner-list">
              {linkedOwners.map((owner) => (
                <li key={owner.owner_id}>
                  <strong>{owner.display_name}</strong>
                  <small>
                    {ownerTypeLabels[owner.owner_type]}
                    {owner.is_primary ? ' · Primary' : ''}
                    {owner.ownership_percent != null ? ` · ${owner.ownership_percent}%` : ''}
                  </small>
                  {canManageOwners && (
                    <button
                      type="button"
                      onClick={async () => {
                        setOwnerError('');
                        try {
                          await operationsApi.unlinkPropertyOwner(property.id, owner.owner_id);
                          await refreshOwners();
                        } catch (cause) {
                          setOwnerError(cause instanceof Error ? cause.message : 'Unable to unlink owner');
                        }
                      }}
                    >
                      Unlink
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManageOwners && (
            <>
              <label>
                Link existing owner
                <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
                  {owners.map((owner) => (
                    <option key={owner.id} value={owner.id}>{owner.display_name}</option>
                  ))}
                </select>
              </label>
              <label>
                Ownership %
                <input value={ownershipPercent} onChange={(event) => setOwnershipPercent(event.target.value)} type="number" min="0" max="100" />
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={isPrimary} onChange={(event) => setIsPrimary(event.target.checked)} />
                Primary owner
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={!ownerId}
                onClick={async () => {
                  await operationsApi.linkPropertyOwner(property.id, {
                    ownerId,
                    ownershipPercent: ownershipPercent ? Number(ownershipPercent) : null,
                    isPrimary,
                  });
                  await refreshOwners();
                }}
              >
                Link owner
              </button>
              <h3>Create owner</h3>
              <label>
                Display name
                <input value={newOwnerName} onChange={(event) => setNewOwnerName(event.target.value)} />
              </label>
              <label>
                Owner type
                <select value={newOwnerType} onChange={(event) => setNewOwnerType(event.target.value as OwnerType)}>
                  {Object.entries(ownerTypeLabels).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                Organization name
                <input value={newOwnerOrg} onChange={(event) => setNewOwnerOrg(event.target.value)} />
              </label>
              <label>
                Contact details
                <input value={newOwnerContact} onChange={(event) => setNewOwnerContact(event.target.value)} />
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={!newOwnerName}
                onClick={async () => {
                  const created = await operationsApi.createOwner({
                    organizationId: property.organization_id,
                    ownerType: newOwnerType,
                    displayName: newOwnerName,
                    organizationName: newOwnerOrg || null,
                    contactDetails: newOwnerContact ? { notes: newOwnerContact } : undefined,
                  });
                  await operationsApi.linkPropertyOwner(property.id, {
                    ownerId: created.id,
                    ownershipPercent: ownershipPercent ? Number(ownershipPercent) : null,
                    isPrimary,
                  });
                  setNewOwnerName('');
                  await refreshOwners();
                }}
              >
                Create and link owner
              </button>
            </>
          )}
        </section>
        <NegotiationBlock
          property={property}
          members={members}
          role={role}
          currentUserId={currentUserId}
        />
        <DocumentBlock property={property} role={role} />
        <TaskBlock property={property} role={role} members={members} projects={projects} currentUserId={currentUserId} />
        <PaymentBlock property={property} role={role} />
        <AgreementSignaturesBlock property={property} role={role} />
        <PropertyTimelineBlock property={property} />
      </aside>
    </div>
  );
}

function formatMoney(amount: number | null, currency: string) {
  if (amount == null) return '—';
  return `${currency} ${Number(amount).toLocaleString()}`;
}

function NegotiationBlock({
  property,
  members,
  role,
  currentUserId,
}: {
  property: Property;
  members: Member[];
  role: OrganizationRole;
  currentUserId: string | null;
}) {
  const [negotiation, setNegotiation] = useState<Negotiation | null>(null);
  const [events, setEvents] = useState<NegotiationEvent[]>([]);
  const [openingAmount, setOpeningAmount] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [assignedNegotiatorId, setAssignedNegotiatorId] = useState(property.assigned_negotiator_id ?? '');
  const [status, setStatus] = useState<NegotiationStatus>('open');
  const [eventType, setEventType] = useState<NegotiationEventType>('offer');
  const [eventAmount, setEventAmount] = useState('');
  const [eventNote, setEventNote] = useState('');
  const [error, setError] = useState('');
  const isManager = negotiationManagerRoles.includes(role);
  const active = negotiation && (negotiation.status === 'open' || negotiation.status === 'paused');
  const canWrite =
    isManager || (role === 'negotiator' && negotiation?.assigned_negotiator_id === currentUserId);
  const canCreate =
    !active &&
    property.acquisition_stage === 'negotiation' &&
    (isManager || (role === 'negotiator' && property.assigned_negotiator_id === currentUserId));

  const refresh = async () => {
    const listed = await operationsApi.listNegotiations(property.organization_id, { propertyId: property.id });
    const current =
      listed.find((entry) => entry.status === 'open' || entry.status === 'paused') ?? listed[0] ?? null;
    setNegotiation(current);
    setStatus(current?.status ?? 'open');
    setAssignedNegotiatorId(current?.assigned_negotiator_id ?? property.assigned_negotiator_id ?? '');
    setEvents(current ? await operationsApi.listNegotiationEvents(current.id) : []);
  };

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load negotiation'));
  }, [property.id]);

  return (
    <section className="owner-block">
      <h3>Negotiation</h3>
      {error && <p className="form-error">{error}</p>}
      {negotiation ? (
        <>
          <div className="drawer-summary">
            <span>Status <b>{negotiationStatusLabels[negotiation.status]}</b></span>
            <span>Assigned negotiator <b>{negotiation.assigned_negotiator_name ?? 'Unassigned'}</b></span>
            <span>Currency <b>{negotiation.currency_code}</b></span>
            <span>Opening <b>{formatMoney(negotiation.opening_amount, negotiation.currency_code)}</b></span>
            <span>Target <b>{formatMoney(negotiation.target_amount, negotiation.currency_code)}</b></span>
            <span>Current <b>{formatMoney(negotiation.current_amount, negotiation.currency_code)}</b></span>
            <span>Started <b>{new Date(negotiation.started_at).toLocaleString()}</b></span>
            <span>Closed <b>{negotiation.closed_at ? new Date(negotiation.closed_at).toLocaleString() : '—'}</b></span>
          </div>
          {canWrite && (
            <>
              <label>
                Status
                <select value={status} onChange={(event) => setStatus(event.target.value as NegotiationStatus)}>
                  {Object.entries(negotiationStatusLabels).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </label>
              {isManager && (
                <label>
                  Negotiation negotiator
                  <select value={assignedNegotiatorId} onChange={(event) => setAssignedNegotiatorId(event.target.value)}>
                    <option value="">Unassigned</option>
                    {assignmentChoices(members, negotiatorAssignmentRoles).map((member) => (
                      <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="primary-button"
                type="button"
                onClick={async () => {
                  setError('');
                  await operationsApi.updateNegotiation(negotiation.id, {
                    status,
                    assignedNegotiatorId: isManager ? assignedNegotiatorId || null : undefined,
                  });
                  await refresh();
                }}
              >
                Update negotiation
              </button>
            </>
          )}
        </>
      ) : (
        <p>No negotiation on this property yet.</p>
      )}
      {canCreate && (
        <>
          <h3>Create negotiation</h3>
          <label>
            Opening amount
            <input value={openingAmount} onChange={(event) => setOpeningAmount(event.target.value)} type="number" min="0" />
          </label>
          <label>
            Target amount
            <input value={targetAmount} onChange={(event) => setTargetAmount(event.target.value)} type="number" min="0" />
          </label>
          {isManager && (
            <label>
              Assigned negotiator
              <select value={assignedNegotiatorId} onChange={(event) => setAssignedNegotiatorId(event.target.value)}>
                <option value="">Unassigned</option>
                {assignmentChoices(members, negotiatorAssignmentRoles).map((member) => (
                  <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
                ))}
              </select>
            </label>
          )}
          <button
            className="primary-button"
            type="button"
            onClick={async () => {
              setError('');
              await operationsApi.createNegotiation({
                organizationId: property.organization_id,
                propertyId: property.id,
                assignedNegotiatorId: isManager ? assignedNegotiatorId || null : undefined,
                openingAmount: openingAmount ? Number(openingAmount) : null,
                targetAmount: targetAmount ? Number(targetAmount) : null,
              });
              await refresh();
            }}
          >
            Create negotiation
          </button>
        </>
      )}
      {negotiation && (
        <>
          <h3>Negotiation history</h3>
          {events.length === 0 ? (
            <p>No events yet.</p>
          ) : (
            <ul className="owner-list">
              {events.map((event) => (
                <li key={event.id}>
                  <strong>{eventTypeLabels[event.event_type]}</strong>
                  <small>
                    {event.actor_name ?? 'Unknown actor'}
                    {event.amount != null ? ` · ${formatMoney(event.amount, negotiation.currency_code)}` : ''}
                    {` · ${new Date(event.occurred_at).toLocaleString()}`}
                  </small>
                  {event.contextual_note && <small>{event.contextual_note}</small>}
                </li>
              ))}
            </ul>
          )}
          {canWrite && (
            <>
              <label>
                Event type
                <select value={eventType} onChange={(event) => setEventType(event.target.value as NegotiationEventType)}>
                  {Object.entries(eventTypeLabels).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                Amount
                <input value={eventAmount} onChange={(event) => setEventAmount(event.target.value)} type="number" min="0" />
              </label>
              <label>
                Note
                <input value={eventNote} onChange={(event) => setEventNote(event.target.value)} />
              </label>
              <button
                className="primary-button"
                type="button"
                onClick={async () => {
                  setError('');
                  await operationsApi.createNegotiationEvent(negotiation.id, {
                    eventType,
                    amount: eventAmount ? Number(eventAmount) : null,
                    contextualNote: eventNote || null,
                  });
                  setEventAmount('');
                  setEventNote('');
                  await refresh();
                }}
              >
                Record event
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}

function DocumentBlock({ property, role }: { property: Property; role: OrganizationRole }) {
  const [documents, setDocuments] = useState<PropertyDocument[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [category, setCategory] = useState<DocumentCategory>('other');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const canWrite = documentWriteRoles.includes(role);

  const refresh = async () => {
    setDocuments(await operationsApi.listDocuments(property.id, { includeArchived }));
  };

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load documents'));
  }, [property.id, includeArchived]);

  const download = async (id: string) => {
    const { blob, filename } = await operationsApi.downloadDocument(id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="owner-block">
      <h3>Documents</h3>
      {error && <p className="form-error">{error}</p>}
      <label className="checkbox-row">
        <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
        Include archived
      </label>
      {documents.length === 0 ? (
        <p>No documents uploaded yet.</p>
      ) : (
        <ul className="owner-list">
          {documents.map((doc) => (
            <li key={doc.id}>
              <strong>{doc.title}</strong>
              <small>
                {documentCategoryLabels[doc.category]} · {documentStatusLabels[doc.status]}
                {doc.uploaded_by_name ? ` · ${doc.uploaded_by_name}` : ''}
                {` · ${new Date(doc.created_at).toLocaleString()}`}
                {doc.archived_at ? ' · Archived' : ''}
              </small>
              <button type="button" onClick={() => void download(doc.id)}>
                Download
              </button>
              {canWrite && (
                <>
                  <button
                    type="button"
                    onClick={async () => {
                      await operationsApi.updateDocument(doc.id, { archived: !doc.archived_at });
                      await refresh();
                    }}
                  >
                    {doc.archived_at ? 'Unarchive' : 'Archive'}
                  </button>
                  <select
                    aria-label={`Status for ${doc.title}`}
                    value={doc.status}
                    onChange={async (event) => {
                      await operationsApi.updateDocument(doc.id, { status: event.target.value as DocumentStatus });
                      await refresh();
                    }}
                  >
                    {Object.entries(documentStatusLabels).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <>
          <h3>Upload document</h3>
          <label>
            Document title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Document category
            <select value={category} onChange={(event) => setCategory(event.target.value as DocumentCategory)}>
              {Object.entries(documentCategoryLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            File
            <input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={!title || !file || uploading}
            onClick={async () => {
              if (!file) return;
              setUploading(true);
              setError('');
              try {
                await operationsApi.uploadDocument(property.id, { category, title, file });
                setTitle('');
                setFile(null);
                await refresh();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Upload failed');
              } finally {
                setUploading(false);
              }
            }}
          >
            Upload document
          </button>
        </>
      )}
    </section>
  );
}

function TaskBlock({
  property,
  role,
  members,
  projects,
  currentUserId,
}: {
  property: Property;
  role: OrganizationRole;
  members: Member[];
  projects: Project[];
  currentUserId: string | null;
}) {
  const [tasks, setTasks] = useState<PropertyTask[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [dueOn, setDueOn] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const project = projects.find((entry) => entry.id === property.project_id);
  const isManager =
    taskManagerRoles.includes(role) ||
    (role === 'supervisor' &&
      (property.assigned_manager_id === currentUserId || project?.manager_user_id === currentUserId));
  const canCreateSelfAssigned =
    (role === 'negotiator' && property.assigned_negotiator_id === currentUserId) ||
    taskSelfAssignCreateRoles.includes(role);
  const canCreate = isManager || canCreateSelfAssigned;
  const activeMembers = members.filter((member) => member.is_active);

  const isSelfAssignee = (task: PropertyTask) => role !== 'viewer' && task.assigned_user_id === currentUserId;
  const canEdit = (task: PropertyTask) => isManager || isSelfAssignee(task);

  const refresh = async () => {
    setTasks(await operationsApi.listTasks(property.id, { includeArchived }));
  };

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load tasks'));
  }, [property.id, includeArchived]);

  return (
    <section className="owner-block">
      <h3>Tasks</h3>
      {error && <p className="form-error">{error}</p>}
      <label className="checkbox-row">
        <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
        Include archived tasks
      </label>
      {tasks.length === 0 ? (
        <p>No tasks yet.</p>
      ) : (
        <ul className="owner-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <strong>{task.title}</strong>
              <small>
                {taskPriorityLabels[task.priority]} · {taskStatusLabels[task.status]}
                {task.assigned_user_name ? ` · ${task.assigned_user_name}` : ' · Unassigned'}
                {task.due_on ? ` · Due ${task.due_on}` : ''}
                {task.archived_at ? ' · Archived' : ''}
              </small>
              {task.description && <small>{task.description}</small>}
              {canEdit(task) && (
                <>
                  <label>
                    Status for {task.title}
                    <select
                      value={task.status}
                      onChange={async (event) => {
                        await operationsApi.updateTask(task.id, { status: event.target.value as TaskStatus });
                        await refresh();
                      }}
                    >
                      {Object.entries(taskStatusLabels).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Priority for {task.title}
                    <select
                      value={task.priority}
                      onChange={async (event) => {
                        await operationsApi.updateTask(task.id, { priority: event.target.value as TaskPriority });
                        await refresh();
                      }}
                    >
                      {Object.entries(taskPriorityLabels).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Due date for {task.title}
                    <input
                      type="date"
                      value={task.due_on ?? ''}
                      onChange={async (event) => {
                        await operationsApi.updateTask(task.id, { dueOn: event.target.value || null });
                        await refresh();
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      await operationsApi.updateTask(task.id, { archived: !task.archived_at });
                      await refresh();
                    }}
                  >
                    {task.archived_at ? 'Unarchive task' : 'Archive task'}
                  </button>
                </>
              )}
              {isManager && (
                <label>
                  Assignee for {task.title}
                  <select
                    value={task.assigned_user_id ?? ''}
                    onChange={async (event) => {
                      await operationsApi.updateTask(task.id, { assignedUserId: event.target.value || null });
                      await refresh();
                    }}
                  >
                    <option value="">Unassigned</option>
                    {activeMembers.map((member) => (
                      <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
                    ))}
                  </select>
                </label>
              )}
            </li>
          ))}
        </ul>
      )}
      {canCreate && (
        <>
          <h3>Create task</h3>
          <label>
            Task title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Task description
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label>
            Task priority
            <select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
              {Object.entries(taskPriorityLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Task due date
            <input type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
          </label>
          {isManager && (
            <label>
              Assign task to
              <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
                <option value="">Unassigned</option>
                {activeMembers.map((member) => (
                  <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
                ))}
              </select>
            </label>
          )}
          <button
            className="primary-button"
            type="button"
            disabled={!title || saving}
            onClick={async () => {
              setSaving(true);
              setError('');
              try {
                await operationsApi.createTask(property.id, {
                  title,
                  description: description || null,
                  priority,
                  dueOn: dueOn || null,
                  assignedUserId: isManager ? assigneeId || null : currentUserId,
                });
                setTitle('');
                setDescription('');
                setPriority('normal');
                setDueOn('');
                setAssigneeId('');
                await refresh();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Unable to create task');
              } finally {
                setSaving(false);
              }
            }}
          >
            Create task
          </button>
        </>
      )}
    </section>
  );
}

function PaymentBlock({ property, role }: { property: Property; role: OrganizationRole }) {
  const [payments, setPayments] = useState<PropertyPayment[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [amount, setAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState('PHP');
  const [paymentType, setPaymentType] = useState<PaymentType>('deposit');
  const [scheduledOn, setScheduledOn] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const canWrite = paymentWriteRoles.includes(role);

  const refresh = async () => {
    setPayments(await operationsApi.listPayments(property.id, { includeArchived }));
  };

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load payments'));
  }, [property.id, includeArchived]);

  return (
    <section className="owner-block">
      <h3>Payments</h3>
      {error && <p className="form-error">{error}</p>}
      <label className="checkbox-row">
        <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
        Include archived payments
      </label>
      {payments.length === 0 ? (
        <p>No payments recorded yet.</p>
      ) : (
        <ul className="owner-list">
          {payments.map((paymentRecord) => (
            <li key={paymentRecord.id}>
              <strong>{formatMoney(paymentRecord.amount, paymentRecord.currency_code)}</strong>
              <small>
                {paymentTypeLabels[paymentRecord.payment_type]} · {paymentStatusLabels[paymentRecord.status]}
                {paymentRecord.recorded_by_name ? ` · ${paymentRecord.recorded_by_name}` : ''}
                {paymentRecord.scheduled_on ? ` · Scheduled ${paymentRecord.scheduled_on}` : ''}
                {paymentRecord.paid_on ? ` · Paid ${paymentRecord.paid_on}` : ''}
                {paymentRecord.reference_number ? ` · Ref ${paymentRecord.reference_number}` : ''}
                {paymentRecord.archived_at ? ' · Archived' : ''}
              </small>
              {canWrite && (
                <>
                  <label>
                    Status for payment of {formatMoney(paymentRecord.amount, paymentRecord.currency_code)}
                    <select
                      value={paymentRecord.status}
                      onChange={async (event) => {
                        await operationsApi.updatePayment(paymentRecord.id, {
                          status: event.target.value as PaymentStatus,
                        });
                        await refresh();
                      }}
                    >
                      {Object.entries(paymentStatusLabels).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Paid date for payment {paymentRecord.id}
                    <input
                      type="date"
                      value={paymentRecord.paid_on ?? ''}
                      onChange={async (event) => {
                        await operationsApi.updatePayment(paymentRecord.id, { paidOn: event.target.value || null });
                        await refresh();
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      await operationsApi.updatePayment(paymentRecord.id, { archived: !paymentRecord.archived_at });
                      await refresh();
                    }}
                  >
                    {paymentRecord.archived_at ? 'Unarchive payment' : 'Archive payment'}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <>
          <h3>Record payment</h3>
          <label>
            Payment amount
            <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" step="0.01" />
          </label>
          <label>
            Payment currency
            <input value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)} maxLength={3} />
          </label>
          <label>
            Payment type
            <select value={paymentType} onChange={(event) => setPaymentType(event.target.value as PaymentType)}>
              {Object.entries(paymentTypeLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Payment scheduled date
            <input type="date" value={scheduledOn} onChange={(event) => setScheduledOn(event.target.value)} />
          </label>
          <label>
            Payment reference number
            <input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} />
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={!amount || saving}
            onClick={async () => {
              setSaving(true);
              setError('');
              try {
                await operationsApi.createPayment(property.id, {
                  amount: Number(amount),
                  currencyCode,
                  paymentType,
                  scheduledOn: scheduledOn || null,
                  referenceNumber: referenceNumber || null,
                });
                setAmount('');
                setReferenceNumber('');
                setScheduledOn('');
                await refresh();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Unable to record payment');
              } finally {
                setSaving(false);
              }
            }}
          >
            Record payment
          </button>
        </>
      )}
    </section>
  );
}

/**
 * Document-specific: a property may carry several agreement_executed
 * documents. "Not signed" is derived from property owners minus active
 * signature rows for that document -- nothing is persisted as pending.
 */
function AgreementSignaturesBlock({ property, role }: { property: Property; role: OrganizationRole }) {
  const [documents, setDocuments] = useState<PropertyDocument[]>([]);
  const [owners, setOwners] = useState<PropertyOwner[]>([]);
  const [signatures, setSignatures] = useState<AgreementSignature[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [signedDates, setSignedDates] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const canWrite = agreementSignatureWriteRoles.includes(role);

  const refresh = async () => {
    const [listedDocuments, listedOwners, listedSignatures] = await Promise.all([
      operationsApi.listDocuments(property.id, { category: 'agreement_executed' }),
      operationsApi.listPropertyOwners(property.id),
      operationsApi.listAgreementSignatures(property.id, { includeArchived }),
    ]);
    setDocuments(listedDocuments);
    setOwners(listedOwners);
    setSignatures(listedSignatures);
  };

  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update agreement signatures');
    }
  };

  useEffect(() => {
    void refresh().catch((cause) =>
      setError(cause instanceof Error ? cause.message : 'Unable to load agreement signatures'),
    );
  }, [property.id, includeArchived]);

  return (
    <section className="owner-block">
      <h3>Agreement signatures</h3>
      {error && <p className="form-error">{error}</p>}
      <button type="button" onClick={() => void run(async () => undefined)}>
        Refresh signatures
      </button>
      <label className="checkbox-row">
        <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
        Include archived signatures
      </label>
      {documents.length === 0 ? (
        <p>No executed agreement documents on this property.</p>
      ) : (
        documents.map((document) => {
          const forDocument = signatures.filter((signature) => signature.document_id === document.id);
          const active = forDocument.filter((signature) => !signature.archived_at);
          const archived = forDocument.filter((signature) => signature.archived_at);
          const ownerIds = new Set(owners.map((owner) => owner.owner_id));
          const signedCount = owners.filter((owner) => active.some((signature) => signature.owner_id === owner.owner_id)).length;
          const unlinkedActive = active.filter((signature) => !ownerIds.has(signature.owner_id));
          return (
            <div key={document.id}>
              <h4>{document.title}</h4>
              <small>{signedCount} of {owners.length} owners signed</small>
              {owners.length === 0 && <p>No owners linked to this property.</p>}
              <ul className="owner-list">
                {owners.map((owner) => {
                  const signature = active.find((entry) => entry.owner_id === owner.owner_id);
                  const key = `${document.id}:${owner.owner_id}`;
                  const context = `${owner.display_name} on ${document.title}`;
                  return (
                    <li key={key}>
                      <strong>{owner.display_name}</strong>
                      <small>
                        {signature
                          ? `Signed ${signature.signed_on}${signature.recorded_by_name ? ` · recorded by ${signature.recorded_by_name}` : ''}`
                          : 'Not signed'}
                      </small>
                      {canWrite && signature && (
                        <button
                          type="button"
                          aria-label={`Archive signature for ${context}`}
                          onClick={() => void run(() => operationsApi.archiveAgreementSignature(signature.id))}
                        >
                          Archive signature
                        </button>
                      )}
                      {canWrite && !signature && (
                        <>
                          <label>
                            Signed date for {context}
                            <input
                              type="date"
                              value={signedDates[key] ?? ''}
                              onChange={(event) => setSignedDates((current) => ({ ...current, [key]: event.target.value }))}
                            />
                          </label>
                          <button
                            type="button"
                            aria-label={`Record signature for ${context}`}
                            disabled={!signedDates[key]}
                            onClick={() =>
                              void run(async () => {
                                await operationsApi.createAgreementSignature(property.id, {
                                  documentId: document.id,
                                  ownerId: owner.owner_id,
                                  signedOn: signedDates[key],
                                });
                                setSignedDates((current) => ({ ...current, [key]: '' }));
                              })
                            }
                          >
                            Record signature
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
                {unlinkedActive.map((signature) => (
                  <li key={signature.id}>
                    <strong>{signature.owner_name ?? 'Unknown owner'}</strong>
                    <small>Signed {signature.signed_on} · no longer linked as an owner</small>
                    {canWrite && (
                      <button
                        type="button"
                        aria-label={`Archive signature for ${signature.owner_name ?? 'unknown owner'} on ${document.title}`}
                        onClick={() => void run(() => operationsApi.archiveAgreementSignature(signature.id))}
                      >
                        Archive signature
                      </button>
                    )}
                  </li>
                ))}
                {includeArchived &&
                  archived.map((signature) => (
                    <li key={signature.id}>
                      <strong>{signature.owner_name ?? 'Unknown owner'}</strong>
                      <small>Signed {signature.signed_on} · Archived</small>
                    </li>
                  ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

const TIMELINE_PAGE_SIZE = 50;

/** Date-only entries stay date-only; recorded-basis entries say so. */
function timelineWhen(entry: TimelineEntry) {
  const when = entry.precision === 'date' ? entry.occurred_at : new Date(entry.occurred_at).toLocaleString();
  return entry.basis === 'recorded' ? `Recorded ${when}` : when;
}

/**
 * Read-only feed of facts the property's existing records can prove. It
 * complements the blocks above rather than replacing them, and has no write,
 * archive, or lifecycle controls.
 */
function PropertyTimelineBlock({ property }: { property: Property }) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async (offset: number) => {
    setError('');
    setLoading(true);
    try {
      const page = await operationsApi.getPropertyTimeline(property.id, { limit: TIMELINE_PAGE_SIZE, offset });
      setEntries((current) => (offset === 0 ? page : [...current, ...page]));
      setHasMore(page.length === TIMELINE_PAGE_SIZE);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load the timeline');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setEntries([]);
    setHasMore(false);
    setLoaded(false);
    void load(0);
  }, [property.id]);

  return (
    <section className="owner-block">
      <h3>Timeline</h3>
      {error && <p className="form-error">{error}</p>}
      <button type="button" aria-label="Refresh timeline" disabled={loading} onClick={() => void load(0)}>
        Refresh
      </button>
      {loaded && entries.length === 0 ? (
        <p>No recorded activity yet.</p>
      ) : (
        <ul className="owner-list" aria-label="Timeline entries">
          {entries.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.summary}</strong>
              <small>{timelineWhen(entry)}</small>
              {entry.actor && <small>Recorded by {entry.actor.display_name ?? 'a former member'}</small>}
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <button
          type="button"
          aria-label="Load more timeline entries"
          disabled={loading}
          onClick={() => void load(entries.length)}
        >
          Load more
        </button>
      )}
    </section>
  );
}

function CreateProject({
  organizationId,
  onClose,
  onCreated,
}: {
  organizationId: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <div className="drawer-backdrop">
      <aside className="property-drawer">
        <button className="drawer-close" onClick={onClose}>×</button>
        <span className="panel-kicker">NEW PROJECT</span>
        <h2>Create project</h2>
        <label>
          Project code
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="NCP-02" />
        </label>
        <label>
          Project name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="South Extension" />
        </label>
        <button
          className="primary-button"
          disabled={!code || !name || saving}
          onClick={async () => {
            setSaving(true);
            await operationsApi.createProject({ organization_id: organizationId, code, name });
            await onCreated();
          }}
        >
          Create project
        </button>
      </aside>
    </div>
  );
}

function CreateProperty({
  organizationId,
  projects,
  members,
  onClose,
  onCreated,
}: {
  organizationId: string;
  projects: Project[];
  members: Member[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [ref, setRef] = useState('');
  const [project, setProject] = useState(projects[0]?.id ?? '');
  const [municipality, setMunicipality] = useState('');
  const [province, setProvince] = useState('');
  const [barangay, setBarangay] = useState('');
  const [area, setArea] = useState('');
  const [negotiatorId, setNegotiatorId] = useState('');
  const [managerId, setManagerId] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <div className="drawer-backdrop">
      <aside className="property-drawer">
        <button className="drawer-close" onClick={onClose}>×</button>
        <span className="panel-kicker">NEW PROPERTY</span>
        <h2>Add acquisition</h2>
        <label>
          Property reference
          <input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="NCP-00150" />
        </label>
        <label>
          Project
          <select value={project} onChange={(event) => setProject(event.target.value)}>
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.code} — {entry.name}</option>
            ))}
          </select>
        </label>
        <label>
          Municipality
          <input value={municipality} onChange={(event) => setMunicipality(event.target.value)} placeholder="Calamba" />
        </label>
        <label>
          Province
          <input value={province} onChange={(event) => setProvince(event.target.value)} placeholder="Laguna" />
        </label>
        <label>
          Barangay
          <input value={barangay} onChange={(event) => setBarangay(event.target.value)} placeholder="Canlubang" />
        </label>
        <label>
          Area (hectares)
          <input value={area} onChange={(event) => setArea(event.target.value)} type="number" step="0.0001" />
        </label>
        <label>
          Assigned negotiator
          <select value={negotiatorId} onChange={(event) => setNegotiatorId(event.target.value)}>
            <option value="">Unassigned</option>
            {assignmentChoices(members, negotiatorAssignmentRoles).map((member) => (
              <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
            ))}
          </select>
        </label>
        <label>
          Assigned manager
          <select value={managerId} onChange={(event) => setManagerId(event.target.value)}>
            <option value="">Unassigned</option>
            {assignmentChoices(members, managerAssignmentRoles).map((member) => (
              <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
            ))}
          </select>
        </label>
        <button
          className="primary-button"
          disabled={!ref || !project || saving}
          onClick={async () => {
            setSaving(true);
            await operationsApi.createProperty({
              organizationId,
              projectId: project,
              propertyReference: ref,
              municipality,
              province,
              barangay,
              areaHectares: area ? Number(area) : undefined,
              assignedNegotiatorId: negotiatorId || null,
              assignedManagerId: managerId || null,
            });
            await onCreated();
          }}
        >
          Create property
        </button>
      </aside>
    </div>
  );
}
