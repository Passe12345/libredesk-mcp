# AGENTS.md

## Project overview

`libredesk-mcp` is a single-file MCP (Model Context Protocol) server that exposes the [Libredesk](https://libredesk.io) REST API as MCP tools. It dynamically generates all tools at startup from a bundled [OpenAPI 3.0 spec](https://docs.libredesk.io/api-reference/openapi.json) plus a hand-written overlay (`src/openapi.overlay.json`) for Libredesk v2.9.2 routes the docs spec lacks. This repository is a fork of metanmai/libredesk-mcp (MIT), `"private": true`, version 0.2.0. One MCP tool is generated per operation (87 at the time of writing: 81 docs + 6 overlay; 46 of them `GET`). The count is logged at startup. **Write tools are registered unless `LIBREDESK_MCP_READ_ONLY=true`, which keeps only `GET` tools.**

- **Language**: TypeScript (ESM — `"type": "module"` in package.json)
- **Runtime**: Node.js ≥ 18
- **MCP SDK**: `@modelcontextprotocol/sdk` v1
- **Transport**: stdio (JSON-RPC over stdin/stdout)
- **Single source file**: all logic lives in `src/index.ts` (~410 lines). Key functions are exported for testability; `main()` is guarded to only run when executed directly (not when imported).

## Essential commands

```bash
npm ci --ignore-scripts  # install dependencies without lifecycle scripts
npm run build        # tsc → dist/ + copy openapi.json and openapi.overlay.json into dist/
npm start            # run compiled output (node dist/index.js)
npm test             # run vitest unit tests
npm run test:watch   # vitest in watch mode
npm run fetch-spec   # update bundled OpenAPI spec from upstream (records date/hash in docs/SPEC_SOURCE.md)
npm run check-drift  # compare spec + overlay with Libredesk's cmd/handlers.go (latest release; `-- <tag>` to pick one; needs `gh`)
```

There is a **test suite** (vitest) and **CI** (GitHub Actions with build, test, and Docker integration). There is **no linter**.

## Architecture

```
src/
├── index.ts       # Everything: spec loader, tool builder, MCP server, HTTP client
├── openapi.json          # Bundled copy of Libredesk's published OpenAPI spec (provenance: docs/SPEC_SOURCE.md). Never hand-edit.
└── openapi.overlay.json  # Hand-written operations for v2.9.2 routes the docs spec lacks; each has x-source (file + handler)
scripts/
├── fetch-spec.mjs        # npm run fetch-spec
└── check-drift.mjs       # npm run check-drift (out-of-scope prefix list lives here)
docs/
├── SPEC_SOURCE.md        # where/when the bundled spec was fetched, SHA-256
└── SPEC_NOTES.md         # overlay contents, routes left out, docs-vs-code discrepancies
```

### Startup flow

1. `main()` loads `openapi.json` and `openapi.overlay.json` from `dist/` (falling back to `src/`) and merges them (`mergeOverlay` refuses to redefine an existing method+path, operationId or schema name)
2. `buildTools()` walks every path+method in the merged spec, flattens parameters and request bodies into MCP tool schemas; `selectTools()` then keeps only `GET` tools when `LIBREDESK_MCP_READ_ONLY=true`
3. Tools are registered via `ListToolsRequestSchema` / `CallToolRequestSchema` handlers on the MCP `Server`
4. Server connects via `StdioServerTransport` and logs readiness to stderr

### Tool generation (`buildTools`)

For each operation in the OpenAPI spec:

- **Name**: derived from `operationId` by stripping a `handle` prefix, splitting camelCase into snake_case (with consecutive-uppercase acronym handling), then lowercasing. Examples: `handleGetConversation` → `get_conversation`, `handleGetAIPrompts` → `get_ai_prompts`, `handleGenerateAPIKey` → `generate_api_key`. Constrained to ≤ 60 chars.
- **Description**: concatenates summary, description, HTTP method/path, and tags
- **inputSchema**: type `"object"` with `additionalProperties: true`. Properties are built from:
  - Path parameters (always required)
  - Query parameters (required if marked so in spec)
  - Request body properties (dereferenced from `$ref`s). JSON body fields get the spec description prefixed with `(body)`. If a body field name collides with a path/query param, it gets a `body_` prefix.

### `$ref` resolution (`dereference` / `resolveRef`)

Custom, inline dereferencing. `resolveRef` walks the `#/components/schemas/...` path. `dereference` recursively walks a schema object, following `$ref` pointers in-place and expanding nested objects/arrays.

**Important**: each recursion level creates a *new* `seen` set (to prevent infinite loops locally), but this means the same schema can be re-dereferenced multiple times across different branches. This is intentional and avoids shared-mutation bugs.

### Tool execution (`callOperation`)

1. Substitutes `{pathParams}` into the URL
2. Builds query string from query params (supports array values)
3. Constructs the auth header: `Authorization: token <api_key>:<api_secret>` (Libredesk also supports `Basic` base64 auth; both work).
4. Assembles the body:
   - **multipart/form-data**: creates a `FormData` object. Binary fields (`format: "binary"`) expect a file path string; `resolveUploadPath` refuses it unless `LIBREDESK_MCP_UPLOAD_DIR` is set and the real path (after symlinks) is a regular file inside it, then the file is read and appended as a `Blob`. JSON objects/arrays in multipart are serialized with `JSON.stringify`.
   - **JSON**: collects all remaining args into a plain object and `JSON.stringify`s it. Fields that had a `body_` prefix have it stripped. An array-typed body (macro apply) arrives as `args.body` and is sent as-is.
5. Sends the `fetch` request and returns `HTTP <status> <statusText> — <METHOD> <url>` followed by the response body (pretty-printed JSON if parseable, raw text otherwise).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `LIBREDESK_URL` | yes | Base URL, no trailing slash |
| `LIBREDESK_API_KEY` | yes | Agent API key |
| `LIBREDESK_API_SECRET` | yes | Agent API secret |
| `LIBREDESK_MCP_READ_ONLY` | no | Exactly `true` drops the write (non-GET) tools; anything else (including unset) keeps them |
| `LIBREDESK_MCP_UPLOAD_DIR` | no | Directory uploads may read from; unset = file-path fields are refused |

Missing env vars log a warning to stderr but do **not** prevent startup — tools that require auth will just get 401 errors from Libredesk.

## Naming conventions & style

- **CamelCase** for TypeScript types/interfaces (`OpenAPIOperation`, `ToolDef`, `JsonSchema`)
- **snake_case** for MCP tool names (derived automatically)
- **No comments** in source — the code is self-documenting by convention
- `const` for all top-level bindings; `let` only inside function scope when needed
- `Record<string, unknown>` and `Record<string, JsonSchema>` for dynamic objects — never `any`

## Key gotchas

### `body_` prefix via `bodyKeyMap`

When a request body field name collides with a path/query parameter, the MCP tool argument gets a `body_` prefix (e.g., `body_name` instead of `name`). The mapping from MCP arg name → real API field name is stored in `ToolDef.bodyKeyMap`. Both `callOperation` JSON body assembly and multipart form building use this map to strip the prefix at execution time. This replaces the previous fragile approach of inline prefix-stripping that was easy to break.

### Binary file uploads expect a path string, not file content

The MCP tool schema describes binary fields as `type: "string"` with a description telling the model to pass a file path inside `LIBREDESK_MCP_UPLOAD_DIR`. The actual file read happens inside `callOperation` after `resolveUploadPath` has checked the real path, not at tool-definition time. Never reintroduce a bare `readFileSync(value)`: that let the model read any local file. Uploads are writes, so they disappear in read-only mode (`LIBREDESK_MCP_READ_ONLY=true`).

### Read-only filtering happens at registration

`selectTools` drops non-GET tools before the `tools/list` and `tools/call` handlers are built, so a write tool is an "Unknown tool" when `LIBREDESK_MCP_READ_ONLY=true`. `callOperation` itself does not check the mode.

### No trailing-slash normalization on base URL

`LIBREDESK_URL` has its trailing slash stripped at startup. But the constructed URLs use `${LIBREDESK_URL}${tool.path}` which always produces `base/path`, never `base//path`. This is safe as long as you don't change the concatenation pattern.

### `additionalProperties: true` on input schemas

Extra args that don't match any declared property pass through as JSON body fields in `callOperation`. This is intentional — it lets the MCP client pass arbitrary body data without every field being in the schema. But it also means typos in argument names silently become extra body fields instead of erroring.

### Auth format

Libredesk supports two auth formats: `token api_key:api_secret` and `Basic base64(api_key:api_secret)`. The MCP server uses `token` format which is the documented preferred form. When testing directly or debugging, either format works.

### Response edge case: concatenated error JSON

Some Libredesk endpoints (e.g., `create_agent`) may return two concatenated JSON error responses in a single 500 body when multiple errors occur. The MCP server forwards the raw response text as-is, which means the concatenated JSON won't be pretty-printed. This is a Libredesk API issue, not an MCP server bug.

`src/openapi.json` is a manual copy from `https://docs.libredesk.io/api-reference/openapi.json`. It is not auto-generated during build. Updating it requires a manual curl+copy. The build script only copies it into `dist/`.

### The overlay can only add

`mergeOverlay` throws on a duplicate. When the docs spec catches up with a route the overlay carries, `npm run check-drift` fails and says to remove it from the overlay. Overlay shapes come from the Go sources at v2.9.2; when the code and the docs disagree the code wins, and the disagreement is recorded in `docs/SPEC_NOTES.md`.

### No versioning or compatibility layer

The server exposes whatever the bundled spec describes. If the spec changes upstream (new endpoints, renamed operations, different schemas), tool names and input schemas change without backward compatibility. This matters if you cache or hardcode tool names in MCP client configs.

### Stdio transport

The server uses `console.error` for all logging because `console.log` / stdout would interfere with the JSON-RPC protocol over stdio. Never add `console.log` — use `console.error`.

## Testing against a local instance

To test the MCP server end-to-end:

```bash
# Start Libredesk via Docker
git clone https://github.com/abhinavxd/libredesk /tmp/libredesk-test
cd /tmp/libredesk-test
docker compose up -d

# Set system user password
docker exec -it libredesk_app ./libredesk --set-system-user-password

# Generate an API key (requires CSRF token from session)
# Login: POST /api/v1/auth/login {email:"System", password:"..."}
# Generate: POST /api/v1/agents/1/api-key with X-CSRFTOKEN header

# Build and run MCP server
cd /path/to/libredesk-mcp
npm install && npm run build
LIBREDESK_URL=http://localhost:9000 \
LIBREDESK_API_KEY=... \
LIBREDESK_API_SECRET=... \
node dist/index.js
```

The server logs `[libredesk-mcp] ready — <N> tools loaded (writes enabled; uploads disabled) against http://localhost:9000` on successful startup. Add `LIBREDESK_MCP_READ_ONLY=true` to get the read-only tool set.

## Updating the OpenAPI spec

```bash
npm run fetch-spec    # fetches latest from docs.libredesk.io, rewrites docs/SPEC_SOURCE.md
npm run build && npm test
npm run check-drift   # fails if an operation lost its route or an overlay operation is now in the docs spec
```

Commit `src/openapi.json` and `docs/SPEC_SOURCE.md` together. The tests derive the expected tool count from the spec and overlay, so there is no number to update; the integration job in CI does the same (GET operations only, because the CI spawn sets `LIBREDESK_MCP_READ_ONLY=true`).

## MCP client configuration

This server is typically run as a child process by an MCP host:

```json
{
  "mcpServers": {
    "libredesk": {
      "command": "node",
      "args": ["/path/to/libredesk-mcp/dist/index.js"],
      "env": {
        "LIBREDESK_URL": "http://localhost:9000",
        "LIBREDESK_API_KEY": "ak_...",
        "LIBREDESK_API_SECRET": "as_..."
      }
    }
  }
}
```

Run a pinned local build (`npm ci --ignore-scripts && npm run build`). Do not use `npx -y`: the package is private and never published, and `npx -y` would run whatever the registry serves.
