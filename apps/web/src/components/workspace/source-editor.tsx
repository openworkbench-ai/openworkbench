import { useEffect, useRef } from "react";
import Editor, {
  DiffEditor,
  loader,
  type OnMount,
  type BeforeMount,
} from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { sourceLanguage } from "@/lib/workspace-model";
import { useTheme } from "@/lib/theme";
import manifestSchema from "../../../../../engine/manifest.schema.json";

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new JsonWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

const setup: BeforeMount = (editor) => {
  editor.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    enableSchemaRequest: false,
    allowComments: false,
    schemas: [
      {
        uri: "https://openworkbench.local/manifest.schema.json",
        fileMatch: ["**/manifest.json"],
        schema: manifestSchema,
      },
    ],
  });
  editor.editor.defineTheme("workbench-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8B9481", fontStyle: "italic" },
      { token: "string", foreground: "65804F" },
      { token: "string.key.json", foreground: "5F6F55" },
      { token: "string.value.json", foreground: "65804F" },
      { token: "number", foreground: "B17B50" },
      { token: "keyword", foreground: "9B684A" },
    ],
    colors: {
      "editor.background": "#FDFCF6",
      "editor.foreground": "#35432E",
      "editorLineNumber.foreground": "#B7B9A7",
      "editorLineNumber.activeForeground": "#61754E",
      "editor.lineHighlightBackground": "#F3F2E9",
      "editor.selectionBackground": "#DCE5D1",
      "editorIndentGuide.background1": "#E8E8DB",
      "editorCursor.foreground": "#D4643A",
    },
  });
  editor.editor.defineTheme("workbench-night", {
    base: "vs-dark",
    inherit: true,
    rules: [{ token: "comment", foreground: "8B9481", fontStyle: "italic" }],
    colors: {
      "editor.background": "#1E2318",
      "editorLineNumber.foreground": "#58604C",
      "editor.lineHighlightBackground": "#242B1D",
      "editorCursor.foreground": "#E07A51",
    },
  });
  editor.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
  });
  editor.languages.typescript.typescriptDefaults.setCompilerOptions({
    jsx: editor.languages.typescript.JsxEmit.ReactJSX,
    target: editor.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
  });
};
const options: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 14,
  lineHeight: 23,
  padding: { top: 20, bottom: 24 },
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  roundedSelection: true,
  renderLineHighlight: "all",
  overviewRulerBorder: false,
  lineNumbersMinChars: 3,
  glyphMargin: false,
  tabSize: 2,
  automaticLayout: true,
  wordWrap: "on",
  bracketPairColorization: { enabled: true },
  stickyScroll: { enabled: false },
  scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
  contextmenu: true,
};

export function SourceEditor({
  appId,
  path,
  value,
  onChange,
  onSave,
  readOnly,
  onPosition,
}: {
  appId: string;
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
  onPosition: (line: number, column: number) => void;
}) {
  const { theme } = useTheme();
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const positionRef = useRef(onPosition);
  positionRef.current = onPosition;
  const mounted: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
    editor.onDidChangeCursorPosition((event) =>
      positionRef.current(event.position.lineNumber, event.position.column),
    );
    editor.focus();
  };
  useEffect(() => {
    editorRef.current?.focus();
  }, [path]);
  return (
    <Editor
      beforeMount={setup}
      onMount={mounted}
      path={`file:///${appId}/${path}`}
      language={sourceLanguage(path)}
      value={value}
      onChange={(value) => onChange(value ?? "")}
      theme={theme === "dark" ? "workbench-night" : "workbench-paper"}
      options={{ ...options, readOnly }}
      loading={<div className="editor-loading">Opening editor…</div>}
    />
  );
}

export function SourceDiff({
  original,
  modified,
  path,
}: {
  original: string;
  modified: string;
  path: string;
}) {
  const { theme } = useTheme();
  return (
    <DiffEditor
      beforeMount={setup}
      original={original}
      modified={modified}
      language={sourceLanguage(path)}
      theme={theme === "dark" ? "workbench-night" : "workbench-paper"}
      options={{
        ...options,
        readOnly: true,
        renderSideBySide: false,
        originalEditable: false,
        diffWordWrap: "on",
      }}
      loading={<div className="editor-loading">Comparing source…</div>}
    />
  );
}
