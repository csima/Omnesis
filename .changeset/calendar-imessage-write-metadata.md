---
"omnesis": minor
---

Google Calendar and Apple Messages documents now carry what a write-only connector needs to act on an event or a conversation without a read scope, and whether the owner already did. Calendar events gain `eventId` beside the calendar-qualified external id, `recurringEventId`, `etag`, `sequence`, the owner's `selfResponseStatus`, `organizerIsSelf`, `transparency` and `visibility`; a cancelled event is still removed from the index rather than kept. Messages conversations gain `chatGuid`, `selfMessageCount`, `lastMessageFromSelf`, `lastSelfMessageAt`, `unreadCount`, `lastReadAt` and per-message `guid`, `handleId`, `fromSelf`, `isRead`, `isDelivered`, `replyToGuid`, `threadOriginatorGuid`, `dateEdited` and `dateRetracted`, read from newer chat.db columns only where the database has them, and the `rcs` service is declared beside iMessage and SMS. Each field is declared in its source's metadata profile.
