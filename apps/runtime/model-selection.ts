import { readFileSync } from "node:fs";

export const AUTO_MODEL_ID = "auto";
export type ModelUseCase = "chat" | "workspace";

// Auto is a fixed recommendation per surface, not an LLM router.
export const AUTO_MODELS = {
  chat: "minimax/minimax-m3.1-flash",
  workspace: "openai/gpt-6.1-sol",
} as const satisfies Record<ModelUseCase, string>;

interface CuratedModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export function loadCuratedModels(): CuratedModel[] {
  const config = JSON.parse(readFileSync(new URL("../../pi/models.json", import.meta.url), "utf8"));
  return config.providers.openrouter.models;
}

export function resolveModelId(selection: string, useCase: ModelUseCase): string {
  const id = selection === AUTO_MODEL_ID ? AUTO_MODELS[useCase] : selection;
  if (!loadCuratedModels().some((model) => model.id === id)) {
    throw new Error(`Unknown model "${selection}".`);
  }
  return id;
}

export function modelChoices(useCase: ModelUseCase) {
  const models = loadCuratedModels();
  const recommended = models.find((model) => model.id === resolveModelId(AUTO_MODEL_ID, useCase))!;
  return [{ ...recommended, id: AUTO_MODEL_ID, name: `Auto · ${recommended.name}` }, ...models];
}

// GLM accepts low/high/max rather than medium. Keep routine work economical.
export function modelThinkingLevel(modelId: string): "low" | "medium" {
  return modelId === "z-ai/glm-5.3-flash" ? "low" : "medium";
}
