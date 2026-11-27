---
"omnesis": minor
---

Structured metadata for Google Contacts, Google Drive, GitHub (threads and commits) and Notion.

- Google Contacts: etag, resourceName, starred, groupResourceNames.
- Google Drive: fileId, parents, driveId, headRevisionId, version, ownedByMe, canEdit, starred, lastModifyingUserIsMe.
- GitHub threads: nodeId, headSha, stateReason, assignees, requestedReviewers, bounded comment, review, review-comment and review-thread ids, authorIsSelf, reviewRequestedFromSelf, mentionsSelf. Commits: authorIsSelf. Thread documents re-render once (render version 5).
- Notion: parentId, dataSourceId, lastEditedTime, archived, inTrash, createdByUserId, lastEditedByUserId, createdBySelf, lastEditedBySelf.
- Notion fix: database rows parented by a data source no longer lose notionDatabaseId.
