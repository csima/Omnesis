# Slack provider

Two sources share a read-only client, daily normalizer and sync engine:
`slack` (official user OAuth token) and `slack-session` (experimental, Mac only).
Session mode requires `OMNESIS_EXPERIMENTAL=1` on both the gateway and the collector.

## Official token

Create an internal app at https://api.slack.com/apps, open OAuth & Permissions,
and add **user** scopes: `channels:read`, `channels:history`, `groups:read`,
`groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`,
`users:read`, `users:read.email`, `usergroups:read`. Install it in the workspace,
then run `omnesis sources add slack` and supply the User OAuth Token.
The account key is `<workspace-id>-<user-id>`; two users in one workspace remain
separate. Tokens with write permissions should not be granted to this app.
The client refuses write methods regardless of the grant's permissions.
Official tokens use Omnesis standard wrapped credential storage on the collector.
They never enter source config, cursors, indexed content or logs. Session tokens
and cookies remain memory-only under the contract below.

## Local session contract

Run `omnesis sources add slack-session` **on the collector Mac**. Select the
installed, reviewed `slack-grab` package root and its Python interpreter (with
its reviewed dependencies already installed). These are paths, not credentials.
The setup lists directory-only source discovery and defaults to every source;
the operator may narrow the selection. Supply a source's exact User-Agent only
when it is not unambiguous in that source's store. Never guess it.

`session.ts` spawns that interpreter with `-I -B -c <adapter>` and an allowlisted
environment (`HOME`, `PATH`, `LANG`, `LC_*`, `TMPDIR`, `PYTHONDONTWRITEBYTECODE`),
so no collector secret reaches it, and sends a bounded JSON request through a
private stdin pipe. The adapter imports `slacklib.grab`
from the selected root. It calls `sources()` for metadata-only discovery and
`collect()` once per selected source. All store reading, size limits (128 MiB),
read-only SQLite access, protection checks, cookie handling and Keychain prompts
remain in the reviewed helper. Omnesis has no store parser or decryption code.
Only the person answers Keychain prompts; nothing changes Keychain ACLs,
automates password entry, enables remote debugging or weakens encryption.

The reply is one JSON object on a private stdout pipe, capped at 1 MiB:
`{sessions:[{source,user_agent,cookie,workspaces:[{team_id,user_id,name,url,token}]}],failedSources:[sourceId]}`.
This is the helper's version-1 session shape, nested without its host upload.
The adapter never calls `handoff()`, `main()`, or the agent host; stderr is not
retained. Child errors and invalid JSON produce a fixed, credential-free error.
The provider validates fields, rejects headers containing newlines, reports a
workspace on a host other than `<name>.slack.com` or
`<name>.enterprise.slack.com` as a failure while the others continue, prefers
desktop per workspace/user, and validates both IDs using `auth.test`. Session requests go only to the validated workspace HTTPS host,
never follow redirects, and carry the exact source User-Agent.

Every new sync cycle reruns collection. A resumed cycle after process restart
also recollects. A failure other than a rate limit discards the in-memory
client; a rate-limited page keeps it, and its retry replays the reads that
page already completed instead of repeating them. At cycle completion,
disposal, or failure, references to the session are dropped. JavaScript does
not promise secure memory zeroing. Run the collector with core dumps disabled
(`ulimit -c 0`); do not enable a process heap/crash dump facility for it.
The helper subprocess disables its own core dumps. Tokens and cookies never
enter Omnesis credentials, source config, cursor, documents, analytics, status,
logs, error causes or the gateway. There is no network handoff endpoint or
reusable session file. Ordinary indexed Slack content still follows the
collector's configured gateway transport.

The only session file is `slack-session/<workspace-user>/connection.json`: helper selection,
non-secret User-Agents, and public workspace/user identities. Removing one
account removes only its identity; signing out keeps indexed history. An
unavailable sign-in or failed `auth.test` marks that account needs-auth, and the
next scheduled cycle recollects, so re-login needs no command. Other accounts
continue independently. A failed source never supplies deletion evidence.

The reviewed helper must be available on the Mac. Setup and sync do not fetch,
install, modify, or silently replace it. New sign-ins for **existing** accounts
resume automatically. Connecting an entirely new workspace/user requires Add
source again so the collector registers its new account row.

## Sync and reconciliation

The default interval is 15 minutes. A conversation's first import starts at the
UTC midnight 180 days (configurable `historyDays`) before the cycle that first
sees it, is paged by UTC day, and survives restarts. This is an import boundary,
never a retention policy. A data cutoff applies from the start of its UTC day.
Every conversation retains its newest Slack timestamp. Conversations come from
`users.conversations`, so only the user's own are listed; archived ones are
skipped. File names and links are indexed; file contents are not
downloaded. Daily document previews are capped at 200,000 characters with an
explicit truncation notice; full messages remain in analytics. Threads are attached to their root's UTC day.

Between daily reconciliations, each cycle first reads the last 14 days of
root messages in one paged history call and compares them with the indexed
rows. A conversation with no new, edited or deleted root and no changed
`latest_reply` is done for the cycle. Otherwise the cycle re-reads the trailing
seven-day window, expanded to whole document days, and every day after the last
fully read one if the collector was offline longer. Threads
with roots in 14 days are rechecked; roots aged 7–14 days use indexed root rows
rather than a second history scan. Once per day a 30-day history window is
reconciled. A root's changed `latest_reply` triggers a full reply read, even
when that root is older than 14 days but inside the re-read window. Changes
older than the 30-day reconciliation horizon are out of scope; edits to replies
in an otherwise unchanged conversation wait for the daily reconciliation. The
initial 180-day limit also applies to replies on the initial import. A
conversation that fails the same way on three consecutive attempts is skipped
for that cycle with a recorded issue, keeping its rows, so it cannot block the
rest of the account.

Only complete history and reply reads can replace a day's message rows or
remove its document. Partial, malformed, forbidden, rate-limited, repeated-
cursor or failed reads preserve the installed checkpoint and give no deletion
evidence. All required document and table writes precede checkpoint promotion;
replays are idempotent. Empty confirmed days remove their prior daily document.
There is no whole-account snapshot claim over this bounded read.

Requests are paced per method: Tier 2 methods (`users.list`,
`users.conversations`, `usergroups.list`) about 20 a minute, Tier 3 about 50 a
minute, with 200-item pages. A 429 returns `Retry-After` and an account quota to
the collector scheduler without an internal retry loop. This assumes an
internal customer-built app. Commercially distributed, non-Marketplace apps
can have one history/replies request per minute and 15-object page caps; their
bootstrap may take much longer, and a 15-minute freshness target cannot be
promised. Session endpoints have no published stability or quota contract.

## Unread queries

The examples below use official-token tables. For session mode, replace the
`slack_` prefix with `slack_session_` in every table name. Each table is scoped
by the workspace/user account, and the two modes cannot overwrite each other.

Missing conversation markers mean unknown coverage, never all unread. Session
markers come from `client.counts`; official markers use `conversations.info`
only for DMs, group DMs and conversations active in the past 30 days. Only
successfully fetched rows are upserted. A partial response never erases another
conversation's last valid marker. Inspect `observed_at` before treating a count
as current. Where returned, a thread marker overrides the conversation marker.

```sql
WITH unread AS (
  SELECT m.*, p.kind, p.observed_at
  FROM slack_messages m JOIN slack_read_positions p
    USING (source_account_id, conversation_id)
  WHERE m.user_id <> m.self_id
    AND CAST(m.ts AS DECIMAL(20,6)) > CAST(
      CASE WHEN m.ts <> m.thread_ts
        THEN COALESCE(json_extract_string(p.thread_reads, '/' || m.thread_ts), p.last_read)
        ELSE p.last_read END
      AS DECIMAL(20,6))
)
SELECT source_account_id, conversation_id, kind, count(*) AS unread,
       max(observed_at) AS markers_observed_at
FROM unread GROUP BY ALL;
```

For mentions, use the same `unread` CTE and add:

```sql
SELECT * FROM unread m
WHERE contains(m.text, '<@' || m.self_id || '>')
   OR contains(m.text, '<!here>') OR contains(m.text, '<!channel>')
   OR contains(m.text, '@here') OR contains(m.text, '@channel')
   OR EXISTS (
     SELECT 1 FROM slack_usergroups g
     WHERE g.source_account_id = m.source_account_id
       AND (contains(m.text, '<!subteam^' || g.group_id || '>')
         OR contains(m.text, '<!subteam^' || g.group_id || '|'))
   );
```

Membership comes from `usergroups.list` with `include_users=true`. Slack's
actual displayed DM unread counts and mention badges must be compared within
one cycle during Mac acceptance; synthetic arithmetic alone does not establish
UI parity. No method moves a read marker.

## Policy and rollout

This uses the user's own session; workspace policies still apply and some
admins prohibit it. Session mode uses unpublished `client.counts` and is not an
official Slack integration. Maintainer review must explicitly address Slack's
Developer Policy prohibition on unpublished APIs. Official-token mode also
needs review of applicable organizational consent, data retention and API
terms before upstream distribution. A local app is not an exemption from
workspace rules. Slack data must not train models.

Keep the existing Slack reader authoritative until a week of side-by-side
comparison satisfies the requirements. This PR does not change Pepper, retire
agent reads, send messages, deploy, or open an upstream PR. Upstream official
mode first; session mode separately. The contributor signs `CLA.md` before an
upstream PR.
