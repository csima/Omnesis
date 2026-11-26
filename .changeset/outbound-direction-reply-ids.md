---
"omnesis": minor
---

Gmail, Slack and Quo documents now carry what a write-only connector needs to answer without a read scope on the provider, and whether the owner already did. Gmail messages gain `direction` (sent or received), `unread`, `archived` and `starred` refreshed on every label change, and the RFC 5322 `messageId`, `inReplyTo` and `references` beside `threadId`. Slack days gain `direction`, `selfMessageCount`, `lastMessageFromSelf`, `lastSelfMessageAt`, the `workspaceId` and `channelId`, every `threadTs` and the ones still `unansweredThreadTs`, and `latestTs`. Quo texts gain `fromSelf` and the `quoNumberId` of the line, beside the conversation id in `threadId` and the number in `quoNumber`. Each field is declared in its source's metadata profile.
