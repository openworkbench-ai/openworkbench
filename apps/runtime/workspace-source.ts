import ts from "typescript";
import { posix } from "node:path";
import type { SourceFiles } from "./workspace-store.js";

const supportedModules = new Set([
  "react",
  "react/jsx-runtime",
  "@openworkbench/app-ui-kit",
  "lucide-react",
]);

/** App builds may only resolve app-local source or supported UI packages.
 * This also blocks Vite raw imports/globs that could otherwise embed host files.
 */
export function inspectComponentSource(
  files: SourceFiles,
): { path: string; message: string; line?: number }[] {
  const problems: { path: string; message: string; line?: number }[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith("ui/components/")) continue;
    const source = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const report = (node: ts.Node, message: string) =>
      problems.push({
        path,
        message,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    function checkImport(node: ts.Node, specifier: ts.Expression | undefined) {
      if (!specifier || !ts.isStringLiteral(specifier)) {
        report(
          node,
          "Use static imports from app source or the supported UI packages.",
        );
        return;
      }
      const spec = specifier.text;
      if (supportedModules.has(spec)) return;
      if (
        spec === "../generated/entities.d.ts" &&
        ts.isImportDeclaration(node) &&
        node.importClause?.isTypeOnly
      )
        return;
      if (spec.startsWith("./") && !/[?#!\\]/.test(spec)) {
        const resolved = posix.normalize(posix.join(posix.dirname(path), spec));
        if (
          resolved.startsWith("ui/components/") &&
          [resolved, `${resolved}.ts`, `${resolved}.tsx`].some((candidate) =>
            Object.hasOwn(files, candidate),
          )
        )
          return;
      }
      report(
        node,
        `Import "${spec}" is outside this app's UI boundary. Use local component files, react, lucide-react, or @openworkbench/app-ui-kit.`,
      );
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) checkImport(node, node.moduleSpecifier);
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        checkImport(node, node.moduleSpecifier);
      else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        checkImport(node, node.arguments[0]);
      else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      )
        report(node, "Use supported static imports instead of require().");
      else if (
        ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword
      )
        report(
          node,
          "import.meta and filesystem asset lookups are not part of an app component.",
        );
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return problems;
}
