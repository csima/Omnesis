// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What every one-shot Anthropic Messages call in the gateway shares: no
 * extended thinking, in whichever form the model accepts, a sampling
 * temperature sent only while the model accepts it, and the reply's text read
 * from every text block.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * A one-shot call asks for a direct answer within a budget sized for it. A model
 * that thinks by default would spend that budget thinking and return no text.
 */
export const NO_THINKING: Anthropic.ThinkingConfigDisabled = { type: "disabled" };

/**
 * How newer models are told not to think on a call: they refuse
 * `{ type: "disabled" }` with a 400 that names this mode, which thinks only
 * between tool calls — never, on a one-shot call that has none.
 */
export const BETWEEN_TOOLS_THINKING: Anthropic.ThinkingConfigBetweenTools = {
  type: "between_tools",
};

/**
 * The thinking setting a one-shot call sends: `disabled` until the model
 * refuses it in favour of `between_tools`, which is then retried and sent from
 * then on through this instance.
 */
export class AnthropicThinking {
  private config: Anthropic.ThinkingConfigParam = NO_THINKING;

  async send<T>(send: (thinking: Anthropic.ThinkingConfigParam) => Promise<T>): Promise<T> {
    const sent = this.config;
    try {
      return await send(sent);
    } catch (err) {
      if (sent.type !== "disabled" || !asksForBetweenTools(err)) throw err;
      this.config = BETWEEN_TOOLS_THINKING;
      return send(this.config);
    }
  }
}

/** A 400 whose message names `between_tools`, the thinking mode the model takes instead. */
function asksForBetweenTools(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError && err.status === 400 && /\bbetween_tools\b/.test(err.message)
  );
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
