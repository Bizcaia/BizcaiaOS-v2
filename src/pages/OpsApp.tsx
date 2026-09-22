import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FolderKanban, LayoutDashboard, Map, Plus, Search, ShieldCheck } from 'lucide-react';
import { organizationApi, organizationApiMode, type Member, type OrganizationRole } from '../api/organizationApi';
import {
  DEMO_ORGANIZATION_ID,
  operationsApi,
  type AcquisitionStage,
  type Owner,
  type OwnerType,
  type Project,
  type Property,
  type PropertyOwner,
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
                role={role}
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
  role,
  canManageOwners,
  onClose,
  onSaved,
}: {
  property: Property;
  members: Member[];
  owners: Owner[];
  role: OrganizationRole;
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
                        await operationsApi.unlinkPropertyOwner(property.id, owner.owner_id);
                        await refreshOwners();
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
      </aside>
    </div>
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
