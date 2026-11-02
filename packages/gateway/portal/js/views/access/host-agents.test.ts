// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  setHostAgentDefault: vi.fn(),
  clearHostAgentDefault: vi.fn(),
  setHostAgentLevel: vi.fn(),
  revokeHostAgent: vi.fn(),
}));

vi.mock("../../api.js", () => api);

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { HostAgents, hostLevelUses, hostPeople, isPersonEmail } from "./host-agents.js";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { AccessList } from "./access-list.js";

const CONNECTION = "00000000-0000-4000-8000-000000000010";
const ANSWER = "00000000-0000-4000-8000-0000000000a1";
const READER = "00000000-0000-4000-8000-0000000000a2";
const LEVELS = [
  { id: ANSWER, name: "Answer only", revision: 1 },
  { id: READER, name: "Mail reader", revision: 1 },
];
const ENTRIES = [{ id: CONNECTION, name: "Fictional agent host" }];
const AGENT = {
  id: "grant-1",
  person: "maya@example.com",
  agent: "instance:agent-a",
  levelId: READER,
  levelName: "Mail reader",
};

function identity(defaults: unknown[] = [], agents: unknown[] = [AGENT]) {
  return {
    bindings: [
      {
        connectionId: CONNECTION,
        issuer: "https://agents.example.com",
        audience: "https://omnesis.example.com/mcp",
        agents,
        defaults,
      },
    ],
  };
}

const MAYA_DEFAULT = { id: "default-1", person: "maya@example.com", levelId: ANSWER };

describe("host agent helpers", () => {
  test("groups agents and defaults by person, a default without agents included", () => {
    const people = hostPeople(
      identity([{ id: "default-2", person: "jamie@example.com", levelId: ANSWER }]).bindings[0],
    );
    expect(people.map((entry: { person: string }) => entry.person)).toEqual([
      "jamie@example.com",
      "maya@example.com",
    ]);
    expect(people[0]).toMatchObject({ agents: [], default: { id: "default-2" } });
    expect(people[1]).toMatchObject({ agents: [{ agent: "instance:agent-a" }], default: null });
  });

  test("counts the grants and defaults on each level, never a denial", () => {
    const uses = hostLevelUses(
      identity([MAYA_DEFAULT], [AGENT, { ...AGENT, id: "grant-2", levelId: null }]),
    );
    expect([...uses.entries()]).toEqual([
      [READER, 1],
      [ANSWER, 1],
    ]);
  });

  test("takes only an email address as a person", () => {
    expect(isPersonEmail("maya@example.com")).toBe(true);
    for (const value of ["*", "maya", "maya@", "maya@example", "a b@example.com"]) {
      expect(isPersonEmail(value)).toBe(false);
    }
  });
});

describe("HostAgents", () => {
  let host: HTMLElement;
  let onChanged: ReturnType<typeof vi.fn>;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    onChanged = vi.fn().mockResolvedValue(undefined);
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

  async function mount(hostIdentity: unknown) {
    await act(async () => {
      render(h(HostAgents, { hostIdentity, levels: LEVELS, entries: ENTRIES, onChanged }), host);
      await Promise.resolve();
    });
  }

  async function settle() {
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
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
    });
    await settle();
  }

  async function click(element: Element) {
    await act(async () => { (element as HTMLElement).click(); });
    await settle();
  }

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.defineProperty(input, "value", { configurable: true, get: () => value });
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }

  const defaultSelect = () => host.querySelector<HTMLSelectElement>(".access-host-default select")!;
  const agentSelect = () => host.querySelector<HTMLSelectElement>(".access-host-agent select")!;
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label)!;

  test("renders nothing until a connection is bound to an agent host", async () => {
    await mount({ bindings: [] });
    expect(host.innerHTML).toBe("");
  });

  test("marks an expired connection, and offers it no new default", async () => {
    const expired = identity([MAYA_DEFAULT]);
    await mount({ bindings: [{ ...expired.bindings[0], state: "expired" }] });
    expect(host.querySelector(".access-level-name .access-revoked")?.textContent).toBe("Expired");
    expect(host.textContent).toContain("Nothing calls through this connection while it is expired.");
    expect(host.querySelector(".access-host-new")).toBeNull();
    expect(host.querySelector(".access-host-default select")).not.toBeNull();
    expect(host.querySelector(".access-host-remove")).not.toBeNull();

    await mount({ bindings: [{ ...expired.bindings[0], state: "active" }] });
    expect(host.querySelector(".access-revoked")).toBeNull();
    expect(host.querySelector(".access-host-new")).not.toBeNull();
  });

  test("lists each person's agents with their level and the default for other agents", async () => {
    await mount(identity([MAYA_DEFAULT], [AGENT, { ...AGENT, id: "grant-2", agent: "instance:agent-b", levelId: null, levelName: null }]));
    expect(host.textContent).toContain("Fictional agent host");
    expect(host.textContent).toContain("instance:agent-a");
    const selects = [...host.querySelectorAll<HTMLSelectElement>(".access-host-agent select")];
    expect(selects.map(chosen)).toEqual([READER, ""]);
    expect(chosen(defaultSelect())).toBe(ANSWER);
  });

  test("sets and clears the default, and says when a cleared one was already gone", async () => {
    api.setHostAgentDefault.mockResolvedValue({
      default: { person: "maya@example.com", levelId: ANSWER, levelName: "Answer only" },
    });
    await mount(identity());
    await choose(defaultSelect(), ANSWER);
    expect(api.setHostAgentDefault).toHaveBeenCalledWith(CONNECTION, "maya@example.com", ANSWER);
    expect(host.querySelector(".access-notice")?.textContent).toContain("“Answer only”");
    expect(onChanged).toHaveBeenCalled();

    await mount(identity([MAYA_DEFAULT]));
    api.clearHostAgentDefault.mockRejectedValue(
      Object.assign(new Error("gone"), { status: 404, serverMessage: "not-found" }),
    );
    await choose(defaultSelect(), "");
    expect(api.clearHostAgentDefault).toHaveBeenCalledWith(CONNECTION, "maya@example.com");
    expect(host.querySelector(".access-error")?.textContent).toBe(
      "This connection or its entry no longer exists. The list has been refreshed.",
    );
  });

  test("denies an agent with No access and changes its level in one step", async () => {
    api.setHostAgentLevel.mockResolvedValue({ agent: {} });
    await mount(identity());
    await choose(agentSelect(), "");
    expect(api.setHostAgentLevel).toHaveBeenCalledWith(
      CONNECTION,
      "maya@example.com",
      "instance:agent-a",
      null,
    );
    expect(host.querySelector(".access-notice")?.textContent).toContain("denied any access");
    await choose(agentSelect(), ANSWER);
    expect(api.setHostAgentLevel).toHaveBeenLastCalledWith(
      CONNECTION,
      "maya@example.com",
      "instance:agent-a",
      ANSWER,
    );
  });

  test("asks whether a removed agent gets the default or is denied", async () => {
    const wouldApply = Object.assign(new Error("default"), {
      status: 409,
      serverMessage: "default-would-apply",
    });
    api.revokeHostAgent.mockRejectedValueOnce(wouldApply).mockResolvedValueOnce({ revoked: true });
    await mount(identity([MAYA_DEFAULT]));
    await click(button("Remove"));
    expect(api.revokeHostAgent).toHaveBeenCalledWith("grant-1");
    expect(host.textContent).toContain("Use the default, or deny this agent?");
    await click(button("Use the default"));
    expect(api.revokeHostAgent).toHaveBeenLastCalledWith("grant-1", { fallback: "default" });
    expect(host.querySelector(".access-notice")?.textContent).toContain("now gets the default");

    api.revokeHostAgent.mockRejectedValueOnce(wouldApply);
    api.setHostAgentLevel.mockResolvedValue({ agent: {} });
    await click(button("Remove"));
    await click(button("Deny this agent"));
    expect(api.setHostAgentLevel).toHaveBeenLastCalledWith(
      CONNECTION,
      "maya@example.com",
      "instance:agent-a",
      null,
    );
  });

  test("sets a default for another person only once an email and a level are chosen", async () => {
    api.setHostAgentDefault.mockResolvedValue({ default: { person: "jamie@example.com" } });
    await mount(identity());
    const form = host.querySelector(".access-host-new")!;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    const levelSelect = form.querySelector<HTMLSelectElement>("select")!;
    expect(chosen(levelSelect)).toBe("");
    expect(levelSelect.querySelector("option")?.textContent).toBe("Choose a level");
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(form.querySelector<HTMLInputElement>("input")!, "jamie");
    await choose(levelSelect, ANSWER);
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(form.querySelector<HTMLInputElement>("input")!, "jamie@example.com");
    await settle();
    expect(submit.hasAttribute("disabled")).toBe(false);
  });
});

describe("AccessList with agent hosts", () => {
  test("says a level only agent hosts use is in use, and keeps it from deletion", async () => {
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    const previous = { document: globalThis.document, window: globalThis.window };
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    const root = parsed.document.querySelector("#root") as unknown as HTMLElement;
    try {
      const level = { ...LEVELS[0], rules: [], connectionCount: 0, devices: [] };
      await act(async () => {
        render(
          h(AccessList, {
            entries: [],
            levels: [level],
            overview: { levels: [level], principals: [] },
            hostLevelUses: new Map([[ANSWER, 2]]),
            levelActions: { onEdit: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() },
            connectionActions: { onRename: vi.fn(), onMove: vi.fn(), onRemove: vi.fn() },
          }),
          root,
        );
      });
      expect(root.querySelector(".access-level-empty")?.textContent).toBe(
        "Used only by agent host grants and defaults (2).",
      );
      render(null, root);
    } finally {
      Object.assign(globalThis, previous);
    }
  });
});
