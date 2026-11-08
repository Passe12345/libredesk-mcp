#!/usr/bin/env node
// Compares the bundled spec (src/openapi.json + src/openapi.overlay.json) with the routes
// registered by a Libredesk release (cmd/handlers.go at a tag).
//
//   node scripts/check-drift.mjs [tag]     default tag: latest release of abhinavxd/libredesk
//
// Exit 1 when a spec/overlay operation has no matching route (method + path, parameter names
// ignored) or when an overlay operation duplicates one of the docs spec. Otherwise exit 0 and
// list, for information only, the in-scope routes the MCP does not cover.
// The downloaded Go file is only read as text, never executed. Needs the GitHub CLI (`gh`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "abhinavxd/libredesk";
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

// Routes the MCP deliberately does not cover. An entry is a path prefix, optionally preceded by
// an HTTP method ("POST /api/v1/inboxes"). Anything outside this list that is not in the spec
// shows up in the informational listing.
export const OUT_OF_SCOPE = [
  // Administration and settings
  "/api/v1/settings",
  "/api/v1/config",
  "/api/v1/lang",
  "/api/v1/activity-logs",
  "/api/v1/roles",
  "/api/v1/oidc",
  "/api/v1/webhooks",
  // Automations: list, read, create and toggle are covered; editing, deleting and reordering rules stay in the web UI
  "PUT /api/v1/automations/rules",
  "DELETE /api/v1/automations/rules",
  "/api/v1/business-hours",
  "/api/v1/templates",
  "/api/v1/sla",
  "/api/v1/context-links",
  "/api/v1/notifications",
  // Views, authentication and account self-service
  "/api/v1/views/me",
  "/api/v1/views/shared",
  "/api/v1/shared-views",
  "/api/v1/auth",
  "/api/v1/agents/import",
  "/api/v1/agents/reset-password",
  "/api/v1/agents/set-password",
  "/api/v1/agents/me/avatar",
  "PUT /api/v1/agents/me",
  // AI, help center, widget, WhatsApp, public pages
  "/api/v1/ai",
  "/api/v1/widget",
  "/api/v1/whatsapp",
  "/api/v1/help-centers",
  "/api/v1/collections",
  "/api/v1/articles",
  "/api/v1/public",
  // Inbox management is read-only in scope
  "POST /api/v1/inboxes",
  "PUT /api/v1/inboxes",
  "DELETE /api/v1/inboxes",
  "GET /api/v1/inboxes/oauth",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function normalisePath(path) {
  return path.replace(/\{[^}]*\}/g, "{}");
}

// Method + path pairs registered with g.GET("/x", ...) and getAndHead("/x", ...).
export function extractRoutes(goSource) {
  const routes = [];
  for (const m of goSource.matchAll(/\bg\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/g)) {
    routes.push({ method: m[1], path: m[2] });
  }
  for (const m of goSource.matchAll(/\bgetAndHead\(\s*"([^"]+)"/g)) {
    routes.push({ method: "GET", path: m[1] });
  }
  return routes;
}

export function operationsOf(spec) {
  const ops = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      if (HTTP_METHODS.includes(method)) ops.push({ method: method.toUpperCase(), path });
    }
  }
  return ops;
}

const key = (o) => `${o.method} ${normalisePath(o.path)}`;

export function isOutOfScope(route) {
  if (!route.path.startsWith("/api/v1/") && route.path !== "/health" && !route.path.startsWith("/uploads/")) {
    return true; // frontend pages, static assets, PWA files, public CSAT/widget pages
  }
  return OUT_OF_SCOPE.some((entry) => {
    const [first, second] = entry.split(" ");
    if (second === undefined) return route.path.startsWith(first);
    return route.method === first && route.path.startsWith(second);
  });
}

export function compare({ routes, specOps, overlayOps }) {
  const routeKeys = new Set(routes.map(key));
  const specKeys = new Set(specOps.map(key));
  const overlayKeys = new Set(overlayOps.map(key));
  const covered = new Set([...specKeys, ...overlayKeys]);
  return {
    missingRoute: [...specOps.map((o) => ({ ...o, from: "spec" })), ...overlayOps.map((o) => ({ ...o, from: "overlay" }))].filter(
      (o) => !routeKeys.has(key(o)),
    ),
    overlayDuplicates: overlayOps.filter((o) => specKeys.has(key(o))),
    uncovered: routes.filter((r) => !covered.has(key(r)) && !isOutOfScope(r)),
  };
}

function ghText(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    console.error(`gh ${args.join(" ")} failed: ${err.stderr || err.message}`);
    process.exit(2);
  }
}

function main() {
  const tag = process.argv[2] || ghText(["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]).trim();
  const goSource = ghText([
    "api",
    "-H",
    "Accept: application/vnd.github.raw+json",
    `repos/${REPO}/contents/cmd/handlers.go?ref=${tag}`,
  ]);
  const routes = extractRoutes(goSource);
  if (routes.length === 0) {
    console.error(`No routes found in cmd/handlers.go at ${tag}: the route registration format may have changed.`);
    process.exit(2);
  }

  const spec = JSON.parse(readFileSync(join(root, "src", "openapi.json"), "utf8"));
  const overlay = JSON.parse(readFileSync(join(root, "src", "openapi.overlay.json"), "utf8"));
  const specOps = operationsOf(spec);
  const overlayOps = operationsOf(overlay);
  const { missingRoute, overlayDuplicates, uncovered } = compare({ routes, specOps, overlayOps });

  console.log(`Libredesk ${tag}: ${routes.length} routes, ${specOps.length} docs-spec operations, ${overlayOps.length} overlay operations`);

  let failed = false;
  if (missingRoute.length > 0) {
    failed = true;
    console.log(`\nFAIL: ${missingRoute.length} operation(s) without a matching route:`);
    for (const o of missingRoute) console.log(`  [${o.from}] ${o.method} ${o.path}`);
  }
  if (overlayDuplicates.length > 0) {
    failed = true;
    console.log(`\nFAIL: ${overlayDuplicates.length} overlay operation(s) now present in the docs spec (remove them from the overlay):`);
    for (const o of overlayDuplicates) console.log(`  ${o.method} ${o.path}`);
  }
  if (!failed) console.log("\nOK: every spec and overlay operation has a matching route.");

  console.log(`\nIn-scope routes not covered (informational, ${uncovered.length}):`);
  for (const r of uncovered) console.log(`  ${r.method} ${r.path}`);

  process.exit(failed ? 1 : 0);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) main();
