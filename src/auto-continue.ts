import { Plugin } from "@opencode/plugin";
import {
  DEFAULT_AUTO_CONTINUE_MAX_ROUNDS,
  DEFAULT_AUTO_CONTINUE_PROMPT,
} from "./config/loader.js";
import type { ResolvedConfig } from "./config/types.js";

type SessionMessageLike = {
  id?: string;
  type?: string;
  model?: { id?: string; providerID?: string };
  content?: Array<{ type?: string }>;
  metadata?: Record<string, unknown> | null;
  time?: { created?: number; completed?: number };
};

type AutoContinueSource = {
  ctx: Plugin.Context;
  providerID: () => string;
  config: () => ResolvedConfig | undefined;
};

type SessionState = {
  rounds: number;
  continuing: boolean;
  lastAssistantID?: string;
};

type StepData = {
  sessionID: string;
  assistantMessageID: string;
};

type StepFailure = {
  type?: string;
  message?: string;
  status?: number;
  classification?: string;
};

export function isRetryableStreamFailure(error: StepFailure): boolean {
  const type = error.type?.toLowerCase() ?? "";
  const message = error.message?.toLowerCase() ?? "";
  const classification = error.classification?.toLowerCase() ?? "";

  if (
    classification === "incomplete-stream" ||
    /stream ended without (?:a )?finish[_ -]?reason/.test(message)
  )
    return true;

  if (
    type.includes("permission") ||
    type.includes("auth") ||
    type.includes("invalid") ||
    type.includes("parameter")
  )
    return false;
  if (
    type.includes("transport") ||
    type.includes("decode") ||
    type.includes("network")
  )
    return true;
  return (
    error.status === undefined || error.status >= 500
  ) && /socket|connection (?:was )?(?:closed|reset|aborted)|econn(?:reset|refused)|timed? out|network error|stream.*closed|decode error/.test(
    message,
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function modelAutoContinueEnabled(
  config: ResolvedConfig | undefined,
  modelID: string | undefined,
): boolean {
  return Boolean(
    modelID &&
      config?.models.some(
        (model) => model.gatewayId === modelID && model.autoContinue === true,
      ),
  );
}

function hasAutoContinuationAfter(
  messages: readonly unknown[],
  assistant: SessionMessageLike,
): boolean {
  const assistantTime = assistant.time?.completed ?? assistant.time?.created;
  if (assistantTime === undefined) return false;
  return messages.some((item) => {
    const message = item as SessionMessageLike;
    return (
      message.type === "user" &&
      message.metadata?.source === "zmllmgw.auto-continue" &&
      (message.time?.created ?? 0) > assistantTime
    );
  });
}

class AutoContinueCoordinator {
  private readonly sources = new Map<number, AutoContinueSource>();
  private readonly states = new Map<string, SessionState>();
  private nextSourceID = 0;
  private abort?: AbortController;
  private promptRegistration?: { dispose(): Promise<void> };

  async register(source: AutoContinueSource): Promise<() => Promise<void>> {
    const sourceID = this.nextSourceID++;
    this.sources.set(sourceID, source);
    if (this.sources.size === 1) await this.start(source.ctx);

    return async () => {
      this.sources.delete(sourceID);
      if (this.sources.size > 0) return;
      this.abort?.abort();
      this.abort = undefined;
      await this.promptRegistration?.dispose();
      this.promptRegistration = undefined;
      this.states.clear();
    };
  }

  private async start(ctx: Plugin.Context): Promise<void> {
    this.promptRegistration = await ctx.session.hook("prompt", (event) => {
      if (event.metadata?.source === "zmllmgw.auto-continue") return;
      this.states.delete(event.sessionID);
    });

    if (!ctx.event?.subscribe) return;
    this.abort = new AbortController();
    void this.consume(ctx, this.abort.signal);
  }

  private async consume(ctx: Plugin.Context, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (event.type === "session.step.ended") {
          if (event.data.finish !== "length") continue;
          await this.handleStep(ctx, event.data, 0);
          continue;
        }
        if (event.type !== "session.step.failed") continue;
        if (!isRetryableStreamFailure(event.data.error)) continue;
        await this.handleStep(ctx, event.data, 1_000);
      }
    } catch (error) {
      if (!signal.aborted)
        console.warn(
          `[zmllmgw] auto continuation event stream stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }

  private async handleStep(
    ctx: Plugin.Context,
    data: StepData,
    delayMilliseconds: number,
  ): Promise<void> {
    const messages = await ctx.session.context({ sessionID: data.sessionID });
    const message = messages.find(
      (item) =>
        (item as SessionMessageLike).id === data.assistantMessageID,
    ) as SessionMessageLike | undefined;
    if (!message || message.type !== "assistant") return;
    if (message.content?.some((part) => part.type === "tool")) return;
    if (hasAutoContinuationAfter(messages, message)) return;

    const source = [...this.sources.values()].find((item) => {
      return (
        item.providerID() === message.model?.providerID &&
        modelAutoContinueEnabled(item.config(), message.model?.id)
      );
    });
    if (!source) return;

    const state = this.states.get(data.sessionID) ?? {
      rounds: 0,
      continuing: false,
    };
    if (state.continuing) return;
    if (state.lastAssistantID === data.assistantMessageID) return;

    const maxRounds =
      source.config()?.autoContinue.maxRounds ??
      DEFAULT_AUTO_CONTINUE_MAX_ROUNDS;
    if (state.rounds >= maxRounds) {
      console.warn(
        `[zmllmgw] auto continuation limit reached: ${JSON.stringify({
          sessionID: data.sessionID,
          modelID: message.model?.id,
          rounds: state.rounds,
        })}`,
      );
      state.lastAssistantID = data.assistantMessageID;
      this.states.set(data.sessionID, state);
      return;
    }

    state.continuing = true;
    state.rounds += 1;
    state.lastAssistantID = data.assistantMessageID;
    this.states.set(data.sessionID, state);
    try {
      if (delayMilliseconds > 0) {
        await wait(delayMilliseconds);
        if (this.states.get(data.sessionID) !== state) return;
      }
      await source.ctx.session.prompt({
        sessionID: data.sessionID,
        text:
          source.config()?.autoContinue.prompt || DEFAULT_AUTO_CONTINUE_PROMPT,
        delivery: "queue",
        metadata: { source: "zmllmgw.auto-continue" },
      });
    } catch (error) {
      console.warn(
        `[zmllmgw] auto continuation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      state.continuing = false;
    }
  }
}

const COORDINATOR_KEY = "__opencode_zmllmgw_auto_continue_coordinator__";

const coordinator = (() => {
  const globalState = globalThis as Record<string, unknown>;
  const existing = globalState[COORDINATOR_KEY] as
    | AutoContinueCoordinator
    | undefined;
  if (existing) return existing;
  const created = new AutoContinueCoordinator();
  globalState[COORDINATOR_KEY] = created;
  return created;
})();

export function registerAutoContinue(
  source: AutoContinueSource,
): Promise<() => Promise<void>> {
  return coordinator.register(source);
}
