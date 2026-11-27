// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The search page's source chips are edits to the query text: a chip adds or
 * removes its `source:<type>` token and is selected while the query holds
 * one. These cases pin the text edits, which every client offering the chips
 * makes the same way. All example data is invented.
 */

import { describe, expect, test } from "vitest";
import {
  addSourceFilter,
  buildSourceChips,
  findSourceTokens,
  hasSourceFilter,
  removeSourceFilter,
  toggleSourceFilter,
  // @ts-expect-error — portal modules are plain JS with no type declarations.
} from "./search-source-filter.js";

describe("finding source tokens", () => {
  test("finds a token at the start, in the middle and at the end", () => {
    expect(findSourceTokens("source:web budget source:gmail review source:notes").map((t: { value: string }) => t.value)).toEqual([
      "web",
      "gmail",
      "notes",
    ]);
  });

  test("reads a quoted value without its quotes", () => {
    expect(findSourceTokens('budget source:"web"')).toEqual([{ start: 7, end: 19, value: "web" }]);
  });

  test("ignores source: inside a quoted phrase", () => {
    expect(findSourceTokens('"notes source:web" review')).toEqual([]);
    expect(findSourceTokens('with:"Maya source:web Reeves" source:gmail').map((t: { value: string }) => t.value)).toEqual(["gmail"]);
  });

  test("an unpaired quote does not hide the tokens after it", () => {
    expect(findSourceTokens('"quarterly source:web').map((t: { value: string }) => t.value)).toEqual(["web"]);
  });

  test("only matches source: as a whole word", () => {
    expect(findSourceTokens("resource:web opensource:gmail")).toEqual([]);
  });

  test("an empty or missing query has none", () => {
    expect(findSourceTokens("")).toEqual([]);
    expect(findSourceTokens(undefined)).toEqual([]);
  });
});

describe("whether a chip is selected", () => {
  test("matches the bare type case-insensitively", () => {
    expect(hasSourceFilter("budget SOURCE:Web", "web")).toBe(true);
    expect(hasSourceFilter("budget source:web", "WEB")).toBe(true);
    expect(hasSourceFilter('budget source:"web"', "web")).toBe(true);
  });

  test("a different type, a single account or a quoted phrase does not select it", () => {
    expect(hasSourceFilter("source:webmail", "web")).toBe(false);
    expect(hasSourceFilter("source:gmail:maya@example.com", "gmail")).toBe(false);
    expect(hasSourceFilter('"source:web"', "web")).toBe(false);
    expect(hasSourceFilter("", "web")).toBe(false);
  });
});

describe("adding a source token", () => {
  test("appends the token after the query", () => {
    expect(addSourceFilter("budget review", "web")).toBe("budget review source:web");
  });

  test("a blank query becomes just the token", () => {
    expect(addSourceFilter("", "web")).toBe("source:web");
    expect(addSourceFilter("   ", "web")).toBe("source:web");
  });

  test("trailing spaces do not double up", () => {
    expect(addSourceFilter("budget  ", "web")).toBe("budget source:web");
  });

  test("keeps quoted values and other operators", () => {
    expect(addSourceFilter('with:"maya reeves" after:"last week" #work', "gmail")).toBe(
      'with:"maya reeves" after:"last week" #work source:gmail',
    );
  });
});

describe("removing a source token", () => {
  test("removes a token in the middle and leaves one space", () => {
    expect(removeSourceFilter("budget source:web review", "web")).toBe("budget review");
  });

  test("removes a token at the start or the end without stray spaces", () => {
    expect(removeSourceFilter("source:web budget", "web")).toBe("budget");
    expect(removeSourceFilter("budget source:web", "web")).toBe("budget");
    expect(removeSourceFilter("source:web", "web")).toBe("");
  });

  test("collapses the extra spaces around the token", () => {
    expect(removeSourceFilter("budget   source:web   review", "web")).toBe("budget review");
  });

  test("removes only that type's tokens, whatever their case", () => {
    expect(removeSourceFilter("source:gmail budget Source:WEB source:notes", "web")).toBe("source:gmail budget source:notes");
  });

  test("removes every copy of the token", () => {
    expect(removeSourceFilter("source:web budget source:web", "web")).toBe("budget");
  });

  test("removes a quoted token", () => {
    expect(removeSourceFilter('budget source:"web" review', "web")).toBe("budget review");
  });

  test("keeps quoted phrases, other operators and their spacing", () => {
    expect(removeSourceFilter('with:"maya  reeves" source:web after:"last week" type:email', "web")).toBe(
      'with:"maya  reeves" after:"last week" type:email',
    );
  });

  test("leaves a source: inside a quoted phrase and a single-account token alone", () => {
    expect(removeSourceFilter('"notes source:web" source:web', "web")).toBe('"notes source:web"');
    expect(removeSourceFilter("source:gmail:maya@example.com source:gmail", "gmail")).toBe(
      "source:gmail:maya@example.com",
    );
  });

  test("a query without the token comes back unchanged", () => {
    expect(removeSourceFilter("budget  review", "web")).toBe("budget  review");
  });
});

describe("toggling a chip", () => {
  test("adds the token when it is missing and removes it when present", () => {
    const added = toggleSourceFilter("budget", "web");
    expect(added).toBe("budget source:web");
    expect(toggleSourceFilter(added, "web")).toBe("budget");
  });

  test("toggling two chips ORs them and either comes off alone", () => {
    const both = toggleSourceFilter(toggleSourceFilter("budget", "web"), "gmail");
    expect(both).toBe("budget source:web source:gmail");
    expect(toggleSourceFilter(both, "web")).toBe("budget source:gmail");
  });

  test("a token typed in another case toggles off", () => {
    expect(toggleSourceFilter("Source:Web budget", "web")).toBe("budget");
  });
});

describe("building the chip list", () => {
  const label = (type: string) => ({ gmail: "Gmail", web: "Web", things: "Things", trial: "Trial" })[type] ?? type;

  test("folds accounts of one type into one chip and sums their counts", () => {
    const chips = buildSourceChips({
      sources: [
        { id: "gmail:maya@example.com", type: "gmail" },
        { id: "gmail:jamie@example.org", type: "gmail" },
        { id: "web", type: "web" },
      ],
      documentCounts: { "gmail:maya@example.com": 3, "gmail:jamie@example.org": 4, web: 9 },
      label,
    });
    expect(chips).toEqual([
      { type: "web", label: "Web", count: 9 },
      { type: "gmail", label: "Gmail", count: 7 },
    ]);
  });

  test("orders by count, then by label, and drops types with no documents", () => {
    const chips = buildSourceChips({
      sources: [
        { id: "things:local", type: "things" },
        { id: "web", type: "web" },
        { id: "gmail:maya@example.com", type: "gmail" },
      ],
      documentCounts: { "things:local": 5, web: 0, "gmail:maya@example.com": 5 },
      label,
    });
    expect(chips.map((c: { type: string }) => c.type)).toEqual(["gmail", "things"]);
  });

  test("without counts every type is offered, by label", () => {
    const chips = buildSourceChips({
      sources: [{ id: "web" }, { id: "things:local" }, { id: "gmail:maya@example.com" }],
      documentCounts: null,
      label,
    });
    expect(chips.map((c: { type: string }) => c.type)).toEqual(["gmail", "things", "web"]);
  });

  test("hides experimental types unless experimental mode is on", () => {
    const input = {
      sources: [
        { id: "trial:one", type: "trial" },
        { id: "web", type: "web" },
      ],
      documentCounts: { "trial:one": 2, web: 1 },
      isExperimental: (type: string) => type === "trial",
      label,
    };
    expect(buildSourceChips({ ...input, experimental: false }).map((c: { type: string }) => c.type)).toEqual(["web"]);
    expect(buildSourceChips({ ...input, experimental: true }).map((c: { type: string }) => c.type)).toEqual(["trial", "web"]);
  });

  test("no sources, no chips", () => {
    expect(buildSourceChips({ sources: [] })).toEqual([]);
    expect(buildSourceChips({ sources: null })).toEqual([]);
  });
});
