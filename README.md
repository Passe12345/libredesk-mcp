# libredesk-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Libredesk](https://libredesk.io) — the open-source omnichannel customer support desk.

> **Fork of [metanmai/libredesk-mcp](https://github.com/metanmai/libredesk-mcp) (MIT).** The upstream history and the MIT `LICENSE` are kept. This fork refreshes the bundled spec to the current Libredesk API (v2.9.x) and keeps a drift check against Libredesk's routes.

Exposes the Libredesk REST API as MCP tools, one per operation of the bundled OpenAPI spec (the count is printed at startup). **Writes are enabled by default**; set `LIBREDESK_MCP_READ_ONLY=true` to register only `GET` operations (see [Hardening](#hardening)).

Currently 97 operations: 81 from the published docs spec plus 16 from a hand-written overlay for v2.9.2 routes the docs lack (54 `GET` tools in read-only mode). Libredesk reference version: v2.9.2.

## Tools

One tool per operation, grouped by API tag. Tools marked \* are writes: they do not exist when `LIBREDESK_MCP_READ_ONLY=true`. The names come from the `operationId`s, so they can change when the spec is refreshed; `update_ai_provider` of v0.1.0 no longer exists upstream.

- **Agents** — `get_agents_compact` (agent IDs for assignment, no admin permission needed), `get_agents`, `create_agent` \*, `get_current_agent`, `update_agent_availability` \*, `delete_agent` \*, `get_agent`, `update_agent` \*, `revoke_api_key` \*, `generate_api_key` \*
- **AI completions** — `ai_completion` \*, `get_ai_prompts`
- **Automations** — `get_automation_rules`, `get_automation_rule`, `create_automation_rule` \*, `toggle_automation_rule` \* (all need the "Manage automations" permission; editing, deleting and reordering rules stay in the web UI)
- **Contact notes** — `get_contact_notes`, `create_contact_note` \*, `delete_contact_note` \*
- **Contacts** — `get_contacts`, `create_contact` \*, `get_contact`, `update_contact` \*, `delete_contact` \*, `block_contact` \*, `export_contact`, `update_contact_custom_attributes` \*
- **Conversations** — `create_conversation` \*, `get_all_conversations`, `get_assigned_conversations`, `get_unassigned_conversations`, `send_message` \*, `get_message`, `delete_message` \*, `retry_message` \*, `get_conversation`, `update_team_assignee` \*, `remove_team_assignee` \*, `update_user_assignee` \*, `remove_user_assignee` \*, `update_conversation_assignee_last_seen` \*, `get_messages`, `get_conversation_participants`, `update_conversation_priority` \*, `update_conversation_status` \*, `update_conversationtags` \*, `get_view_conversations`, `get_team_unassigned_conversations`, `update_conversation_custom_attributes` \*, `download_conversation_transcript`, `mark_conversation_as_unread` \*, `get_mentioned_conversations`, `get_contact_page_visits`, `get_sidebar_counts`, `get_all_drafts`, `upsert_conversation_draft` \*, `delete_conversation_draft` \*, `apply_macro` \*
- **Custom attributes** — `get_custom_attributes`
- **Health** — `health_check`
- **Help center** — `get_public_help_center_article`, `public_help_center_search`, `get_public_help_center_tree`
- **Inboxes** — `get_inboxes`, `get_inbox`
- **Macros** — `get_macros`, `get_macros_compact`, `search_macros`, `get_macro` (the macro to pass to `apply_macro`, listed under Conversations)
- **Media** — `media_upload` \*, `serve_media`
- **Reports** — `overview_charts`, `overview_counts`, `overview_csat`, `overview_message_volume`, `overview_sla`, `overview_tag_distribution`
- **Search** — `search_contacts`, `search_conversations`, `search_messages`, `paginated_search_conversations`, `paginated_search_messages`
- **Views** — `get_all_shared_views`, `get_shared_view`, `create_shared_view` \* (all need the "Manage shared views" permission; editing and deleting views stay in the web UI; a view cannot filter on the subject or content, only on status, priority, assignee, team, inbox, dates, SLA and tags)
- **Status and priority** — `get_priorities`, `get_statuses`, `create_status` \*, `delete_status` \*, `update_status` \*
- **Tags** — `get_tags`, `create_tag` \*, `update_tag` \*, `delete_tag` \*
- **Teams** — `get_teams_compact` (team IDs for assignment, no admin permission needed), `get_teams`, `create_team` \*, `delete_team` \*, `get_team`, `update_team` \*

## Setup

### 1. Create an agent and an API key in Libredesk

Create a dedicated agent for the MCP (do not reuse a person's key or another integration's key), give it a role limited to what you need, then generate its API key: you get an `api_key` and an `api_secret`.

Suggested role for reading and triaging tickets (Admin > Teammates > Roles). Tick nothing in the **Admin** section:

| Section | Permissions |
|---|---|
| Conversation | View conversation, View all conversations, View all unassigned conversations, View conversation messages |
| Conversation (to act on tickets) | Send private notes, Change conversation status, Change conversation priority, Add or remove conversation tags, Assign conversations to users / teams |
| Contact | View all contacts, View contact details, View contact notes |

For read-only use keep only the "View" permissions and start the server with `LIBREDESK_MCP_READ_ONLY=true`. Do not grant "Send messages in conversations" unless the model should be able to reply to customers. Tools that need an Admin permission (agents, teams, inbox details, macro management, reports, tags and statuses management) answer 403 with such a role (to find who to assign a ticket to, use `get_agents_compact` and `get_teams_compact`, which need no Admin permission; `update_user_assignee` and `update_team_assignee` need the two "Assign conversations to ..." permissions); the role, not this server, is what limits the key.

### 2. Install a pinned local copy

Run a pinned local copy rather than `npx -y`: `npx -y` executes whatever the registry serves at that moment, and this fork is `"private": true` and never published. Clone it, install without lifecycle scripts, build once, and point your MCP host at the built file:

```bash
git clone <this repository> libredesk-mcp && cd libredesk-mcp
npm ci --ignore-scripts
npm run build
```

Note the absolute path of `dist/index.js` (`pwd` inside the clone, then append `/dist/index.js`). Rebuild with `npm run build` after every change: the host runs `dist/index.js`, not the sources.

### 3. Claude Code (CLI)

Register the built file at **user** scope, so the key lives in `~/.claude.json` and never in a repository (`--scope project` would write it into a versioned `.mcp.json`):

```bash
claude mcp add-json libredesk --scope user '{
  "command": "node",
  "args": ["/absolute/path/to/libredesk-mcp/dist/index.js"],
  "env": {
    "LIBREDESK_URL": "https://libredesk.example.com",
    "LIBREDESK_API_KEY": "<api key of the MCP agent>",
    "LIBREDESK_API_SECRET": "<api secret of the MCP agent>"
  }
}'
```

Add `"LIBREDESK_MCP_READ_ONLY": "true"` to `env` for the read-only tool set. Restart your Claude Code session, then check:

```bash
claude mcp list              # libredesk should show as ✓ Connected
claude mcp get libredesk     # shows the stored configuration
claude mcp remove libredesk --scope user
```

To rotate the key, regenerate it on the agent in Libredesk, remove the server and add it again.

### 4. Claude Desktop

Edit the Claude Desktop configuration file (in the app: Settings > Developer > Edit Config), or open it directly:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server under `mcpServers` (keep any servers already there):

```json
{
  "mcpServers": {
    "libredesk": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/libredesk-mcp/dist/index.js"],
      "env": {
        "LIBREDESK_URL": "https://libredesk.example.com",
        "LIBREDESK_API_KEY": "<api key of the MCP agent>",
        "LIBREDESK_API_SECRET": "<api secret of the MCP agent>"
      }
    }
  }
}
```

- Use the **absolute path of `node`** (`which node` on macOS, `where node` on Windows). A desktop app does not inherit your shell's `PATH`, so a bare `node` often fails, notably with `nvm`.
- On Windows, double the backslashes in JSON paths (`C:\\Users\\me\\libredesk-mcp\\dist\\index.js`).
- Quit Claude Desktop completely (Cmd+Q on macOS, not just closing the window) and reopen it. The Libredesk tools then appear in the tools menu of a conversation.
- If the server does not start, read the log of the MCP server (macOS: `~/Library/Logs/Claude/mcp-server-libredesk.log`). The server prints a readiness line on startup, e.g. `ready — 91 tools loaded (writes enabled; uploads disabled)`.
- The config file holds the key in clear text: keep it out of backups and screenshots you share.

### 5. Other MCP clients

Any host that starts a stdio MCP server accepts the same `command` / `args` / `env` block as in the Claude Desktop example (Cursor, Windsurf, etc.).

### Network access

The server calls `LIBREDESK_URL` directly from the machine that runs it. If your instance sits behind an IP allow-list, a firewall or a CDN rule, that machine must be allowed in, otherwise every tool answers with an HTTP error such as 403.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LIBREDESK_URL` | yes | Base URL of your Libredesk instance, no trailing slash. e.g. `http://localhost:9000` |
| `LIBREDESK_API_KEY` | yes | Agent API key from the Libredesk admin UI |
| `LIBREDESK_API_SECRET` | yes | Agent API secret paired with the key |
| `LIBREDESK_MCP_READ_ONLY` | no | Only the exact value `true` drops the write operations (POST/PUT/PATCH/DELETE), leaving the `GET` tools. Unset, writes are registered. |
| `LIBREDESK_MCP_UPLOAD_DIR` | no | Directory file uploads may read from. Unset, any tool argument that carries a file path is refused. |

Authentication uses Libredesk's token scheme: `Authorization: token <api_key>:<api_secret>`.

## Hardening

- **Opt-in read-only mode.** With `LIBREDESK_MCP_READ_ONLY=true` the server lists and accepts only `GET` tools; write tools do not exist for the model. Writes are on by default, so give the key an agent role as narrow as you need: the flag limits what the model can call, the role limits what the key can do. Ticket content is untrusted input (prompt injection), which is the main reason to prefer read-only when you only need to read.
- **No arbitrary file reads.** Multipart fields typed as binary (avatar and media uploads) used to read any local path the model supplied. They are now refused unless `LIBREDESK_MCP_UPLOAD_DIR` is set, and then only a regular file whose real path (after symlinks) lies inside that directory is read; relative paths are resolved against it.
- **No credentials in tool output.** Libredesk returns an agent's API key in clear (`GET /agents/me`, agent lists), and tool output ends up in the model's context and in transcripts. Every `api_key` and `api_secret` value of a response is replaced by `[redacted by libredesk-mcp]`, at any depth. The one exception is `generate_api_key`, whose purpose is to return the new credentials. Request parameters and the `Authorization` header are unaffected.
- **Automation rules are persistent.** `create_automation_rule` stores a rule that is **enabled immediately** and keeps acting on every matching conversation, long after the chat that created it. Libredesk does not validate the rule content, so a malformed rule is stored and never matches: read it back with `get_automation_rule`. Rule actions include `send_reply` (emails the customer) and `trigger_webhook` (calls an external URL): do not let the model use them on its own. Grant "Manage automations" to the MCP agent's role only while you need it, and prefer `LIBREDESK_MCP_READ_ONLY=true` otherwise, which keeps just the two read tools.
- **Not publishable by accident.** `package.json` has `"private": true`.

## How it works

On startup the server reads a bundled copy of Libredesk's [OpenAPI spec](https://docs.libredesk.io/api-reference/openapi.json) (`src/openapi.json`, provenance in `docs/SPEC_SOURCE.md`) merged with `src/openapi.overlay.json` (see `docs/SPEC_NOTES.md`), keeps the operations allowed by the mode, walks each of them and registers it as an MCP tool with:

- `tool name` — derived from the operation's `operationId` by stripping the `handle` prefix, splitting camelCase into snake_case, and lowercasing. Consecutive capitals are treated as acronyms (e.g. `handleGetAIPrompts` → `get_ai_prompts`, `handleGenerateAPIKey` → `generate_api_key`).
- `description` — built from the operation `summary`, `description`, HTTP method/path, and tags.
- `inputSchema` — flattened from path parameters, query parameters, and the request body's JSON schema (with `$ref`s resolved against `components.schemas`).

When a tool is called, the server substitutes path params, builds the query string, sets the auth header, sends the request, and returns the response body verbatim (pretty-printed JSON when applicable) along with the HTTP status line. Errors from Libredesk are returned as-is so you can see why a request was rejected.

## Develop

```bash
npm ci --ignore-scripts
npm run build       # tsc + copy openapi.json and openapi.overlay.json into dist/
npm test            # vitest, offline
npm start           # node dist/index.js
```

Refresh the bundled OpenAPI spec and check it against Libredesk's routes:

```bash
npm run fetch-spec            # downloads the docs spec, records date and SHA-256 in docs/SPEC_SOURCE.md
npm run build && npm test
npm run check-drift           # compares spec + overlay with cmd/handlers.go of the latest release (needs `gh`)
npm run check-drift -- v2.9.2 # or with a given tag
```

`check-drift` exits 1 when a spec or overlay operation has no matching route, or when an overlay operation has since appeared in the docs spec (remove it from the overlay then). It also lists, for information, in-scope routes that no tool covers; the out-of-scope prefixes are kept at the top of `scripts/check-drift.mjs`.

## License

MIT
