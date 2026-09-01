import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { build as viteBuild } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// packages/app-ui-kit -- two levels up from this file (build/build-app-ui.ts).
const kitRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const shellPath = path.join(kitRoot, "src", "shell.tsx")
const themeCssPath = path.join(kitRoot, "src", "theme.css")
const kitSrcDir = path.join(kitRoot, "src")
// packages/app-ui-kit -> packages -> repo root -- the hoisted node_modules
// every workspace package (including tailwindcss itself) resolves through.
const repoNodeModules = path.join(kitRoot, "..", "..", "node_modules")

export interface BuildAppUIOptions {
  /** App workspace directory containing ui/components/*.tsx. */
  appDir: string
  /** Seeds --app-accent from the app's own manifest.app.color, if set. */
  accentColor?: string
}

export interface BuildAppUIComponent {
  /** Matches manifest.json's tool.ui.component and the served ui/<name>.html filename. */
  component: string
  html: string
}

/**
 * Compiles every ui/components/*.tsx in appDir into a self-contained MCP
 * Apps HTML/JS bundle (shell + design kit + component, inlined) — one Vite
 * build per component (vite-plugin-singlefile forces
 * `output.inlineDynamicImports`, which Rollup rejects for a multi-entry
 * build, so components can't share a single build the way multiple pages of
 * an ordinary app could). Returns each bundle's HTML text directly; the
 * caller decides whether/where to persist it (e.g. apps/runtime/build-tools.ts
 * reads these straight into the `PUT /admin/apps/{id}` body's `ui` field).
 * Returns an empty array if the app declares no ui/components directory at
 * all.
 */
export async function buildAppUI(options: BuildAppUIOptions): Promise<BuildAppUIComponent[]> {
  const componentsDir = path.join(options.appDir, "ui", "components")
  let files: string[]
  try {
    files = readdirSync(componentsDir).filter((f) => f.endsWith(".tsx"))
  } catch {
    return []
  }
  if (files.length === 0) return []

  const components = files.map((f) => path.basename(f, ".tsx"))
  // realpath immediately: on macOS, os.tmpdir() returns a /var/folders path
  // that's itself a symlink to /private/var/folders -- if root and outDir
  // below end up expressed through different aliases of the same directory,
  // Rollup computes an absurd ../../.. relative path between them and fails.
  const entriesDir = realpathSync(mkdtempSync(path.join(tmpdir(), "app-ui-kit-entries-")))
  try {
    // @tailwindcss/vite resolves the `tailwindcss` package itself relative
    // to the CSS file importing it -- entriesDir has no node_modules
    // ancestor of its own (it's a fresh OS tmp dir), so without this it
    // fails to resolve "tailwindcss" from entry.css.
    symlinkSync(repoNodeModules, path.join(entriesDir, "node_modules"))

    // Tailwind v4's automatic source detection walks the filesystem from
    // wherever the importing CSS file lives -- it has no idea this build's
    // real component/design-kit source lives at two unrelated absolute
    // paths outside entriesDir entirely. `source(none)` turns that
    // heuristic off; the two @source lines register exactly the two
    // directories that actually matter for this build.
    const entryCssPath = path.join(entriesDir, "entry.css")
    writeFileSync(
      entryCssPath,
      [
        `@import "tailwindcss" source(none);`,
        `@source ${toCssPath(kitSrcDir)};`,
        `@source ${toCssPath(componentsDir)};`,
        `@import ${toCssPath(themeCssPath)};`,
        "",
      ].join("\n"),
      "utf-8",
    )

    const outDir = path.join(entriesDir, "dist")
    const results: BuildAppUIComponent[] = []
    for (const component of components) {
      const componentPath = path.join(componentsDir, `${component}.tsx`)
      writeFileSync(
        path.join(entriesDir, `${component}.tsx`),
        [
          `import "./entry.css"`,
          `import { mountAppComponent } from ${importSpecifier(shellPath)}`,
          `import Component from ${importSpecifier(componentPath)}`,
          `mountAppComponent(Component, { name: ${JSON.stringify(component)} })`,
          "",
        ].join("\n"),
        "utf-8",
      )
      const htmlPath = path.join(entriesDir, `${component}.html`)
      writeFileSync(htmlPath, entryHTML(component, options.accentColor), "utf-8")

      await viteBuild({
        configFile: false,
        root: entriesDir,
        logLevel: "silent",
        plugins: [react(), tailwindcss(), viteSingleFile()],
        build: {
          outDir,
          emptyOutDir: true,
          rollupOptions: { input: htmlPath },
        },
      })
      results.push({ component, html: readFileSync(path.join(outDir, `${component}.html`), "utf-8") })
    }

    return results
  } finally {
    rmSync(entriesDir, { recursive: true, force: true })
  }
}

function entryHTML(component: string, accentColor: string | undefined): string {
  const accentStyle = accentColor ? `<style>:root{--app-accent:${escapeCssValue(accentColor)}}</style>` : ""
  return `<!doctype html><html><head><meta charset="utf-8" />${accentStyle}</head><body><div id="root"></div><script type="module" src="./${component}.tsx"></script></body></html>`
}

/** An absolute path, as a JS import specifier -- forward slashes, quoted/escaped. */
function importSpecifier(absPath: string): string {
  return JSON.stringify(absPath.split(path.sep).join("/"))
}

/** An absolute path, as a quoted CSS @import/@source url -- same escaping as importSpecifier. */
function toCssPath(absPath: string): string {
  return JSON.stringify(absPath.split(path.sep).join("/"))
}

/** Manifest colors are already validated (a CSS color literal); this is a defence-in-depth
 * clamp against anything that could break out of the inline <style> tag. */
function escapeCssValue(value: string): string {
  return value.replace(/[^#a-zA-Z0-9(),.%\s-]/g, "")
}
