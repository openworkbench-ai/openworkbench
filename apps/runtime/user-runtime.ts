import type { AgentBackend } from "./agent-backend.js";
import type { Capabilities } from "./app-loader.js";

/**
 * One user's live agent state: their own chat conversation and their own
 * app-building conversation (each a separate Pi session with its own history,
 * model choice, and -- for the build agent -- scratch workspace). Sessions are
 * created lazily on first use and evicted when idle, since each holds a model
 * session in memory.
 */
export interface UserRuntime {
  streaming: boolean;
  buildStreaming: boolean;
  lastUsed: number;
  chat(): Promise<AgentBackend>;
  build(): Promise<AgentBackend>;
  /** Rebuilds the chat agent against the user's current apps, keeping their model. Returns false if it's mid-response. */
  refreshChat(): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface UserRuntimeFactory {
  createChat(capabilities: Capabilities, modelId?: string): Promise<AgentBackend>;
  createBuild(modelId?: string): Promise<AgentBackend>;
  /** The user's currently visible capabilities -- read at agent-creation time so a new session always sees fresh apps. */
  capabilitiesFor(userId: string): Capabilities;
}

export function createUserRuntimes(factory: UserRuntimeFactory, options: { idleMs?: number; now?: () => number } = {}) {
  const idleMs = options.idleMs ?? 2 * 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const runtimes = new Map<string, UserRuntime>();

  function create(userId: string): UserRuntime {
    let chatBackend: Promise<AgentBackend> | undefined;
    let buildBackend: Promise<AgentBackend> | undefined;

    const runtime: UserRuntime = {
      streaming: false,
      buildStreaming: false,
      lastUsed: now(),

      chat() {
        // A rejected creation must not be cached, or one transient failure bricks the user's chat until eviction.
        chatBackend ??= factory.createChat(factory.capabilitiesFor(userId)).catch((error) => {
          chatBackend = undefined;
          throw error;
        });
        return chatBackend;
      },

      build() {
        buildBackend ??= factory.createBuild().catch((error) => {
          buildBackend = undefined;
          throw error;
        });
        return buildBackend;
      },

      async refreshChat() {
        if (runtime.streaming) return false;
        if (!chatBackend) return true; // not created yet: it will pick up current apps when it is
        const modelId = (await chatBackend).getModelId();
        chatBackend = factory.createChat(factory.capabilitiesFor(userId), modelId);
        await chatBackend;
        return true;
      },

      async dispose() {
        const backends = [chatBackend, buildBackend];
        chatBackend = buildBackend = undefined;
        for (const pending of backends) {
          await (await pending?.catch(() => undefined))?.dispose?.();
        }
      },
    };
    return runtime;
  }

  const sweep = setInterval(() => {
    for (const [userId, runtime] of runtimes) {
      if (runtime.streaming || runtime.buildStreaming || now() - runtime.lastUsed < idleMs) continue;
      runtimes.delete(userId);
      void runtime.dispose();
    }
  }, 5 * 60 * 1000);
  sweep.unref();

  return {
    /** The user's runtime, created on first use. Touching it resets its idle clock. */
    forUser(userId: string): UserRuntime {
      let runtime = runtimes.get(userId);
      if (!runtime) {
        runtime = create(userId);
        runtimes.set(userId, runtime);
      }
      runtime.lastUsed = now();
      return runtime;
    },

    async disposeAll(): Promise<void> {
      clearInterval(sweep);
      const all = [...runtimes.values()];
      runtimes.clear();
      await Promise.all(all.map((r) => r.dispose()));
    },
  };
}
