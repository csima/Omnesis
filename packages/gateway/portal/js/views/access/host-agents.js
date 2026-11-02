// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Agent hosts: the connections an agent host calls through for many agents,
// each agent with its own access level for the person it acts for.
//
// Under each bound connection, the agents are grouped by person. Each person
// also has a "Default for other agents" choice: the access level every other
// agent of that host gets when it acts for that person, or no access at all.
// A level given to an agent by name always wins over the default, and the
// connection's own level stays the ceiling of both. A default for a person no
// agent is listed for yet is set from the form below the people.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { clearHostAgentDefault, getHostIdentity, setHostAgentDefault } from "../../api.js";
import { compareNames, errorMessage } from "./shared.js";

const NO_ACCESS = "";

/** Each person a binding names, with the agents granted for them and their default. */
export function hostPeople(binding) {
  const people = new Map();
  const person = (name) => {
    if (!people.has(name)) people.set(name, { person: name, agents: [], default: null });
    return people.get(name);
  };
  for (const agent of binding.agents ?? []) person(agent.person).agents.push(agent);
  for (const entry of binding.defaults ?? []) person(entry.person).default = entry;
  return [...people.values()].sort((left, right) => compareNames(left.person, right.person));
}

function refusalMessage(error) {
  switch (error?.serverMessage) {
    case "inactive-grant":
      return "That access level no longer exists.";
    case "host-not-bound":
      return "This connection is no longer bound to an agent host.";
    case "invalid-selection":
      return "Enter the person as the agent host names them, such as an email address.";
    case "not-found":
      return "This default was already cleared.";
    default:
      return errorMessage(error, "The default could not be saved.");
  }
}

function LevelSelect({ id, value, levels, disabled, onChange, label }) {
  return html`<select
    id=${id}
    class="access-host-select"
    aria-label=${label}
    value=${value}
    disabled=${disabled}
    onChange=${(event) => onChange(event.currentTarget.value)}
  >
    <option value=${NO_ACCESS}>No access</option>
    ${levels.map((level) => html`<option key=${level.id} value=${level.id}>${level.name}</option>`)}
  </select>`;
}

function PersonGroup({ binding, entry, levels, busy, onDefault }) {
  const selectId = `access-host-default-${binding.connectionId}-${entry.person}`;
  return html`<div class="access-level-section access-host-person">
    <h4 class="access-level-subhead">${entry.person} <span class="access-level-count">(${entry.agents.length})</span></h4>
    ${entry.agents.length > 0
      ? html`<ul class="access-host-agents" aria-label=${`Agents acting for ${entry.person}`}>
          ${entry.agents.map((agent) => html`<li key=${agent.id} class="access-host-agent">
            <code>${agent.agent}</code>
            <span class="access-muted">${agent.levelName ?? "Level removed"}</span>
          </li>`)}
        </ul>`
      : null}
    <div class="access-host-default">
      <label for=${selectId}>Default for other agents</label>
      <${LevelSelect}
        id=${selectId}
        label=${`Default for other agents acting for ${entry.person}`}
        value=${entry.default?.levelId ?? NO_ACCESS}
        levels=${levels}
        disabled=${busy}
        onChange=${(levelId) => onDefault(entry.person, levelId)}
      />
    </div>
  </div>`;
}

function NewPersonDefault({ binding, levels, busy, onDefault }) {
  const [person, setPerson] = useState("");
  const [levelId, setLevelId] = useState(levels[0]?.id ?? NO_ACCESS);
  const personId = `access-host-new-person-${binding.connectionId}`;
  const levelSelectId = `access-host-new-level-${binding.connectionId}`;
  return html`<form
    class="access-host-new"
    onSubmit=${async (event) => {
      event.preventDefault();
      if (!person.trim() || !levelId) return;
      if (await onDefault(person.trim(), levelId)) setPerson("");
    }}
  >
    <label for=${personId}>Default for another person</label>
    <input
      id=${personId}
      type="text"
      placeholder="person@example.com"
      value=${person}
      disabled=${busy}
      onInput=${(event) => setPerson(event.currentTarget.value)}
    />
    <select
      id=${levelSelectId}
      class="access-host-select"
      aria-label="Access level for that person's agents"
      value=${levelId}
      disabled=${busy}
      onChange=${(event) => setLevelId(event.currentTarget.value)}
    >
      ${levels.map((level) => html`<option key=${level.id} value=${level.id}>${level.name}</option>`)}
    </select>
    <button type="submit" class="btn-secondary" disabled=${busy || !person.trim() || !levelId}>Set default</button>
  </form>`;
}

/**
 * The connections bound to an agent host, their agents and each person's
 * default. Renders nothing until a connection is bound; the binding itself is
 * made over the API, as the Connect docs describe.
 */
export function HostAgents({ levels, entries }) {
  const [overview, setOverview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);

  async function load() {
    try {
      const loaded = await getHostIdentity();
      setOverview({ bindings: loaded?.bindings ?? [] });
    } catch {
      setOverview({ bindings: [] });
    }
  }

  useEffect(() => { void load(); }, []);

  async function changeDefault(binding, person, levelId) {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setBusy(true);
    try {
      if (levelId === NO_ACCESS) {
        await clearHostAgentDefault(binding.connectionId, person);
        setNotice(`Other agents acting for ${person} now get no access.`);
      } else {
        const saved = await setHostAgentDefault(binding.connectionId, person, levelId);
        const name = saved?.default?.levelName ?? levels.find((level) => level.id === levelId)?.name ?? "";
        setNotice(`Other agents acting for ${saved?.default?.person ?? person} now get “${name}”.`);
      }
      setError("");
      await load();
      return true;
    } catch (failure) {
      setNotice("");
      setError(refusalMessage(failure));
      await load();
      return false;
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  const bindings = overview?.bindings ?? [];
  if (bindings.length === 0) return null;
  return html`<section class="access-host-agents-panel" aria-labelledby="access-host-title">
    <header class="access-host-header">
      <h3 id="access-host-title">Agent hosts</h3>
      <p>Each agent of a host gets the level given to it for the person it acts for. Other agents get that person’s default, never more than the connection’s own level.</p>
    </header>
    ${notice && html`<p class="access-notice" role="status">${notice}</p>`}
    ${error && html`<p class="access-error" role="alert">${error}</p>`}
    ${bindings.map((binding) => {
      const connection = entries.find((entry) => entry.id === binding.connectionId);
      const titleId = `access-host-binding-${binding.connectionId}`;
      return html`<section key=${binding.connectionId} class="access-level-group" aria-labelledby=${titleId}>
        <div class="access-level-head">
          <div class="access-level-title">
            <span class="access-level-kicker" aria-hidden="true">Agent host</span>
            <h3 id=${titleId} class="access-level-name">${connection?.name ?? "Connection"}</h3>
            <span class="access-host-issuer">${binding.issuer}</span>
          </div>
        </div>
        <div class="access-level-body">
          ${hostPeople(binding).map((entry) => html`<${PersonGroup}
            key=${entry.person}
            binding=${binding}
            entry=${entry}
            levels=${levels}
            busy=${busy}
            onDefault=${(person, levelId) => changeDefault(binding, person, levelId)}
          />`)}
          ${levels.length > 0
            ? html`<${NewPersonDefault}
                binding=${binding}
                levels=${levels}
                busy=${busy}
                onDefault=${(person, levelId) => changeDefault(binding, person, levelId)}
              />`
            : null}
        </div>
      </section>`;
    })}
  </section>`;
}
