import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  createWorkspaceChatState,
  reduceWorkspaceChat,
  type AgentStreamEvent,
} from "../../packages/workspace-chat.js";
import { runWorkspaceAgent } from "./workspace-agent.js";
import { WorkspaceError } from "./workspace-store.js";

type RunOptions = Omit<
  Parameters<typeof runWorkspaceAgent>[0],
  "signal" | "onEvent"
> & {
  runAgent?: typeof runWorkspaceAgent;
  onFinished: () => void;
};

/** A browser connection observes a run; only an explicit stop cancels its work. */
export function createWorkspaceRun(options: RunOptions) {
  const controller = new AbortController();
  let state = createWorkspaceChatState(randomUUID());
  let sequence = 0;
  let finished = false;
  let bufferedBytes = 0;
  const history: { sequence: number; frame: string }[] = [];
  const subscribers = new Set<ServerResponse>();
  function emit(event: AgentStreamEvent) {
    state = reduceWorkspaceChat(state, event);
    const entry = {
      sequence: ++sequence,
      frame: `id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`,
    };
    history.push(entry);
    bufferedBytes += Buffer.byteLength(entry.frame);
    // Bound replay memory. The durable transcript remains available after replay expires.
    while (bufferedBytes > 16 * 1024 * 1024 && history.length > 1)
      bufferedBytes -= Buffer.byteLength(history.shift()!.frame);
    for (const res of subscribers) {
      if (res.destroyed || res.writableEnded) continue;
      // Slow clients reconnect from their last event instead of growing a write queue forever.
      if (res.writableLength > 1024 * 1024) res.destroy();
      else res.write(entry.frame);
    }
  }
  options.store.addMessage(options.userId, options.id, {
    id: randomUUID(),
    role: "user",
    text: options.message,
    at: new Date().toISOString(),
  });
  const deadline = setTimeout(
    () =>
      controller.abort(
        new Error(
          "The coding partner reached its 30-minute time limit. Completed edits are saved.",
        ),
      ),
    30 * 60 * 1000,
  );
  deadline.unref();
  // Start on the next microtask so the route can register the run and subscribe first.
  const completion = Promise.resolve().then(async () => {
    try {
      await (options.runAgent ?? runWorkspaceAgent)({
        ...options,
        signal: controller.signal,
        onEvent: emit,
      });
      if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) {
      const failure = controller.signal.aborted
        ? controller.signal.reason
        : error;
      emit({
        type: "error",
        reason: failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      clearTimeout(deadline);
      if (!state.message.text && !state.message.error)
        emit({ type: "text", delta: "Done. Review the source changes before applying." });
      state = reduceWorkspaceChat(state, { type: "done" });
      try {
        options.store.addMessage(options.userId, options.id, state.message);
      } catch (error) {
        emit({
          type: "error",
          reason: `Could not save the conversation: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        options.onFinished();
        finished = true;
        emit({ type: "done" });
        for (const res of subscribers) res.end();
        subscribers.clear();
      }
    }
  });
  return {
    completion,
    get finished() {
      return finished;
    },
    stop() {
      controller.abort(
        new Error("Stopped. Any completed edits are saved in your draft."),
      );
    },
    attach(res: ServerResponse, after = 0, heartbeatMs = 15000) {
      if (!Number.isSafeInteger(after) || after < 0 || after > sequence)
        throw new WorkspaceError(400, "Invalid stream position.");
      if (after < (history[0]?.sequence ?? 1) - 1)
        throw new WorkspaceError(
          410,
          "Stream history expired. Reload the app to see saved changes and conversation.",
        );
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      res.write(": connected\n\n");
      for (const event of history)
        if (event.sequence > after) res.write(event.frame);
      if (finished) {
        res.end();
        return;
      }
      subscribers.add(res);
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n");
      }, heartbeatMs);
      heartbeat.unref();
      res.once("close", () => {
        clearInterval(heartbeat);
        subscribers.delete(res);
      });
    },
  };
}

export type WorkspaceRun = ReturnType<typeof createWorkspaceRun>;
