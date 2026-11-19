// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * AnthropicCompleter — API-based text generation via Anthropic Messages API.
 * The sampling temperature goes through `AnthropicTemperature`, which stops
 * sending it once a model refuses it.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicOneShot,
  AnthropicTemperature,
  applyShape,
  responseText,
  type OneShotCapabilities,
} from "./anthropic-messages.js";
import type { CompleteCapability } from "@omnesis/core";

export class AnthropicCompleter implements CompleteCapability {
  readonly name = "anthropic";
  readonly modelId: string;
  private client: Anthropic;
  private readonly temperature = new AnthropicTemperature();
  private readonly oneShot: AnthropicOneShot;

  /** `capabilities`: what the Models API reports the model accepts, when the catalog has it. */
  constructor(modelId: string, apiKey: string, capabilities?: OneShotCapabilities) {
    this.modelId = modelId;
    this.client = new Anthropic({ apiKey });
    this.oneShot = new AnthropicOneShot(capabilities);
  }

  async complete(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: readonly string[];
    },
  ): Promise<string> {
    return (await this.completeWithUsage(prompt, opts)).text;
  }

  /** The reply and the tokens it cost, so a caller can record its spend. */
  async completeWithUsage(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: readonly string[];
    },
  ): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } | null }> {
    const request = {
      model: this.modelId,
      max_tokens: opts?.maxTokens ?? 150,
      // Anthropic's API caps `stop_sequences` at 4 entries and rejects the
      // request outright past that, so truncate rather than fail a call whose
      // caller legitimately passed more.
      ...(opts?.stop && opts.stop.length > 0 ? { stop_sequences: [...opts.stop].slice(0, 4) } : {}),
      messages: [{ role: "user" as const, content: prompt }],
    };
    const response = await this.oneShot.send((shape) =>
      this.temperature.send(opts?.temperature ?? 0.3, (temperature) => {
        const shaped = applyShape(request, shape);
        return this.client.messages.create(
          temperature === undefined ? shaped : { ...shaped, temperature },
        );
      }),
    );
    const usage = response.usage
      ? {
          promptTokens:
            response.usage.input_tokens +
            (response.usage.cache_read_input_tokens ?? 0) +
            (response.usage.cache_creation_input_tokens ?? 0),
          completionTokens: response.usage.output_tokens,
        }
      : null;
    return { text: responseText(response), usage };
  }

  async dispose(): Promise<void> {
    // No-op — stateless HTTP client
  }
}
