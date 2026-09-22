import type { ReactNode } from "react"
import { ArrowDown, ArrowRight, Blocks, Check, CheckCheck, Cloud, Database, FileJson, Hammer, Layers, LayoutGrid, MessageSquare, Network, PackageCheck, Terminal } from "lucide-react"

import { ProductLoopPreview, WorkbenchPreview } from "@/components/auth/workbench-preview"
import { ThemeToggle } from "@/components/shell/theme-toggle"
import { Button } from "@/components/ui/button"
import "@/styles/landing.css"

const benefits = [
  { icon: Database, name: "Real data", text: "Everything your app tracks is saved for good, not lost when the conversation ends." },
  { icon: Terminal, name: "Real capabilities", text: "Your agent doesn’t just talk about it. It can create, update, and look things up." },
  { icon: Blocks, name: "No backend to build", text: "Describe the app you want. The platform handles storage and access underneath." },
]

function LandingPage({ onEnter, accessForm }: { onEnter: () => void; accessForm: ReactNode }) {
  return (
    <div className="landing grain" id="top">
      <a className="landing-skip" href="#main-content">Skip to content</a>
      <header className="landing-header landing-container">
        <a href="#top" className="landing-brand" aria-label="Open Workbench home"><span aria-hidden="true">🧰</span>Open Workbench</a>
        <nav aria-label="Main navigation" className="landing-nav">
          <a href="#how-it-works">How it works</a><a href="#showcase">Showcase</a><a href="#why-it-lasts">Why it lasts</a><a href="#vision">Vision</a>
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
              <article><span className="stage-number">01</span><MessageSquare aria-hidden="true" /><h3>Describe.</h3><p>Tell the building agent what you need. An inventory tracker, a project tracker, or something entirely your own.</p><div className="stage-visual quote-visual">“I need a place to track our stock, restocks, and current levels.”</div></article>
              <article><span className="stage-number">02</span><Hammer aria-hidden="true" /><h3>Build.</h3><p>The agent creates the data model, operations, instructions, and optional UI, then validates the app and compiles its interface.</p><div className="stage-visual files-visual"><span><FileJson aria-hidden="true" /> manifest.json</span><span>data/ · skills/ · ui/</span><span className="validation-note"><CheckCheck aria-hidden="true" /> Validate app + UI</span></div></article>
              <article><span className="stage-number">03</span><PackageCheck aria-hidden="true" /><h3>Install.</h3><p>Review the result and click Install app. The bundle joins your catalog, and the agent’s available capabilities refresh.</p><div className="stage-visual"><div className="review-app"><span aria-hidden="true">📦</span><span>Inventory Tracker<small>Entities · Tools · UI</small></span></div><span className="review-action"><Check aria-hidden="true" /> Review → Install app</span></div></article>
              <article><span className="stage-number">04</span><LayoutGrid aria-hidden="true" /><h3>Use.</h3><p>Ask your regular agent to read data, execute operations, and show interactive results. Your application data stays saved.</p><div className="stage-visual"><span className="use-prompt">“We restocked 20 units of blue mugs.”</span><span className="saved-result"><Database aria-hidden="true" /> Result saved in your app</span></div></article>
            </div>
            <p className="section-note">Workflow illustrations. Build and install your own app inside the private showcase.</p>
          </div>
        </section>

        <section id="showcase" className="landing-section landing-container" aria-labelledby="showcase-title">
          <div className="section-heading"><div><p className="eyebrow">02 / Applications, in action</p><h2 id="showcase-title">One workbench.<br />Whatever you’re building.</h2></div><p>Different workflows. The same foundation.<br />Explore how a request becomes an operation, a saved record, and a useful result.</p></div>
          <WorkbenchPreview />
        </section>

        <section id="why-it-lasts" className="landing-section landing-container anatomy-section" aria-labelledby="anatomy-title">
          <div className="section-heading"><div><p className="eyebrow">03 / Why it lasts</p><h2 id="anatomy-title">More than a conversation.<br />An app that stays.</h2></div><p>Every app you build keeps its own data and its own capabilities. The conversation can end. Your app, and what it remembers, don’t.</p></div>
          <div className="anatomy-parts">{benefits.map(({ icon: Icon, name, text }) => <article key={name}><Icon aria-hidden="true" /><h3>{name}</h3><p>{text}</p></article>)}</div>
        </section>

        <section className="landing-section agents-section" aria-labelledby="agents-title">
          <div className="landing-container agents-grid"><div><p className="eyebrow">04 / Works with your agents</p><h2 id="agents-title">Your apps aren’t locked<br />to one conversation.</h2><p>Build an app once, and any agent in your workbench can use it: read its data, take actions, and show results. Support for more agents beyond today’s built-in ones is on the roadmap.</p></div>
            <div className="agent-layer-diagram"><div className="agent-connections"><div><span className="diagram-label">Available today</span><strong>Built-in agents</strong></div><div className="future-connection"><span className="diagram-label">Future direction</span><strong>Other agent tools</strong></div></div><div className="agent-layer"><Layers aria-hidden="true" /><div><strong>Open Workbench application layer</strong><span>Your apps · Your data · Your capabilities</span></div></div></div>
          </div>
        </section>

        <section id="vision" className="landing-section vision-section" aria-labelledby="vision-title"><div className="landing-container"><div className="section-heading"><div><p className="eyebrow">05 / The direction we’re building toward</p><h2 id="vision-title">An open foundation.<br /><em>A hosted future.</em></h2></div><p>The private showcase is the starting point. Here’s the larger direction behind it.</p></div><div className="vision-grid">
          <article><Blocks aria-hidden="true" /><span className="roadmap-label">Foundation in place</span><h3>An open application foundation</h3><p>A shared platform underneath every app, with the goal of making apps easy to self-host and reuse.</p></article>
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
