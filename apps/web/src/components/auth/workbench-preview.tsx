import { useState } from "react"
import { ArrowDown, ArrowRight, Check, CheckCheck, Database, FileJson, Hammer, LayoutGrid, MessageSquare, Terminal } from "lucide-react"

const examples = [
  {
    name: "HYROX training", emoji: "🏋️", category: "Training, with a record.",
    purpose: "Plan workouts, track exercises, and keep the results together.",
    prompt: "Log my sled push: 4 minutes 32 seconds. Felt strong today.",
    tool: "log_exercise_result",
    action: "Creates a result and marks the exercise completed. Both steps run in one database transaction: either both succeed, or neither changes your data.",
    component: "ResultLogged", result: "Sled Push", kind: "hyrox",
  },
  {
    name: "Padel tournament", emoji: "🎾", category: "More playing. Less organizing.",
    purpose: "Pair players, schedule matches, and record the results of a tournament.",
    prompt: "Team A won our round-robin match, two sets to one. Record it.",
    tool: "record_match_result",
    action: "Updates the match with the sets won, the winning team, and its played status. The match result component displays the saved score.",
    component: "Match", result: "Round Robin", kind: "padel",
  },
  {
    name: "Child development", emoji: "🌱", category: "Small moments. A lasting record.",
    purpose: "Keep a development checklist, observations, and a diary in one application.",
    prompt: "Add a diary note for today: a calm afternoon, full of smiles.",
    tool: "notiz_hinzufuegen",
    action: "Creates a diary entry linked to the child, with a date, mood, and note. The agent can retrieve these records later with tagebuch_anzeigen.",
    component: null, result: "Development diary", kind: "child",
  },
] as const

/** Illustrative data only. No tool calls or app installation happen on the landing page. */
function WorkbenchPreview() {
  const [selected, setSelected] = useState(0)
  const example = examples[selected]

  return (
    <div className="showcase-shell">
      <div className="showcase-picker" role="group" aria-label="Explore example apps">
        {examples.map((item, index) => (
          <button key={item.kind} type="button" aria-pressed={selected === index} aria-controls="showcase-result" onClick={() => setSelected(index)}>
            <span className={`app-symbol app-symbol-${item.kind}`} aria-hidden="true">{item.emoji}</span>
            <span>{item.name}</span><ArrowRight aria-hidden="true" />
          </button>
        ))}
        <p>Three examples.<br />One application engine.</p>
      </div>
      <div id="showcase-result" className="showcase-content" aria-live="polite" aria-atomic="true">
        <div className="showcase-description">
          <div><h3>{example.category}</h3><p>{example.purpose}</p></div>
          <span className="preview-label">Illustrative preview</span>
        </div>
        <div className="showcase-columns">
          <div className="showcase-conversation">
            <p className="diagram-label">You ask</p>
            <blockquote>{example.prompt}</blockquote>
            <div className="tool-connection" aria-hidden="true"><ArrowDown /></div>
            <p className="diagram-label">The agent calls an app tool</p>
            <code className="tool-name"><Terminal aria-hidden="true" />{example.tool}</code>
            <p className="tool-explanation">{example.action}</p>
          </div>
          <div className="showcase-output">
            <p className="diagram-label">{example.component ? "App interface in the conversation" : "Saved application data"}</p>
            <div className={`result-preview result-${example.kind}`}>
              <div className="result-heading"><span aria-hidden="true">{example.emoji}</span><span>{example.result}</span></div>
              {example.kind === "hyrox" && <>
                <div className="result-stats"><div><strong>4:32</strong><span>Time</span></div><span className="status-chip"><Check aria-hidden="true" /> completed</span></div>
                <p className="result-note">Felt strong today.</p>
              </>}
              {example.kind === "padel" && <>
                <p className="result-note">Result recorded</p>
                <div className="result-stats"><div><strong>2</strong><span>Team A sets</span></div><span className="score-divider">:</span><div><strong>1</strong><span>Team B sets</span></div></div>
                <span className="status-chip"><Check aria-hidden="true" /> Winner: Team A</span>
              </>}
              {example.kind === "child" && <>
                <dl className="diary-record"><div><dt>Mood</dt><dd>ruhig <span>(calm)</span></dd></div><div><dt>Note</dt><dd>A calm afternoon, full of smiles.</dd></div><div><dt>Linked to</dt><dd>Child record</dd></div></dl>
              </>}
              <div className="result-storage"><Database aria-hidden="true" /> App-specific SQLite storage</div>
            </div>
            <p className="preview-footnote">{example.component ? <>Based on the app’s <code>{example.component}</code> component. Example data.</> : "Example record; field labels translated for this preview."}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProductLoopPreview() {
  return (
    <figure className="product-preview">
      <div className="preview-topbar"><span><span aria-hidden="true">🧰</span> Open Workbench</span><span className="preview-label">Workflow preview</span></div>
      <div className="build-use-grid">
        <div className="build-preview">
          <p className="diagram-label"><Hammer aria-hidden="true" /> Building agent <span>01—03</span></p>
          <div className="mini-prompt">Build an app for our padel tournament. We need teams, matches, and scores.</div>
          <div className="bundle-preview">
            <p><FileJson aria-hidden="true" /> padel_tournament/</p>
            <code>manifest.json</code><code>data/player.json</code><code>skills/run-tournament/SKILL.md</code><code>ui/components/Match.tsx</code>
          </div>
          <div className="review-preview"><span><CheckCheck aria-hidden="true" /> Ready to review</span><span className="install-preview">Install app <ArrowDown aria-hidden="true" /></span></div>
        </div>
        <div className="use-preview">
          <p className="diagram-label"><MessageSquare aria-hidden="true" /> Your regular agent <span>04</span></p>
          <div className="installed-app"><span className="app-symbol app-symbol-padel" aria-hidden="true">🎾</span><div><strong>Padel Tournament</strong><span><Check aria-hidden="true" /> Installed in your workbench</span></div></div>
          <div className="mini-prompt">Record our match. Team A won 2–1.</div>
          <div className="mini-tool"><Terminal aria-hidden="true" /><code>record_match_result</code></div>
          <div className="mini-result"><span>Round Robin</span><strong>2 <span>:</span> 1</strong><span><Check aria-hidden="true" /> Result recorded</span></div>
        </div>
      </div>
      <figcaption><LayoutGrid aria-hidden="true" /> One app, from the first idea to the next match.</figcaption>
    </figure>
  )
}

export { WorkbenchPreview, ProductLoopPreview }
