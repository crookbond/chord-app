# CHORD — Spec Addendum — Document Permissions

> Upload model · Permission levels · AI enforcement · Document library

> _Imported from `Chord_DocPerms_concise.docx` (source docx is gitignored). Treat as **reference, not contract** — see [README.md](./README.md)._

# D. Document Permissions

> The group is the unit of access. Every member of a group has full access to every document shared with that group — no per-person or per-role filters. If you want to restrict a document to a subset of people, use a group that contains only those people.

## D.1 Permission Levels

| Level | How set | Who can view/query | Vector namespace | Default? |
| --- | --- | --- | --- | --- |
| Private | No action at upload (or explicit choice) | Uploader only | user:{persona_id} | Yes |
| Group | Uploader selects one or more of their Chord groups | All members of each selected group, equally | group:{group_id} per selection | No |

> Default is Private. The permission picker appears on every upload, pre-checked to Private. Sharing is always explicit.

## D.2 Group Mapping

The picker shows the uploader's own Chord groups only. John in 'Doe family' and 'Seattle trip' sees exactly those two options plus Private. He can select multiple groups for one document. Access within each group is uniform — no member receives more or less than another.

## D.3 Upload Flow

| Step | Action |
| --- | --- |
| 1 — Select file | File picker opens from attach icon in app. |
| 2 — Permission picker | Bottom sheet: Private (pre-checked) · [each of uploader's groups]. Multi-select allowed. |
| 3 — Confirm | Tap Upload. Permissions set. Upload begins. |
| 4 — Index | Document chunked, embedded, written to each selected namespace. |
| 5 — Confirm | 'Indexed [filename] · Visible to: [groups]'. Scope icon on document tile. |

> The picker always appears. Never skipped, even on re-uploads.

## D.4 Enforcement

### Index time — writing embeddings

- Private → user:{persona_id} namespace only
- Group → group:{group_id} namespace for each selected group
- Multi-group → independent embedding set per namespace

### Query time — namespace selection

- Personal AI chat → search user:{me} + all group:{group_id} the user is a member of
- WhatsApp @Chord query → search group:{this_group} only
- No role filters. All group members search the same namespaces.

## D.5 Enforcement Examples

| Document | Permission | Who asks | AI behaviour |
| --- | --- | --- | --- |
| Passport scan | Private | John (uploader) | Answers — in personal namespace |
| Passport scan | Private | Alice | No answer — doc not in any shared namespace |
| Flight confirmation | Doe family | Any family member | Answers — all members equal |
| Trip itinerary | Seattle trip | John (participant) | Answers |
| Trip itinerary | Seattle trip | Member not in Seattle trip group | No answer |
| Medical form | Doe family | Ben (Teen, group member) | Answers — full group access |

> Chord never reveals a restricted document exists. Response is always 'I don't have that information' — never 'you don't have access'.

## D.6 Document Library

- Own uploads — all permission levels including private
- Others' uploads — only if user is a member of a group the doc was shared with
- Scope icon on each tile: 🔒 private · 🌐 group

## D.7 Changing Permissions

| Change | Embedding action | Latency |
| --- | --- | --- |
| Private → Group | Embeddings copied to group namespace | < 5s |
| Group → Private | Embeddings removed from group namespace. Group members lose access immediately. | < 5s |
| Add a group | Embeddings added to new namespace | < 5s |
| Remove a group | Embeddings removed from that namespace | < 5s |
| Delete document | Embeddings removed from all namespaces. No recovery. | < 5s |

> Only the uploader can change permissions or delete. Admins have no override.

## D.8 WhatsApp Ingestion Defaults

| Forwarded to | Permission applied |
| --- | --- |
| WhatsApp group (Chord is member) | That group — all members |
| Chord's WhatsApp DM | Private — uploader only |

Confirmation appends: 'Visible to: Doe family. Change in app →'

## D.9 Cross-Group Fallback Search

When a query in group B returns no results, Chord silently searches the querying user's own documents across their other group namespaces.

| Step | Behaviour |
| --- | --- |
| 1 — Primary search | Query runs against group B namespace. Result found → answer normally. Done. |
| 2 — Fallback | No result in group B. Silently search uploader's other group namespaces. |
| 3 — Found elsewhere | Answer the question. Append: 'Found in [doc] · Doe family — not shared with Seattle trip. Share it?' One-tap in app / 'Reply share' in WhatsApp. |
| 4 — User shares | Permissions updated. Embeddings written to group B namespace. |
| 5 — User ignores | Query answered. No change. Prompt not repeated for this (doc, group) pair. |
| 6 — Nothing anywhere | 'I don't have that information.' No mention of other groups. |

> Fallback searches the uploader's own docs only — never other users' documents, even for an admin.

## D.10 Schema

```
-- documents table additions
documents
  + uploaded_by        uuid FK → personas
  + is_private         boolean DEFAULT true

-- One row per (document, group) pair. No role_filter — access is uniform per group.
document_permissions
  permission_id   uuid PK
  doc_id          uuid FK → documents
  group_id        uuid FK → groups
  granted_at      timestamp
  granted_by      uuid FK → personas

-- Vector namespace convention
-- Private:     namespace = 'user:{persona_id}'
-- Group:       namespace = 'group:{group_id}'
-- Multi-group: independent embedding set per namespace
```

## D.11 Edge Cases

| Scenario | Behaviour |
| --- | --- |
| Uploader leaves group after sharing | Doc remains accessible to that group. Uploader retains ownership. |
| Group deleted | Docs scoped only to that group revert to private. Multi-group docs retain other permissions. |
| Uploader account deleted | Docs in group namespaces remain, ownership transfers to admin. Private docs deleted. |
| Teen uploads a document | Same flow as adult. |
| Child (under 13) | No upload capability. No app login. |
| Want adults-only access | Create an adults-only group. Share the doc there. No role filter needed. |

