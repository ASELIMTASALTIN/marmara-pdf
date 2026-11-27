import { create } from "zustand";
import type { AiStatus } from "../platform/types";
import type { ChatMessage, Endpoint } from "../ai/client";

export type EngineState = "idle" | "checking" | "starting" | "loading" | "ready" | "missing-engine" | "missing-model" | "error";

export interface ChatItem {
  id: string;
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
  /** Tool steps: whether the action succeeded. */
  ok?: boolean;
  /** Still being generated / running. */
  pending?: boolean;
}

interface AssistantState {
  open: boolean;
  engine: EngineState;
  /** Human-readable detail for the engine state (errors, model name). */
  detail: string | null;
  status: AiStatus | null;
  endpoint: Endpoint | null;
  useGpu: boolean;
  items: ChatItem[];
  /** Conversation sent to the model (system prompt excluded). */
  history: ChatMessage[];
  busy: boolean;
  thinking: boolean;
  /** Generation speed of the last answer (tokens/s). */
  speed: number | null;
  /** Model download in progress. */
  download: { received: number; total: number } | null;
}

export const useAssistant = create<AssistantState>(() => ({
  open: false,
  engine: "idle",
  detail: null,
  status: null,
  endpoint: null,
  useGpu: localStorage.getItem("marmara.aiGpu") !== "0",
  items: [],
  history: [],
  busy: false,
  thinking: false,
  speed: null,
  download: null,
}));
