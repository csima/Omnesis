// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import { AnthropicCompleter } from "./anthropic-completer.js";
import { THINKING_HEADROOM_TOKENS } from "./anthropic-messages.js";

// Mock the Anthropic SDK
const mockCreate = vi.fn(() =>
  Promise.resolve({
    content: [{ type: "text" as const, text: "expanded keywords here" }],
  }),
);

const { MockAPIError } = vi.hoisted(() => ({
  MockAPIError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    static APIError = MockAPIError;
    messages = { create: mockCreate };
  },
}));

const temperatureRejected = () =>
  Promise.reject(
    new MockAPIError(
      400,
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
    ),
  );

describe("AnthropicCompleter", () => {
  test("complete() calls messages.create with correct params", async () => {
    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");

    const result = await provider.complete("test prompt", { maxTokens: 100, temperature: 0.5 });

    expect(result).toBe("expanded keywords here");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      thinking: { type: "disabled" },
      temperature: 0.5,
      messages: [{ role: "user", content: "test prompt" }],
    });
  });

  test("complete() uses default maxTokens and temperature", async () => {
    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");

    await provider.complete("test prompt");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 150,
        temperature: 0.3,
      }),
    );
  });

  test("a model that rejects temperature is retried without it, and never sent it again", async () => {
    mockCreate.mockClear();
    mockCreate.mockImplementationOnce(temperatureRejected);
    const provider = new AnthropicCompleter("claude-haiku-5-5", "test-key");

    await expect(provider.complete("first", { temperature: 0 })).resolves.toBe(
      "expanded keywords here",
    );
    await provider.complete("second");

    const requests = mockCreate.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(requests.map((r) => "temperature" in r)).toEqual([true, false, false]);
  });

  test("other request errors are not retried", async () => {
    mockCreate.mockClear();
    mockCreate.mockImplementationOnce(() =>
      Promise.reject(new MockAPIError(400, "max_tokens: must be at least 1")),
    );
    const provider = new AnthropicCompleter("claude-haiku-5-5", "test-key");

    await expect(provider.complete("prompt", { temperature: 0 })).rejects.toThrow("max_tokens");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("a model that refuses disabled thinking is retried with between_tools, and keeps it", async () => {
    mockCreate.mockClear();
    mockCreate.mockImplementationOnce(() =>
      Promise.reject(
        new MockAPIError(
          400,
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking.type `disabled` is not supported for this model; use `between_tools`."}}',
        ),
      ),
    );
    const provider = new AnthropicCompleter("claude-sonnet-5-5", "test-key");

    await expect(provider.complete("first")).resolves.toBe("expanded keywords here");
    await provider.complete("second");

    const thinking = mockCreate.mock.calls.map(
      (call) => (call[0] as { thinking?: unknown }).thinking,
    );
    expect(thinking).toEqual([
      { type: "disabled" },
      { type: "between_tools" },
      { type: "between_tools" },
    ]);
  });

  test("other 400s are not retried with another thinking mode", async () => {
    mockCreate.mockClear();
    mockCreate.mockImplementationOnce(() =>
      Promise.reject(new MockAPIError(400, "400 messages: at least one message is required")),
    );
    const provider = new AnthropicCompleter("claude-sonnet-5-5", "test-key");

    await expect(provider.complete("prompt")).rejects.toThrow("at least one message");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  describe("thinking, chosen from the model's reported capabilities", () => {
    const thinkingTypes = (types: {
      adaptive: boolean;
      betweenTools: boolean;
      disabled: boolean;
    }) => ({ ...types, enabled: false });
    const sent = () => mockCreate.mock.calls.map((call) => call[0] as Record<string, unknown>);

    test("a model that accepts disabled thinking is sent it", async () => {
      mockCreate.mockClear();
      const provider = new AnthropicCompleter("claude-haiku-4-5", "test-key", {
        thinkingTypes: thinkingTypes({ adaptive: false, betweenTools: false, disabled: true }),
      });
      await provider.complete("prompt", { maxTokens: 100 });
      expect(sent()[0]).toMatchObject({ thinking: { type: "disabled" }, max_tokens: 100 });
      expect(sent()[0]).not.toHaveProperty("output_config");
    });

    test("a model that takes between_tools for off is sent it first time, with no refusal", async () => {
      mockCreate.mockClear();
      const provider = new AnthropicCompleter("claude-sonnet-5-5", "test-key", {
        thinkingTypes: thinkingTypes({ adaptive: true, betweenTools: true, disabled: false }),
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      });
      await provider.complete("prompt", { maxTokens: 300 });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(sent()[0]).toMatchObject({ thinking: { type: "between_tools" }, max_tokens: 300 });
      expect(sent()[0]).not.toHaveProperty("output_config");
    });

    test("a model that cannot stop thinking thinks at low effort, with room to answer", async () => {
      mockCreate.mockClear();
      const provider = new AnthropicCompleter("claude-opus-5-5", "test-key", {
        thinkingTypes: thinkingTypes({ adaptive: true, betweenTools: false, disabled: false }),
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      });
      await provider.complete("prompt", { maxTokens: 300 });
      expect(sent()[0]).not.toHaveProperty("thinking");
      expect(sent()[0]).toMatchObject({
        output_config: { effort: "low" },
        max_tokens: THINKING_HEADROOM_TOKENS,
      });
    });

    test("a refusal is not second-guessed when the capabilities are known", async () => {
      mockCreate.mockClear();
      mockCreate.mockImplementationOnce(() =>
        Promise.reject(new MockAPIError(400, "400 thinking: use between_tools")),
      );
      const provider = new AnthropicCompleter("claude-haiku-4-5", "test-key", {
        thinkingTypes: thinkingTypes({ adaptive: false, betweenTools: false, disabled: true }),
      });
      await expect(provider.complete("prompt")).rejects.toThrow("between_tools");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    test("without capabilities, a model refusing every form of off is left thinking", async () => {
      mockCreate.mockClear();
      const refuse = () =>
        Promise.reject(
          new MockAPIError(400, "400 thinking.type: thinking cannot be turned off for this model"),
        );
      mockCreate.mockImplementationOnce(refuse);
      const provider = new AnthropicCompleter("claude-opus-5-5", "test-key");
      await expect(provider.complete("first", { maxTokens: 300 })).resolves.toBe(
        "expanded keywords here",
      );
      await provider.complete("second", { maxTokens: 300 });
      expect(sent().map((r) => r.thinking)).toEqual([{ type: "disabled" }, undefined, undefined]);
      expect(sent()[1]).toMatchObject({ max_tokens: THINKING_HEADROOM_TOKENS });
      expect(sent()[1]).not.toHaveProperty("output_config");
    });
  });

  test("name is 'anthropic'", () => {
    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");
    expect(provider.name).toBe("anthropic");
  });

  test("dispose() is a no-op", async () => {
    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  test("complete() returns empty string for non-text blocks", async () => {
    mockCreate.mockImplementationOnce(() =>
      Promise.resolve({
        content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
      }),
    );

    const provider = new AnthropicCompleter("claude-haiku-4-5-20251001", "test-key");
    const result = await provider.complete("test");
    expect(result).toBe("");
  });

  test("complete() reads the answer after a thinking block, joining every text block", async () => {
    mockCreate.mockImplementationOnce(() =>
      Promise.resolve({
        content: [
          { type: "thinking", thinking: "weighing it" },
          { type: "text", text: "first " },
          { type: "text", text: "second" },
        ],
      } as never),
    );
    const provider = new AnthropicCompleter("claude-haiku-5-5", "test-key");
    await expect(provider.complete("prompt")).resolves.toBe("first second");
  });
});
