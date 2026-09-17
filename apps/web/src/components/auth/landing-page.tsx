import type { ReactNode } from "react"
import { ArrowDown, ArrowRight, Blocks, BookOpen, Braces, Check, CheckCheck, Cloud, Database, FileJson, Hammer, Layers, LayoutGrid, MessageSquare, Monitor, Network, PackageCheck, Server, Terminal } from "lucide-react"

import { ProductLoopPreview, WorkbenchPreview } from "@/components/auth/workbench-preview"
import { ThemeToggle } from "@/components/shell/theme-toggle"
import { Button } from "@/components/ui/button"
import "@/styles/landing.css"

const anatomy = [
  { icon: FileJson, name: "Manifest", path: "manifest.json", text: "Entities, fields, constraints, and tool definitions. The blueprint for your app." },
  { icon: Database, name: "Data", path: "data/*.json → SQLite", text: "Initial records become structured, persistent data in the app’s own database." },
  { icon: Terminal, name: "Tools", path: "manifest.json → tools", text: "Operations such as log_exercise_result give the agent a way to act." },
  { icon: BookOpen, name: "Skills", path: "skills/*/SKILL.md", text: "Instructions teach the agent how to work with this particular application." },
  { icon: Monitor, name: "UI", path: "ui/components/*.tsx → ui/*.html", text: "Optional React components turn tool results into interfaces inside chat." },
]

// Exact field and step excerpts from catalog/hyrox/manifest.json, not a standalone manifest.
const fieldExcerpt = `{
  "id": "fld_result_duration_seconds",
  "name": "duration_seconds",
  "type": "integer",
  "required": true,
  "min": 0
}`
const stepExcerpt = `{
  "id": "exercise",
  "op": "update",
  "entity": "ent_exercise",
  "rowId": "$params.exercise_id",
  "set": {
    "status": "completed"
  }
}`

function LandingPage({ onEnter, accessForm }: { onEnter: () => void; accessForm: ReactNode }) {
  return (
    <div className="landing grain" id="top">
      <a className="landing-skip" href="#main-content">Skip to content</a>
      <header className="landing-header landing-container">
        <a href="#top" className="landing-brand" aria-label="Open Workbench home"><span aria-hidden="true">🧰</span>Open Workbench</a>
        <nav aria-label="Main navigation" className="landing-nav">
          <a href="#how-it-works">How it works</a><a href="#showcase">Showcase</a><a href="#platform">Platform</a><a href="#vision">Vision</a>
        </nav>
        <div className="header-actions"><ThemeToggle /><Button variant="outline" size="sm" onClick={onEnter}>Enter workbench <ArrowRight aria-hidden="true" /></Button></div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <section className="landing-hero landing-container" aria-labelledby="landing-title">
          <div className="hero-copy">
            <p className="eyebrow"><span className="accent-dot" /> The open application layer for agents.</p>
            <h1 id="landing-title">Build apps your AI<br className="hero-break" /> can <em>actually use.</em></h1>
            <p className="hero-description">Describe what you need. Let an agent build your app, install it into your workbench, and use it to get things done.</p>
            <p className="hero-persistence">Real data. Real tools. Useful beyond a single conversation.</p>
            <div className="hero-actions"><Button size="lg" onClick={onEnter}>Explore the showcase <ArrowRight aria-hidden="true" /></Button><a href="#how-it-works">How it works <ArrowDown aria-hidden="true" /></a></div>
            <p className="private-label"><span /> Early private showcase · Password required</p>
          </div>
          <ProductLoopPreview />
          <div className="hero-sequence" aria-label="Describe it. Build it. Install it. Use it.">
            {["Describe it.", "Build it.", "Install it.", "Use it."].map((text, i) => <div key={text}><span>0{i + 1}</span>{text}{i < 3 && <ArrowRight aria-hidden="true" />}</div>)}
          </div>
        </section>

        <section id="how-it-works" className="landing-section loop-section" aria-labelledby="loop-title">
          <div className="landing-container">
            <div className="section-heading"><div><p className="eyebrow">01 / The product loop</p><h2 id="loop-title">From an idea to a working app.<br />In one workbench.</h2></div><p>A building agent creates it.<br />You review and install it.<br />Your regular agent puts it to work.</p></div>
            <div className="loop-grid">
              <article><span className="stage-number">01</span><MessageSquare aria-hidden="true" /><h3>Describe.</h3><p>Tell the building agent what you need. A workout tracker, a tournament planner, or something entirely your own.</p><div className="stage-visual quote-visual">“I need a place for our players, matches, and scores.”</div></article>
              <article><span className="stage-number">02</span><Hammer aria-hidden="true" /><h3>Build.</h3><p>The agent creates the data model, operations, instructions, and optional UI, then validates the app and compiles its interface.</p><div className="stage-visual files-visual"><span><FileJson aria-hidden="true" /> manifest.json</span><span>data/ · skills/ · ui/</span><span className="validation-note"><CheckCheck aria-hidden="true" /> Validate app + UI</span></div></article>
              <article><span className="stage-number">03</span><PackageCheck aria-hidden="true" /><h3>Install.</h3><p>Review the result and click Install app. The bundle joins your catalog, and the agent’s available capabilities refresh.</p><div className="stage-visual"><div className="review-app"><span aria-hidden="true">🎾</span><span>Padel Tournament<small>Entities · Tools · UI</small></span></div><span className="review-action"><Check aria-hidden="true" /> Review → Install app</span></div></article>
              <article><span className="stage-number">04</span><LayoutGrid aria-hidden="true" /><h3>Use.</h3><p>Ask your regular agent to read data, execute operations, and show interactive results. Your application data stays saved.</p><div className="stage-visual"><span className="use-prompt">“Record the match: 2–1.”</span><span className="saved-result"><Database aria-hidden="true" /> Result saved in your app</span></div></article>
            </div>
            <p className="section-note">Workflow illustrations. Build and install your own app inside the private showcase.</p>
          </div>
        </section>

        <section id="showcase" className="landing-section landing-container" aria-labelledby="showcase-title">
          <div className="section-heading"><div><p className="eyebrow">02 / Applications, in action</p><h2 id="showcase-title">One workbench.<br />Whatever you’re building.</h2></div><p>Different workflows. The same foundation.<br />Explore how a request becomes an operation, a saved record, and a useful result.</p></div>
          <WorkbenchPreview />
        </section>

        <section className="landing-section anatomy-section" aria-labelledby="anatomy-title">
          <div className="landing-container">
            <div className="section-heading"><div><p className="eyebrow">03 / The anatomy of an app</p><h2 id="anatomy-title">More than a conversation.<br />An application that stays.</h2></div><p>One coordinated bundle gives an app its structure, data, capabilities, and interface. The conversation can end. Your installed app and its data remain.</p></div>
            <div className="anatomy-diagram">
              <div className="anatomy-root"><div><span className="app-symbol app-symbol-hyrox" aria-hidden="true">🏋️</span><div><strong>HYROX</strong><span>One installed application</span></div></div><span className="status-chip"><PackageCheck aria-hidden="true" /> App bundle</span></div>
              <div className="anatomy-parts">{anatomy.map(({ icon: Icon, name, path, text }) => <article key={name}><Icon aria-hidden="true" /><h3>{name}</h3><p>{text}</p><code>{path}</code></article>)}</div>
              <p className="anatomy-caption"><Database aria-hidden="true" /> Application state lives in SQLite, independently of the agent’s in-memory conversation.</p>
            </div>
          </div>
        </section>

        <section id="platform" className="landing-section landing-container platform-section" aria-labelledby="platform-title">
          <div className="platform-copy"><p className="eyebrow">04 / The engine underneath</p><h2 id="platform-title">Define the app.<br />We handle the backend.</h2><p>Applications are defined in JSON. A shared engine interprets those definitions to provide persistent storage, APIs, and agent-accessible tools, without a custom backend for every app.</p>
            <div className="platform-benefits">
              <div><Blocks aria-hidden="true" /><div><h3>Less boilerplate</h3><p>Backend infrastructure is shared across apps.</p></div></div>
              <div><Database aria-hidden="true" /><div><h3>Persistent state</h3><p>Each app maintains its own structured data.</p></div></div>
              <div><Terminal aria-hidden="true" /><div><h3>Capabilities an agent can use</h3><p>Agents discover and invoke application operations as tools.</p></div></div>
            </div>
          </div>
          <figure className="architecture">
            <figcaption className="diagram-label">One shared runtime for your applications</figcaption>
            <div className="architecture-node"><Monitor aria-hidden="true" /><div><strong>React workbench</strong><span>Chat · Builder · Apps · Data</span></div><span className="node-tag">Browser</span></div>
            <div className="architecture-arrow"><ArrowDown aria-hidden="true" /><span>Requests & streamed results</span></div>
            <div className="architecture-node"><Network aria-hidden="true" /><div><strong>Node agent runtime</strong><span>Pi agents · MCP tool proxy</span></div></div>
            <p className="model-provider">Model provider: OpenRouter ↔ runtime</p>
            <div className="engine-inputs"><div className="architecture-arrow"><ArrowDown aria-hidden="true" /><span>HTTP / MCP</span></div><div className="catalog-input"><FileJson aria-hidden="true" /><span>Catalog / app definitions</span><ArrowDown aria-hidden="true" /><small>loaded by the engine</small></div></div>
            <div className="architecture-engine"><div><Server aria-hidden="true" /><strong>Go application engine</strong></div><span>Validates · Materializes · Executes</span><div className="engine-capabilities"><span>SQLite storage</span><span>HTTP API</span><span>MCP tools</span><span>UI resources</span></div></div>
            <div className="ui-return"><Monitor aria-hidden="true" /><p>Engine-supplied UI resources travel through the runtime and render in sandboxed browser iframes.</p></div>
          </figure>
        </section>

        <section className="landing-section agents-section" aria-labelledby="agents-title">
          <div className="landing-container agents-grid"><div><p className="eyebrow">05 / Separate the app from the agent</p><h2 id="agents-title">Applications should outlive<br />the agent that created them.</h2><p>Your application shouldn’t be trapped inside one chat. Its data and capabilities are defined separately from the agent, creating a foundation for reuse across agent ecosystems.</p></div>
            <div className="agent-layer-diagram"><div className="agent-connections"><div><span className="diagram-label">Available today</span><strong>Built-in Pi agents</strong><span>MCP integration</span></div><div className="future-connection"><span className="diagram-label">Future direction</span><strong>Other agent clients</strong><span>Broader interoperability</span></div></div><div className="agent-layer"><Layers aria-hidden="true" /><div><strong>Open Workbench application layer</strong><span>Your apps · Your data · Your capabilities</span></div></div><p>Built-in runtime today. Broader client compatibility is a goal, with integrations still to be developed and verified.</p></div>
          </div>
        </section>

        <section className="landing-section landing-container developer-section" aria-labelledby="developer-title">
          <div className="section-heading"><div><p className="eyebrow">06 / Developer foundations</p><h2 id="developer-title">For the builders who<br />want to look underneath.</h2></div><p>A small definition becomes a usable capability. Schema validation, transactional tools, and schema migration support are part of the engine.</p></div>
          <div className="manifest-transform"><div className="manifest-code"><div><FileJson aria-hidden="true" /><span>HYROX / manifest.json</span><span>Field excerpt</span></div><pre tabIndex={0} aria-label="Actual duration field definition"><code>{fieldExcerpt}</code></pre></div><div className="transform-arrow" aria-hidden="true"><ArrowRight /></div><div className="manifest-capability"><p className="diagram-label">Interpreted by the shared Go engine</p><h3>A field with working rules.</h3><ul><li><Check aria-hidden="true" /> An integer column in the app’s SQLite database</li><li><Check aria-hidden="true" /> Required, non-negative values validated on writes</li><li><Check aria-hidden="true" /> Records accessible through HTTP and MCP tools</li></ul><p>Skills explain how to use the app. Optional React UI resources present the results.</p></div></div>
          <details className="technical-details"><summary><span><Braces aria-hidden="true" /> See how a tool changes application state</span><span className="details-plus" aria-hidden="true">+</span></summary><div className="technical-content"><div><h3>One tool. Two steps. One transaction.</h3><p>HYROX’s <code>log_exercise_result</code> first creates a result, then runs this update step. The engine resolves the exercise ID from the tool arguments and commits both changes together.</p><p>The tool associates its output with <code>ResultLogged</code>. The component is compiled into an HTML bundle, served as an MCP UI resource, and rendered inside the browser with a message bridge for supported interactions.</p></div><div><p className="diagram-label">Actual update step · manifest excerpt</p><pre tabIndex={0} aria-label="Actual exercise update step"><code>{stepExcerpt}</code></pre></div></div></details>
        </section>

        <section id="vision" className="landing-section vision-section" aria-labelledby="vision-title"><div className="landing-container"><div className="section-heading"><div><p className="eyebrow">07 / The direction we’re building toward</p><h2 id="vision-title">An open foundation.<br /><em>A hosted future.</em></h2></div><p>The private showcase is the starting point. Here’s the larger direction behind it.</p></div><div className="vision-grid">
          <article><Blocks aria-hidden="true" /><span className="roadmap-label">Foundation in place</span><h3>An open application foundation</h3><p>Declarative bundles and a shared runtime, with the goal of making applications easier to self-host and reuse.</p></article>
          <article><Network aria-hidden="true" /><span className="roadmap-label">Future direction</span><h3>A broader agent ecosystem</h3><p>Carry application capabilities across agents and harnesses, with each integration developed and verified.</p></article>
          <article><Cloud aria-hidden="true" /><span className="roadmap-label">Future service</span><h3>Managed hosting</h3><p>A managed home for your applications, keeping them running without managing infrastructure. Planned; not available today.</p></article>
        </div></div></section>

        <section id="access" className="landing-section landing-container closing-section" aria-labelledby="closing-title"><div><p className="eyebrow">Start with an idea</p><h2 id="closing-title">Your ideas deserve more<br />than a chat history.</h2><p>Build applications with an agent. Give them persistent data and real capabilities. Bring them together in one workbench.</p></div>{accessForm}</section>
      </main>
      <footer className="landing-footer landing-container"><a href="#top" className="landing-brand"><span aria-hidden="true">🧰</span> Open Workbench</a><p>The open application layer for agents.</p><span>Early private showcase</span></footer>
    </div>
  )
}

export { LandingPage }
