---
"omnesis": patch
---

Kondo conversation documents now carry what a write-only connector needs to answer a LinkedIn chat, and whether the owner already did: the `threadKey` of the chat, the `inboxProfileId` it was read as, the `participantProfileIds` of the other members, and `direction`, `selfMessageCount`, `lastMessageFromSelf` and `lastSelfMessageAt` for the day. Kondo's read-only tools report no unread, snooze, draft or pending-invite state, so none is emitted. Each field is declared in the source's metadata profile.
