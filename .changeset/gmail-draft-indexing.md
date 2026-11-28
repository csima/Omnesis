---
"omnesis": minor
---

Gmail now indexes the owner's unsent drafts, so a write-only connector can see a live draft, including edits made by hand in Gmail, without a Gmail read scope. Each active draft (up to 500) is one document with the external id `gmail-draft:<draftId>`, distinct from the message id the mail takes once sent, and carries `extra.isDraft: true`, `extra.draftId`, `threadId`, the RFC 5322 `messageId`, `inReplyTo` and `references`, `direction: sent` and the recipients, subject and body. An edited draft replaces its document; a draft that is sent or discarded is deleted from the index on the next sync. A mailbox that refuses drafts (403/404) keeps syncing its mail. `isDraft` and `draftId` are declared in the Gmail metadata profile and are absent on every other message.
