#!/usr/bin/env node
// Refreshes src/openapi.json from the published Libredesk docs spec and records
// where and when it was fetched in docs/SPEC_SOURCE.md.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const URL_ = "https://docs.libredesk.io/api-reference/openapi.json";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const res = await fetch(URL_);
if (!res.ok) {
  console.error(`Fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const text = await res.text();
const spec = JSON.parse(text);

let operations = 0;
for (const methods of Object.values(spec.paths)) {
  for (const m of Object.keys(methods)) {
    if (["get", "post", "put", "patch", "delete"].includes(m)) operations++;
  }
}

writeFileSync(join(root, "src", "openapi.json"), text);
const sha = createHash("sha256").update(text).digest("hex");
writeFileSync(
  join(root, "docs", "SPEC_SOURCE.md"),
  `# Bundled spec source

- File: \`src/openapi.json\` (byte-for-byte copy, never edited by hand)
- Source: ${URL_}
- Fetched: ${new Date().toISOString()}
- Size: ${Buffer.byteLength(text)} bytes
- SHA-256: ${sha}
- Operations: ${operations}

Refresh with \`npm run fetch-spec\`, then rebuild and run \`npm run check-drift\` if available.
Routes the docs spec lacks live in \`src/openapi.overlay.json\`.
`,
);
console.log(`Spec updated: ${Buffer.byteLength(text)} bytes, ${operations} operations, sha256 ${sha}`);
