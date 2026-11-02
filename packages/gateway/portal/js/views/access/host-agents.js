// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Agent hosts: the connections an agent host calls through for many agents,
// each agent with its own access level for the person it acts for.
//
// Under each bound connection, the agents are grouped by person. Each agent
// has a level or No access, which denies it even where the person's default
// would admit it, and can be removed. Each person also has a "Default for
// other agents" choice: the level every agent not listed gets when it acts for
// that person, or no access at all. Removing an agent while its person has a
// default would hand it that default, so the page asks which is meant: the
// default, or denying the agent. A default for a person no agent is listed for
// yet is set from the form below the people.
//
// The host identity is loaded by the Access view, which also reads it to say
// which levels only agent hosts use; `onChanged` asks it to load again.

import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";

import {
  clearHostAgentDefault,
  revokeHostAgent,
  setHostAgentDefault,
  setHostAgentLevel,
} from "../../api.js";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { compareNames, errorMessage } from "./shared.js";

const NO_ACCESS = "";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/** Whether the owner typed an email address, the only person a default is set for. */
export function isPersonEmail(value) {
  return EMAIL_PATTERN.test(value.trim());
}

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

/** How many agent grants and defaults of every bound host use each level. */
export function hostLevelUses(hostIdentity) {
  const uses = new Map();
  for (const binding of hostIdentity?.bindings ?? []) {
    for (const entry of [...(binding.agents ?? []), ...(binding.defaults ?? [])]) {
      if (entry.levelId) uses.set(entry.levelId, (uses.get(entry.levelId) ?? 0) + 1);
    }
  }
  return uses;
}

function refusalMessage(error, fallback) {
  switch (error?.serverMessage) {
    case "inactive-grant":
      return "That access level no longer exists.";
    case "host-not-bound":
      return "This connection is no longer bound to an agent host.";
    case "invalid-selection":
      return "Enter the person as an email address.";
    case "not-found":
      return "This connection or its entry no longer exists. The list has been refreshed.";
    default:
      return errorMessage(error, fallback);
  }
}

function LevelSelect({ id, value, levels, disabled, onChange, label, placeholder = "No access" }) {
  return html`<select
    id=${id}
    class="access-host-select"
    aria-label=${label}
    value=${value}
    disabled=${disabled}
    onChange=${(event) => onChange(event.currentTarget.value)}
  >
    <option value=${NO_ACCESS}>${placeholder}</option>
    ${levels.map((level) => html`<option key=${level.id} value=${level.id}>${level.name}</option>`)}
  </select>`;
}

function AgentRow({ agent, levels, busy, onLevel, onRemove }) {
  return html`<li class="access-host-agent">
    <code>${agent.agent}</code>
    <span class="access-host-agent-actions">
      <${LevelSelect}
        label=${`Access level of ${agent.agent} acting for ${agent.person}`}
        value=${agent.levelId ?? NO_ACCESS}
        levels=${levels}
        disabled=${busy}
        onChange=${(levelId) => onLevel(agent, levelId)}
      />
      <button type="button" class="btn-secondary access-host-remove" disabled=${busy} onClick=${() => onRemove(agent)}>Remove</button>
    </span>
  </li>`;
}

function PersonGroup({ binding, entry, levels, busy, onDefault, onLevel, onRemove }) {
  const selectId = `access-host-default-${binding.connectionId}-${entry.person}`;
  return html`<div class="access-level-section access-host-person">
    <h4 class="access-level-subhead">${entry.person} <span class="access-level-count">(${entry.agents.length})</span></h4>
    ${entry.agents.length > 0
      ? html`<ul class="access-host-agents" aria-label=${`Agents acting for ${entry.person}`}>
          ${entry.agents.map((agent) => html`<${AgentRow}
            key=${agent.id}
            agent=${agent}
            levels=${levels}
            busy=${busy}
            onLevel=${onLevel}
            onRemove=${onRemove}
          />`)}
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
  const [levelId, setLevelId] = useState(NO_ACCESS);
  const personId = `access-host-new-person-${binding.connectionId}`;
  const ready = isPersonEmail(person) && levelId !== NO_ACCESS;
  return html`<form
    class="access-host-new"
    onSubmit=${async (event) => {
      event.preventDefault();
      if (!ready) return;
      if (await onDefault(person.trim(), levelId)) {
        setPerson("");
        setLevelId(NO_ACCESS);
      }
    }}
  >
    <label for=${personId}>Default for another person</label>
    <input
      id=${personId}
      type="email"
      placeholder="person@example.com"
      value=${person}
      disabled=${busy}
      onInput=${(event) => setPerson(event.currentTarget.value)}
    />
    <${LevelSelect}
      label="Access level for that person's other agents"
      value=${levelId}
      levels=${levels}
      disabled=${busy}
      placeholder="Choose a level"
      onChange=${setLevelId}
    />
    <button type="submit" class="btn-secondary" disabled=${busy || !ready}>Set default</button>
  </form>`;
}

/**
 * The connections bound to an agent host, their agents and each person's
 * default. Renders nothing until a connection is bound; the binding itself is
 * made over the API, as the Connect docs describe.
 */
export function HostAgents({ hostIdentity, levels, entries, onChanged = async () => {} }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // The agent whose removal would hand it its person's default, while the
  // owner chooses between the default and denying it.
  const [fallbackChoice, setFallbackChoice] = useState(null);
  const inFlightRef = useRef(false);

  /** Runs one change, says what it did, and reloads the list either way. */
  async function change(action, failure) {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const said = await action();
      setError("");
      setNotice(said);
      return true;
    } catch (thrown) {
      if (thrown?.serverMessage === "default-would-apply") throw thrown;
      setNotice("");
      setError(refusalMessage(thrown, failure));
      return false;
    } finally {
      inFlightRef.current = false;
      setBusy(false);
      await onChanged();
    }
  }

  const levelName = (levelId) => levels.find((level) => level.id === levelId)?.name ?? "";

  const changeDefault = (binding, person, levelId) =>
    change(async () => {
      if (levelId === NO_ACCESS) {
        await clearHostAgentDefault(binding.connectionId, person);
        return `Other agents acting for ${person} now get no access.`;
      }
      const saved = await setHostAgentDefault(binding.connectionId, person, levelId);
      return `Other agents acting for ${saved?.default?.person ?? person} now get “${saved?.default?.levelName ?? levelName(levelId)}”.`;
    }, "The default could not be saved.");

  const changeLevel = (binding, agent, levelId) =>
    change(async () => {
      await setHostAgentLevel(binding.connectionId, agent.person, agent.agent, levelId || null);
      return levelId === NO_ACCESS
        ? `${agent.agent} is denied any access for ${agent.person}.`
        : `${agent.agent} now gets “${levelName(levelId)}” for ${agent.person}.`;
    }, "The agent's access could not be saved.");

  async function remove(binding, agent) {
    try {
      await change(async () => {
        await revokeHostAgent(agent.id);
        return `${agent.agent} removed. It now gets no access for ${agent.person}.`;
      }, "The agent could not be removed.");
    } catch {
      setFallbackChoice({ binding, agent });
    }
  }

  async function chooseFallback(useDefault) {
    const choice = fallbackChoice;
    setFallbackChoice(null);
    if (!choice) return;
    const { binding, agent } = choice;
    if (useDefault) {
      await change(async () => {
        await revokeHostAgent(agent.id, { fallback: "default" });
        return `${agent.agent} removed. It now gets the default for ${agent.person}.`;
      }, "The agent could not be removed.");
    } else {
      await changeLevel(binding, agent, NO_ACCESS);
    }
  }

  const bindings = hostIdentity?.bindings ?? [];
  if (bindings.length === 0) return null;
  return html`<section class="access-host-agents-panel" aria-labelledby="access-host-title">
    <header class="access-host-header">
      <h3 id="access-host-title">Agent hosts</h3>
      <p>Each agent of a host gets the level given to it for the person it acts for, or no access. Other agents get that person’s default, never more than the connection’s own level.</p>
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
            onLevel=${(agent, levelId) => changeLevel(binding, agent, levelId)}
            onRemove=${(agent) => remove(binding, agent)}
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
    <${ConfirmModal}
      open=${Boolean(fallbackChoice)}
      title="Use the default, or deny this agent?"
      body=${fallbackChoice
        ? html`<p>${`${fallbackChoice.agent.person} has a default for other agents. Removing ${fallbackChoice.agent.agent} would give it that default.`}</p>`
        : ""}
      confirmLabel="Deny this agent"
      destructive
      secondaryLabel="Use the default"
      onConfirm=${() => chooseFallback(false)}
      onSecondary=${() => chooseFallback(true)}
      onCancel=${() => setFallbackChoice(null)}
    />
  </section>`;
}
