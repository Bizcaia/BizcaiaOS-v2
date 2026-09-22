import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronDown,
  FileCheck2,
  GitBranch,
  Layers3,
  Map,
  Menu,
  MessageSquareText,
  MoveUpRight,
  PanelTop,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

const heroImage = "/manus-storage/bizcaiaos-hero_fdea4847.jpg";

const navItems = [
  { label: "Platform", href: "#platform" },
  { label: "How it works", href: "#workflow" },
  { label: "For teams", href: "#teams" },
];

const capabilities = [
  {
    number: "01",
    icon: PanelTop,
    title: "Property workspace",
    description:
      "Bring ownership, documents, negotiations, payments, tasks, and next actions into one shared record.",
  },
  {
    number: "02",
    icon: BarChart3,
    title: "Readiness at a glance",
    description:
      "Know which properties are moving, which are blocked, and what needs attention before closing.",
  },
  {
    number: "03",
    icon: MessageSquareText,
    title: "Negotiation intelligence",
    description:
      "Keep offers, counteroffers, context, and relationship history connected to the property—not buried in chat.",
  },
  {
    number: "04",
    icon: ShieldCheck,
    title: "Audit-ready operations",
    description:
      "Create a trustworthy timeline of decisions and evidence across every acquisition program.",
  },
];

const roles = [
  "Acquisition managers",
  "Negotiators",
  "Legal & documentation",
  "Finance teams",
  "Supervisors",
  "Executive leadership",
];

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function MiniDashboard() {
  return (
    <div className="dashboard-window" aria-label="BizcaiaOS product dashboard preview">
      <div className="dashboard-topbar">
        <div className="window-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <span className="window-title">Portfolio / Overview</span>
        <span className="live-pill"><span /> Live portfolio</span>
      </div>
      <div className="dashboard-content">
        <div className="dashboard-sidebar">
          <div className="sidebar-logo"><LogoMark /></div>
          <div className="sidebar-icon active"><PanelTop size={15} /></div>
          <div className="sidebar-icon"><Map size={15} /></div>
          <div className="sidebar-icon"><FileCheck2 size={15} /></div>
          <div className="sidebar-icon"><MessageSquareText size={15} /></div>
          <div className="sidebar-icon"><BarChart3 size={15} /></div>
          <div className="sidebar-spacer" />
          <div className="sidebar-avatar">AM</div>
        </div>
        <div className="dashboard-main">
          <div className="dashboard-heading">
            <div>
              <span className="mini-label">NORTH CORRIDOR PROGRAM</span>
              <h3>Good morning, Alex</h3>
            </div>
            <button className="small-action"><span>+ Add property</span></button>
          </div>
          <div className="stat-grid">
            <div className="stat-card primary-stat"><span>Properties</span><strong>248</strong><em>+12 this month</em></div>
            <div className="stat-card"><span>Acquisition-ready</span><strong>42</strong><em className="green-text">↑ 8.4%</em></div>
            <div className="stat-card"><span>Active negotiations</span><strong>18</strong><em>6 need attention</em></div>
          </div>
          <div className="dashboard-grid">
            <div className="pipeline-card">
              <div className="card-title-row"><div><span className="mini-label">ACQUISITION PIPELINE</span><h4>Portfolio movement</h4></div><span className="card-kebab">•••</span></div>
              <div className="bar-chart" aria-hidden="true">
                <div className="chart-y"><span>250</span><span>125</span><span>0</span></div>
                <div className="chart-bars"><i style={{ height: "35%" }} /><i style={{ height: "48%" }} /><i style={{ height: "57%" }} /><i style={{ height: "45%" }} /><i className="highlight" style={{ height: "75%" }} /><i style={{ height: "63%" }} /><i style={{ height: "82%" }} /></div>
                <div className="chart-x"><span>JAN</span><span>FEB</span><span>MAR</span><span>APR</span><span>MAY</span><span>JUN</span><span>JUL</span></div>
              </div>
            </div>
            <div className="readiness-card">
              <div className="card-title-row"><div><span className="mini-label">READINESS</span><h4>By stage</h4></div><span className="card-kebab">•••</span></div>
              <div className="donut-wrap"><div className="donut"><div><strong>73%</strong><span>ready</span></div></div><div className="donut-legend"><span><i className="legend-red" />Ready <b>42</b></span><span><i className="legend-cream" />In review <b>31</b></span><span><i className="legend-gray" />Blocked <b>12</b></span></div></div>
            </div>
          </div>
          <div className="attention-row"><div className="attention-icon"><Sparkles size={14} /></div><div><strong>Next best action</strong><span>3 properties have completed document validation and are ready for commercial review.</span></div><ArrowUpRight size={16} /></div>
        </div>
      </div>
    </div>
  );
}

function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const scrollTo = (href: string) => {
    setMenuOpen(false);
    document.querySelector(href)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="site-shell">
      <header className={`site-nav ${menuOpen ? "menu-open" : ""}`}>
        <a className="brand" href="#top" onClick={() => setMenuOpen(false)} aria-label="BizcaiaOS home">
          <LogoMark />
          <span>bizcaia<span>os</span></span>
        </a>
        <nav className="desktop-nav" aria-label="Main navigation">
          {navItems.map((item) => <a key={item.href} href={item.href}>{item.label}</a>)}
        </nav>
        <div className="nav-actions">
          <a className="nav-login" href="#app">Log in <ArrowUpRight size={14} /></a>
          <button className="nav-cta" onClick={() => { window.location.hash = "app"; window.location.reload(); }}>Book a walkthrough <ArrowUpRight size={15} /></button>
        </div>
        <button className="mobile-menu-button" onClick={() => setMenuOpen((current) => !current)} aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen}>
          {menuOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
        {menuOpen && <nav className="mobile-nav" aria-label="Mobile navigation">{navItems.map((item) => <a key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>{item.label}<ArrowRight size={16} /></a>)}<a href="#app" onClick={() => setMenuOpen(false)}>Book a walkthrough<ArrowUpRight size={16} /></a></nav>}
      </header>

      <main id="top">
        <section className="hero-section">
          <div className="hero-background" style={{ backgroundImage: `linear-gradient(90deg, rgba(13,13,13,.98) 0%, rgba(13,13,13,.88) 38%, rgba(13,13,13,.36) 74%, rgba(13,13,13,.7) 100%), url(${heroImage})` }} />
          <div className="hero-grid" aria-hidden="true" />
          <div className="hero-noise" aria-hidden="true" />
          <div className="container hero-layout">
            <div className="hero-copy">
              <div className="eyebrow light-eyebrow"><span className="eyebrow-line" /> THE OPERATING SYSTEM FOR LAND ACQUISITION</div>
              <h1>Move every property <em>closer to close.</em></h1>
              <p className="hero-lede">BizcaiaOS brings your acquisition pipeline, property intelligence, and next actions into one clear operating view—so your team can move with confidence.</p>
              <div className="hero-actions"><button className="button button-red" onClick={() => { window.location.hash = "app"; window.location.reload(); }}>Book a product walkthrough <ArrowUpRight size={17} /></button><button className="text-link light-link" onClick={() => scrollTo("#platform")}>Explore the platform <ArrowDown size={15} /></button></div>
              <div className="hero-proof"><div className="proof-avatars"><span>LT</span><span>MS</span><span>AR</span><span>+</span></div><span>Built for the teams behind the land</span></div>
            </div>
            <div className="hero-product"><MiniDashboard /><div className="float-note"><span className="float-icon"><Sparkles size={14} /></span><span><strong>Clear next actions</strong><small>for every property</small></span></div></div>
          </div>
          <div className="hero-scroll"><span>Scroll to explore</span><ArrowDown size={15} /></div>
        </section>

        <section className="trust-strip"><div className="container trust-inner"><span className="trust-label">One source of truth for</span><div className="trust-roles">{roles.slice(0, 4).map((role) => <span key={role}>{role}</span>)}</div><span className="trust-count">+ more <ArrowRight size={14} /></span></div></section>

        <section className="problem-section section-cream" id="workflow">
          <div className="container">
            <div className="section-intro two-col-intro"><div><div className="eyebrow dark-eyebrow"><span className="eyebrow-line" /> THE OLD WAY</div><h2>When the operation lives in too many places, <em>momentum gets lost.</em></h2></div><p>Land acquisition is too consequential to run on scattered spreadsheets, message threads, and document folders. BizcaiaOS turns the noise into a shared operational rhythm.</p></div>
            <div className="friction-grid"><div className="friction-card"><span className="friction-index">01</span><div className="friction-visual spreadsheet-visual"><div className="fake-sheet"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div><div className="red-stamp">FRAGMENTED</div></div><h3>Scattered information</h3><p>Critical property context is split across tools, people, and versions of the truth.</p></div><div className="friction-card"><span className="friction-index">02</span><div className="friction-visual thread-visual"><div className="fake-message one">Can we get the latest title docs?</div><div className="fake-message two">I think they’re in the other folder.</div><div className="fake-message three">Which offer is current?</div></div><h3>Unclear next steps</h3><p>Teams spend more time chasing updates than making the next decision.</p></div><div className="friction-card"><span className="friction-index">03</span><div className="friction-visual folder-visual"><FileCheck2 size={26} /><span>12 documents missing</span><b>!</b></div><h3>Hidden operational risk</h3><p>Gaps in documents, ownership, and approvals surface late—when they cost the most.</p></div></div>
          </div>
        </section>

        <section className="platform-section section-dark" id="platform">
          <div className="container">
            <div className="section-intro platform-intro"><div><div className="eyebrow light-eyebrow"><span className="eyebrow-line" /> THE BIZCAIAOS DIFFERENCE</div><h2>One property.<br /><em>Every critical signal.</em></h2></div><div className="platform-intro-right"><p>Designed around the property as the source of truth, BizcaiaOS connects the full acquisition lifecycle without creating more administrative work.</p><a className="text-link light-link" href="#app">See the platform in action <ArrowUpRight size={15} /></a></div></div>
            <div className="capability-grid">{capabilities.map((capability) => { const Icon = capability.icon; return <article key={capability.number} className="capability-card"><div className="capability-top"><span className="capability-number">{capability.number}</span><Icon size={20} /></div><h3>{capability.title}</h3><p>{capability.description}</p><span className="capability-arrow"><ArrowUpRight size={18} /></span></article>; })}</div>
          </div>
        </section>

        <section className="workflow-section section-white" id="teams">
          <div className="container workflow-layout"><div className="workflow-copy"><div className="eyebrow dark-eyebrow"><span className="eyebrow-line" /> BUILT FOR MOMENTUM</div><h2>Know what’s happening. <em>Know what happens next.</em></h2><p>From first contact to closing, every property carries its own operating story—so every role can act on the same context.</p><div className="workflow-list"><div><span className="workflow-number">01</span><span><strong>See the full picture</strong><small>Owners, documents, offers, blockers, and tasks in one workspace.</small></span></div><div><span className="workflow-number">02</span><span><strong>Make the next move</strong><small>Surface the action that unlocks progress for each acquisition.</small></span></div><div><span className="workflow-number">03</span><span><strong>Keep the evidence</strong><small>Build an auditable timeline as the work moves forward.</small></span></div></div><button className="button button-dark" onClick={() => { window.location.hash = "app"; window.location.reload(); }}>Talk to our team <ArrowUpRight size={16} /></button></div><div className="workflow-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-core"><GitBranch size={23} /><span>PROPERTY</span><small>source of truth</small></div><div className="art-node node-one"><Map size={15} /><span>Owners</span></div><div className="art-node node-two"><FileCheck2 size={15} /><span>Documents</span></div><div className="art-node node-three"><MessageSquareText size={15} /><span>Negotiation</span></div><div className="art-node node-four"><Layers3 size={15} /><span>Timeline</span></div><div className="art-caption">Connected context<br /><b>across every stage</b></div></div></div>
        </section>

        <section className="cta-section" id="contact">
          <div className="cta-shape shape-one" /><div className="cta-shape shape-two" />
          <div className="container cta-layout"><div className="cta-copy"><div className="eyebrow light-eyebrow"><span className="eyebrow-line" /> START WITH CLARITY</div><h2>Make your next acquisition <em>easier to see.</em></h2><p>Tell us a little about your operation. We’ll show you how BizcaiaOS can turn your acquisition workflow into a clear path to close.</p><div className="cta-note"><Check size={15} /> No generic sales pitch. A working session around your operation.</div></div><div className="form-card">{submitted ? <div className="success-state"><div className="success-mark"><Check size={27} /></div><span className="mini-label">REQUEST RECEIVED</span><h3>You’re on the list.</h3><p>Thanks for reaching out. Our team will be in touch shortly to schedule your product walkthrough.</p><button className="text-link dark-link" onClick={() => setSubmitted(false)}>Submit another request <ArrowRight size={15} /></button></div> : <form onSubmit={(event) => { event.preventDefault(); setSubmitted(true); }}><div className="form-heading"><span className="mini-label">BOOK A WALKTHROUGH</span><h3>Let’s talk land.</h3></div><label>Work email<input required type="email" placeholder="you@company.com" /></label><div className="form-row"><label>First name<input required type="text" placeholder="Alex" /></label><label>Company<input required type="text" placeholder="Company name" /></label></div><label>How many properties do you manage?<select defaultValue=""><option value="" disabled>Select a range</option><option>1–50 properties</option><option>51–250 properties</option><option>251–1,000 properties</option><option>1,000+ properties</option></select></label><button className="button button-red form-submit" type="submit">Request my walkthrough <ArrowUpRight size={16} /></button><span className="form-fineprint">By submitting, you agree to receive occasional product updates from BizcaiaOS.</span></form>}</div></div>
        </section>
      </main>

      <footer className="site-footer"><div className="container footer-inner"><a className="brand footer-brand" href="#top"><LogoMark /><span>bizcaia<span>os</span></span></a><p>Land acquisition, made visible.</p><div className="footer-links"><a href="#platform">Platform</a><a href="#workflow">How it works</a><a href="#app">Contact</a></div><span className="copyright">© 2026 BizcaiaOS</span></div></footer>
    </div>
  );
}

export default Home;
