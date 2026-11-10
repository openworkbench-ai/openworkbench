import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchWorkspace,
  saveWorkspace,
  type SourceFiles,
  type WorkspaceProject,
} from "@/lib/workspace-api";

export function useWorkspace(id: string) {
  const [project, setProject] = useState<WorkspaceProject | null>(null);
  const [files, setFiles] = useState<SourceFiles>({});
  const [loadingError, setLoadingError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const projectRef = useRef<WorkspaceProject | null>(null);
  const filesRef = useRef<SourceFiles>({});
  const inFlight = useRef<Promise<WorkspaceProject> | null>(null);
  const mounted = useRef(true);
  const recoveryKey = `owb.workspace.recovery.${id}`;

  const accept = useCallback(
    (next: WorkspaceProject) => {
      projectRef.current = next;
      filesRef.current = { ...next.files };
      if (mounted.current) {
        setProject(next);
        setFiles({ ...next.files });
        setSaveError("");
      }
      try {
        sessionStorage.removeItem(recoveryKey);
      } catch {
        /* Storage is optional. */
      }
      return next;
    },
    [recoveryKey],
  );

  useEffect(() => {
    mounted.current = true;
    let active = true;
    fetchWorkspace(id)
      .then((next) => {
        if (!active) return;
        let saved: string | null = null;
        try {
          saved = sessionStorage.getItem(recoveryKey);
        } catch {
          /* Storage is optional. */
        }
        accept(next);
        try {
          if (saved) {
            const recovery = JSON.parse(saved) as {
              version: number;
              files: SourceFiles;
            };
            if (
              recovery.files["manifest.json"] &&
              JSON.stringify(recovery.files) !== JSON.stringify(next.files)
            ) {
              filesRef.current = recovery.files;
              setFiles(recovery.files);
              sessionStorage.setItem(recoveryKey, saved);
              if (recovery.version !== next.version) {
                const conflicting = { ...next, version: recovery.version };
                projectRef.current = conflicting;
                setProject(conflicting);
                setSaveError(
                  "Recovered unsaved edits from an older draft. Copy the changes you want to keep, then reload to reconcile them with the newer source.",
                );
              }
            }
          }
        } catch {
          /* A server draft remains authoritative if recovery is unavailable. */
        }
      })
      .catch((error) => {
        if (active) setLoadingError(error.message);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [id, accept, recoveryKey]);

  const flush = useCallback(async (): Promise<WorkspaceProject> => {
    if (inFlight.current) {
      await inFlight.current;
      return flush();
    }
    const current = projectRef.current;
    if (!current) throw new Error("The workspace is still opening.");
    const snapshot = { ...filesRef.current };
    const patch = Object.fromEntries(
      [...new Set([...Object.keys(current.files), ...Object.keys(snapshot)])]
        .filter((path) => current.files[path] !== snapshot[path])
        .map((path) => [path, snapshot[path] ?? null]),
    );
    if (Object.keys(patch).length === 0) return current;
    if (mounted.current) {
      setSaving(true);
      setSaveError("");
    }
    const pending = saveWorkspace(id, current.version, patch);
    inFlight.current = pending;
    try {
      const next = await pending;
      projectRef.current = next;
      if (mounted.current) setProject(next);
      try {
        if (JSON.stringify(filesRef.current) === JSON.stringify(snapshot))
          sessionStorage.removeItem(recoveryKey);
        else
          sessionStorage.setItem(
            recoveryKey,
            JSON.stringify({ version: next.version, files: filesRef.current }),
          );
      } catch {
        /* Best-effort recovery only. */
      }
      return next;
    } catch (error) {
      if (mounted.current) setSaveError((error as Error).message);
      throw error;
    } finally {
      inFlight.current = null;
      if (mounted.current) setSaving(false);
    }
  }, [id, recoveryKey]);

  const edit = useCallback(
    (path: string, content: string | null) => {
      const next = { ...filesRef.current };
      if (content === null) delete next[path];
      else next[path] = content;
      filesRef.current = next;
      setFiles(next);
      setSaveError("");
      try {
        sessionStorage.setItem(
          recoveryKey,
          JSON.stringify({ version: projectRef.current?.version, files: next }),
        );
      } catch {
        /* Best-effort recovery only. */
      }
    },
    [recoveryKey],
  );

  const unsaved =
    !!project && JSON.stringify(files) !== JSON.stringify(project.files);
  useEffect(() => {
    if (!unsaved || saveError) return;
    const timer = window.setTimeout(() => {
      void flush().catch(() => {});
    }, 650);
    return () => window.clearTimeout(timer);
  }, [files, unsaved, flush, saveError, saving]);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const reload = useCallback(
    async () => accept(await fetchWorkspace(id)),
    [id, accept],
  );
  return {
    project,
    files,
    loadingError,
    saveError,
    saving,
    unsaved,
    edit,
    flush,
    accept,
    reload,
  };
}
