import { useState } from "react"
import { ArrowDown, ArrowRight, Check, CheckCheck, Database, FileJson, Hammer, LayoutGrid, MessageSquare, Terminal } from "lucide-react"

const examples = [
  {
    name: "Inventory tracker", emoji: "📦", category: "Stock levels, always current.",
    purpose: "Track items, quantities, and restocks across a catalog.",
    prompt: "We restocked 20 units of blue mugs this morning.",
    tool: "adjust_stock_level",
    action: "Creates a stock movement record and updates the item's on-hand quantity. Both steps run in one database transaction: either both succeed, or neither changes your data.",
    component: "StockUpdated", result: "Blue Mugs", kind: "inventory",
  },
  {
    name: "Project tracker", emoji: "✅", category: "Work, with less overhead.",
    purpose: "Assign tasks, track owners and due dates, and record progress.",
    prompt: "Mark the design review task as done. Assign the follow-up to Priya.",
    tool: "complete_task",
    action: "Updates the task status to done, records the completion time, and creates the follow-up task with its assignee.",
    component: "Task", result: "Design Review", kind: "project",
  },
  {
    name: "Expense tracker", emoji: "💰", category: "Spending, kept organized.",
    purpose: "Log expenses, tag categories, and keep them against a budget.",
    prompt: "I spent $42 on office supplies this morning. Tag it as operations.",
    tool: "log_expense",
    action: "Creates an expense record tagged to a category, linked to the budget it counts against. The agent can retrieve these later to summarize spend by category.",
    component: null, result: "Expense log", kind: "expense",
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
              {example.kind === "inventory" && <>
                <div className="result-stats"><div><strong>+20</strong><span>Units</span></div><span className="status-chip"><Check aria-hidden="true" /> in stock</span></div>
                <p className="result-note">On-hand quantity updated.</p>
              </>}
              {example.kind === "project" && <>
                <p className="result-note">Task completed</p>
                <div className="result-stats"><div><strong>Priya</strong><span>Follow-up owner</span></div></div>
                <span className="status-chip"><Check aria-hidden="true" /> Status: Done</span>
              </>}
              {example.kind === "expense" && <>
                <dl className="diary-record"><div><dt>Amount</dt><dd>$42.00</dd></div><div><dt>Category</dt><dd>Operations</dd></div><div><dt>Linked to</dt><dd>Monthly budget</dd></div></dl>
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
          <div className="mini-prompt">Build an app for our project tracker. We need tasks, owners, and due dates.</div>
          <div className="bundle-preview">
            <p><FileJson aria-hidden="true" /> project_tracker/</p>
            <code>manifest.json</code><code>data/task.json</code><code>skills/manage-tasks/SKILL.md</code><code>ui/components/Task.tsx</code>
          </div>
          <div className="review-preview"><span><CheckCheck aria-hidden="true" /> Ready to review</span><span className="install-preview">Install app <ArrowDown aria-hidden="true" /></span></div>
        </div>
        <div className="use-preview">
          <p className="diagram-label"><MessageSquare aria-hidden="true" /> Your regular agent <span>04</span></p>
          <div className="installed-app"><span className="app-symbol app-symbol-project" aria-hidden="true">✅</span><div><strong>Project Tracker</strong><span><Check aria-hidden="true" /> Installed in your workbench</span></div></div>
          <div className="mini-prompt">Mark the design review task as done.</div>
          <div className="mini-tool"><Terminal aria-hidden="true" /><code>complete_task</code></div>
          <div className="mini-result"><span>Design Review</span><strong>Done</strong><span><Check aria-hidden="true" /> Task completed</span></div>
        </div>
      </div>
      <figcaption><LayoutGrid aria-hidden="true" /> One app, from the first idea to the next match.</figcaption>
    </figure>
  )
}

export { WorkbenchPreview, ProductLoopPreview }
