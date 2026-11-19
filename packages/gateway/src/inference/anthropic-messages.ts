// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What every one-shot Anthropic Messages call in the gateway shares: no
 * thinking, asked for in the form the model accepts; a sampling temperature
 * sent only while the model accepts it; and the reply's text read from every
 * text block.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicEffortLevel, AnthropicThinkingTypes } from "@omnesis/core";

/**
 * A one-shot call asks for a direct answer within a budget sized for it. A model
 * that thinks by default would spend that budget thinking and return no text.
 */
export const NO_THINKING: Anthropic.ThinkingConfigDisabled = { type: "disabled" };

/**
 * Thinking off on models that refuse `disabled`: the model thinks only between
 * tool calls, so never on a one-shot call, which has none.
 */
export const BETWEEN_TOOLS_THINKING: Anthropic.ThinkingConfigBetweenTools = {
  type: "between_tools",
};

/**
 * The output room a one-shot call gets on a model that cannot stop thinking,
 * so the thinking it does at low effort cannot use up the reply's budget.
 * Only the tokens produced are billed.
 */
export const THINKING_HEADROOM_TOKENS = 4_096;

/** What the Models API says a model accepts, as far as a one-shot call cares. */
export interface OneShotCapabilities {
  readonly thinkingTypes?: AnthropicThinkingTypes;
  readonly effortLevels?: readonly AnthropicEffortLevel[];
}

/** How a one-shot request asks this model for a direct answer. */
export interface OneShotShape {
  /** Sent as `thinking`; absent to leave thinking at the model's default. */
  readonly thinking?: Anthropic.ThinkingConfigParam;
  /** Sent as `output_config.effort`. */
  readonly effort?: AnthropicEffortLevel;
  /** The least `max_tokens` the request may carry. */
  readonly minMaxTokens?: number;
}

/**
 * The model cannot stop thinking: leave thinking at its default, as little of
 * it as the model allows, with room for it beside the answer.
 */
function thinkingStaysOn(effortLevels: readonly AnthropicEffortLevel[] | undefined): OneShotShape {
  return {
    ...(effortLevels?.includes("low") ? { effort: "low" as const } : {}),
    minMaxTokens: THINKING_HEADROOM_TOKENS,
  };
}

/**
 * The form of "don't think" this model accepts, chosen from the capabilities
 * the Models API reports: `disabled` where accepted, else `between_tools`,
 * else thinking left on at the lowest effort. Undefined when the capabilities
 * are not known.
 */
export function oneShotShape(
  capabilities: OneShotCapabilities | undefined,
): OneShotShape | undefined {
  const types = capabilities?.thinkingTypes;
  if (!types) return undefined;
  if (types.disabled) return { thinking: NO_THINKING };
  if (types.betweenTools) return { thinking: BETWEEN_TOOLS_THINKING };
  return thinkingStaysOn(capabilities?.effortLevels);
}

/** The request fields a shape sets, applied over a request's own. */
export function applyShape<R extends { max_tokens: number }>(
  request: R,
  shape: OneShotShape,
): R & {
  thinking?: Anthropic.ThinkingConfigParam;
  output_config?: { effort: AnthropicEffortLevel };
} {
  return {
    ...request,
    max_tokens: Math.max(request.max_tokens, shape.minMaxTokens ?? 0),
    ...(shape.thinking ? { thinking: shape.thinking } : {}),
    ...(shape.effort ? { output_config: { effort: shape.effort } } : {}),
  };
}

/**
 * The shape a model's one-shot requests take. Chosen from the model's
 * reported capabilities when the catalog has them. Without them — a bundled
 * catalog entry, a Models API that could not be reached — it starts at
 * `disabled` and follows the model's refusal: to `between_tools` when a 400
 * names it, else to thinking left on, and keeps what worked for later calls.
 */
export class AnthropicOneShot {
  private shape: OneShotShape;
  private readonly known: boolean;

  constructor(capabilities?: OneShotCapabilities) {
    const chosen = oneShotShape(capabilities);
    this.known = chosen !== undefined;
    this.shape = chosen ?? { thinking: NO_THINKING };
  }

  async send<T>(send: (shape: OneShotShape) => Promise<T>): Promise<T> {
    for (;;) {
      const sent = this.shape;
      try {
        return await send(sent);
      } catch (err) {
        const next = this.known ? undefined : fallbackAfter(sent, err);
        if (!next) throw err;
        this.shape = next;
      }
    }
  }
}

/** Where a refused thinking setting goes next, or undefined when the refusal was about something else. */
function fallbackAfter(sent: OneShotShape, err: unknown): OneShotShape | undefined {
  if (!(err instanceof Anthropic.APIError) || err.status !== 400 || !sent.thinking)
    return undefined;
  if (!/\bthinking\b/.test(err.message)) return undefined;
  if (sent.thinking.type === "disabled" && /\bbetween_tools\b/.test(err.message)) {
    return { thinking: BETWEEN_TOOLS_THINKING };
  }
  // A model that thinks regardless refuses every form of "off"; it gets no
  // effort setting here, since nothing says which levels it accepts.
  return thinkingStaysOn(undefined);
}

/**
 * Newer models reject the sampling temperature outright with a 400; the first
 * such rejection is retried without it, and the parameter is never sent again
 * through this instance.
 */
export class AnthropicTemperature {
  private accepted = true;

  /** Run `send` with `temperature`, or without it once the model has refused one. */
  async send<T>(
    temperature: number | undefined,
    send: (temperature: number | undefined) => Promise<T>,
  ): Promise<T> {
    const sent = this.accepted ? temperature : undefined;
    try {
      return await send(sent);
    } catch (err) {
      if (sent === undefined || !rejectsTemperature(err)) throw err;
      this.accepted = false;
      return send(undefined);
    }
  }
}

/** A 400 whose message names the `temperature` parameter. */
function rejectsTemperature(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError && err.status === 400 && /\btemperature\b/.test(err.message)
  );
}

/** The reply's text: every text block, in order; thinking and tool blocks are skipped. */
export function responseText(response: Pick<Anthropic.Message, "content">): string {
  return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}
