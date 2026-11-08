# Spec notes

Bundled API description = the published docs spec (`src/openapi.json`, see `docs/SPEC_SOURCE.md`)
plus a hand-written overlay (`src/openapi.overlay.json`) for helpdesk routes the docs spec lacks.
Reference version: Libredesk **v2.9.2** (route table `cmd/handlers.go`, handlers in `cmd/*.go`,
models in `internal/*/models`). The code wins over the docs when they disagree.

## Overlay operations (10)

Each carries `x-source` (file + handler at v2.9.2) and a request/response shape read from the Go code.

| Operation | Handler | Source file |
|---|---|---|
| `GET /api/v1/conversations/sidebar-counts` | `handleGetSidebarCounts` | `cmd/conversation.go` |
| `GET /api/v1/drafts` | `handleGetAllDrafts` | `cmd/draft.go` |
| `POST /api/v1/conversations/{uuid}/draft` | `handleUpsertConversationDraft` | `cmd/draft.go` |
| `DELETE /api/v1/conversations/{uuid}/draft` | `handleDeleteConversationDraft` | `cmd/draft.go` |
| `POST /api/v1/conversations/{uuid}/macros/{id}/apply` | `handleApplyMacro` | `cmd/macro.go` |
| `GET /api/v1/inboxes/{id}` | `handleGetInbox` | `cmd/inboxes.go` |
| `GET /api/v1/macros` | `handleGetMacros` | `cmd/macro.go` |
| `GET /api/v1/macros/compact` | `handleGetMacrosCompact` | `cmd/macro.go` |
| `GET /api/v1/macros/search` | `handleSearchMacros` | `cmd/macro.go` |
| `GET /api/v1/macros/{id}` | `handleGetMacro` | `cmd/macro.go` |

Macro reads (shapes from `internal/macro/models` and `internal/macro/queries.sql`): `/macros` and
`/macros/{id}` return the full `Macro` (with `message_content`); `/macros/compact` and `/macros/search`
return `MacroCompact` (`has_message_content` instead of the text). `/macros/compact` needs
`macros:manage` and takes `q`, `page`, `page_size` (0 or absent: every match, at most 500 per page);
`/macros/search` is open to any agent, keeps only the macros that agent may apply, takes `q` and `view`
(`replying`, `starting_conversation` or `adding_private_note`, anything else is a 400) and returns at
most 30, most used first. `GET /macros/{id}` does not check the macro's visibility. `user_id` and
`team_id` are serialised as strings (`json:",string"`) or null. Each action carries `display_value`
(names resolved server-side), null when it cannot be resolved.

Most routes named in the brief (mark-unread, mentioned, page-visits, transcript, conversation and
contact custom attributes, paginated search, the six reports, contact export) are already in the
current docs spec, so they are not duplicated in the overlay.

## Routes left out of the overlay

In scope but not added:

- `GET /api/v1/views/{id}/count`: belongs to views, which are out of scope (the sidebar counts
  route already returns every accessible view count).
- Macro writes (`POST /macros`, `PUT` and `DELETE /macros/{id}`, all `macros:manage`): reads were
  added so that `apply_macro` can find its macro ID; managing the macro library stays in the web UI.
- `GET /api/v1/custom-attributes/{id}`, `GET /api/v1/inboxes/{id}/campaign-stats`,
  `POST /api/v1/tags/import`, `GET /api/v1/tags/import/status`: admin (`*:manage`) settings or bulk
  import, not helpdesk reads.
- `GET /api/v1/agents/compact`, `GET /api/v1/teams/compact`, `GET /api/v1/agents/me/teams`: agents
  and teams management area.
- `POST /api/v1/csat/{uuid}/response`: public customer-facing endpoint, not an agent API.

No in-scope route was dropped because its shape could not be established.

## Discrepancies, docs spec vs v2.9.2 code

The docs spec cannot be edited (it is a byte-for-byte copy), so these are recorded here only. The code
is the truth.

1. `POST /api/v1/conversations` (`createConversationRequest`, `cmd/conversation.go`): the code also
   accepts `contact_id`, `phone_number`, `phone_number_country_code`, `whatsapp_template_id` and
   `whatsapp_template_params` for a WhatsApp inbox; the docs list none of them. The docs mark
   `content`, `contact_email`, `first_name` and `initiator` as always required, but the code requires
   them only for an email inbox (WhatsApp needs `whatsapp_template_id` and, without `contact_id`,
   phone number, country code and `first_name`). `inbox_id` is the only field required for every
   channel. `subject` and `last_name` are optional in both.
2. `POST /api/v1/conversations/{cuuid}/messages` (`messageReq`, `cmd/messages.go`): the code accepts
   `whatsapp_template_id` and `whatsapp_template_params`; the docs do not list them.
3. Inbox objects (`imodels.Inbox`, `internal/inbox/models`): the code returns `reopen_window_hours`,
   and for WhatsApp inboxes `webhook_url` and `token_invalid`, none of which are in the docs `Inbox`
   schema. The docs `channel` enum is `email | livechat`, while the code also runs a WhatsApp channel.
   The overlay `InboxDetail` schema carries all of them.
4. `GET /api/v1/inboxes/{id}` is `inboxes:manage` only (`perm(handleGetInbox, "inboxes:manage")`),
   whereas `GET /api/v1/inboxes` needs just authentication.
5. `POST /api/v1/conversations/{uuid}/macros/{id}/apply` takes a JSON **array** as its body and answers
   with a bare `{"message": ...}` (200, or 207 on partial success) rather than the status/data
   envelope. The MCP server handles array bodies as of the overlay commit; before it, an array passed as
   `body` would have been spread into an object.

Checked and consistent with the code: conversation status / priority / tags / assignee / mark-unread /
page-visits / transcript / custom-attributes, contacts (create, update, block, notes), search
(`query` minimum length 3), reports `days` parameter.

## Not verified

- The success envelope (`{"status": "success", "data": ...}`) comes from the `fastglue` library, which
  is not part of the Libredesk tree; overlay responses reuse the docs spec's description of it.
- Report handlers delegate to `internal/report`, which was not read: the `days` clamping stated by the
  docs spec is unconfirmed here.
- `GET /api/v1/drafts` and the draft upsert query live in `internal/conversation/queries.sql`, which
  was not read: the "one draft per conversation, user and type" behaviour is not asserted anywhere in
  the overlay.
- Permission names in the overlay descriptions come from `cmd/handlers.go` at v2.9.2.
