// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  getHostIdentity: vi.fn(),
  setHostAgentDefault: vi.fn(),
  clearHostAgentDefault: vi.fn(),
}));

vi.mock("../../api.js", () => api);

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { HostAgents, hostPeople } from "./host-agents.js";

const CONNECTION = "00000000-0000-4000-8000-000000000010";
const LEVELS = [
  { id: "00000000-0000-4000-8000-0000000000a1", name: "Answer only" },
  { id: "00000000-0000-4000-8000-0000000000a2", name: "Mail reader" },
];
const ENTRIES = [{ id: CONNECTION, name: "Fictional agent host" }];

function binding(defaults: unknown[] = []) {
  return {
    connectionId: CONNECTION,
    issuer: "https://agents.example.com",
    audience: "https://omnesis.example.com/mcp",
    agents: [
      {
        id: "grant-1",
        person: "maya@example.com",
        agent: "instance:agent-a",
        levelId: LEVELS[1]!.id,
        levelName: "Mail reader",
      },
    ],
    defaults,
  };
}

describe("hostPeople", () => {
  test("groups agents and defaults by person, a default without agents included", () => {
    const people = hostPeople(
      binding([{ id: "default-2", person: "jamie@example.com", levelId: LEVELS[0]!.id }]),
    );
    expect(people.map((entry: { person: string }) => entry.person)).toEqual([
      "jamie@example.com",
      "maya@example.com",
    ]);
    expect(people[0]).toMatchObject({ agents: [], default: { id: "default-2" } });
    expect(people[1]).toMatchObject({ agents: [{ agent: "instance:agent-a" }], default: null });
  });
});

describe("HostAgents", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function mount() {
    await act(async () => {
      render(h(HostAgents, { levels: LEVELS, entries: ENTRIES }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
  }

  // linkedom's select has no settable `value`: Preact falls back to the
  // attribute when rendering, and a choice is the value the change carries.
  function chosen(select: HTMLSelectElement): string | null {
    return select.getAttribute("value");
  }

  async function choose(select: HTMLSelectElement, value: string) {
    await act(async () => {
      Object.defineProperty(select, "value", { configurable: true, get: () => value });
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
  }

  function defaultSelect() {
    return host.querySelector<HTMLSelectElement>(".access-host-default select")!;
  }

  test("renders nothing until a connection is bound to an agent host", async () => {
    api.getHostIdentity.mockResolvedValue({ bindings: [] });
    await mount();
    expect(host.innerHTML).toBe("");
  });

  test("lists each person's agents and their default for other agents", async () => {
    api.getHostIdentity.mockResolvedValue({
      bindings: [binding([{ id: "default-1", person: "maya@example.com", levelId: LEVELS[0]!.id }])],
    });
    await mount();
    expect(host.textContent).toContain("Fictional agent host");
    expect(host.textContent).toContain("https://agents.example.com");
    expect(host.textContent).toContain("instance:agent-a");
    expect(host.textContent).toContain("Default for other agents");
    expect(chosen(defaultSelect())).toBe(LEVELS[0]!.id);
  });

  test("sets the default, and clears it with No access", async () => {
    api.getHostIdentity.mockResolvedValue({ bindings: [binding()] });
    api.setHostAgentDefault.mockResolvedValue({
      default: { person: "maya@example.com", levelId: LEVELS[0]!.id, levelName: "Answer only" },
    });
    await mount();
    expect(chosen(defaultSelect())).toBe("");
    await choose(defaultSelect(), LEVELS[0]!.id);
    expect(api.setHostAgentDefault).toHaveBeenCalledWith(
      CONNECTION,
      "maya@example.com",
      LEVELS[0]!.id,
    );
    expect(host.querySelector(".access-notice")?.textContent).toContain("“Answer only”");

    api.getHostIdentity.mockResolvedValue({
      bindings: [binding([{ id: "default-1", person: "maya@example.com", levelId: LEVELS[0]!.id }])],
    });
    api.clearHostAgentDefault.mockResolvedValue({ cleared: true });
    await choose(defaultSelect(), "");
    expect(api.clearHostAgentDefault).toHaveBeenCalledWith(CONNECTION, "maya@example.com");
    expect(host.querySelector(".access-notice")?.textContent).toContain("no access");
  });

  test("says why the gateway refused a default", async () => {
    api.getHostIdentity.mockResolvedValue({ bindings: [binding()] });
    api.setHostAgentDefault.mockRejectedValue(
      Object.assign(new Error("refused"), { status: 409, serverMessage: "inactive-grant" }),
    );
    await mount();
    await choose(defaultSelect(), LEVELS[1]!.id);
    expect(host.querySelector(".access-error")?.textContent).toBe(
      "That access level no longer exists.",
    );
  });
});
