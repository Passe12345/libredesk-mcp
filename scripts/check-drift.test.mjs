import { describe, it, expect } from "vitest";
import { compare, extractRoutes, isOutOfScope, normalisePath, operationsOf } from "./check-drift.mjs";

const GO = `
	g.GET("/health", handleHealthCheck)
	g.GET("/api/v1/conversations/{uuid}", perm(handleGetConversation, "conversations:read"))
	g.PUT("/api/v1/conversations/{uuid}/status", perm(handleUpdateConversationStatus, "x"))
	g.DELETE("/api/v1/tags/{id}",
		perm(handleDeleteTag, "tags:manage"))
	getAndHead("/", home)
	g.GET("/inboxes/{all:*}", authPage(serveIndexPage))
	g.GET(path, h)
`;

describe("extractRoutes", () => {
  const routes = extractRoutes(GO);

  it("finds literal routes, including a call split over two lines", () => {
    expect(routes).toContainEqual({ method: "GET", path: "/api/v1/conversations/{uuid}" });
    expect(routes).toContainEqual({ method: "DELETE", path: "/api/v1/tags/{id}" });
  });

  it("reads getAndHead as GET and skips non-literal paths", () => {
    expect(routes).toContainEqual({ method: "GET", path: "/" });
    expect(routes.some((r) => r.path === "path")).toBe(false);
    expect(routes).toHaveLength(6);
  });
});

describe("normalisePath", () => {
  it("ignores parameter names", () => {
    expect(normalisePath("/api/v1/conversations/{cuuid}/messages/{uuid}")).toBe("/api/v1/conversations/{}/messages/{}");
    expect(normalisePath("/api/v1/x/{id}")).toBe(normalisePath("/api/v1/x/{uuid}"));
  });
});

describe("operationsOf", () => {
  it("lists only HTTP method keys", () => {
    const ops = operationsOf({ paths: { "/a": { get: {}, post: {}, parameters: [], "x-foo": 1 } } });
    expect(ops).toEqual([
      { method: "GET", path: "/a" },
      { method: "POST", path: "/a" },
    ]);
  });
});

describe("isOutOfScope", () => {
  it("excludes frontend pages and listed prefixes", () => {
    expect(isOutOfScope({ method: "GET", path: "/inboxes/{all:*}" })).toBe(true);
    expect(isOutOfScope({ method: "GET", path: "/api/v1/widget/chat/settings" })).toBe(true);
    expect(isOutOfScope({ method: "GET", path: "/api/v1/ai/prompts" })).toBe(true);
  });

  it("honours method-specific entries", () => {
    expect(isOutOfScope({ method: "POST", path: "/api/v1/inboxes" })).toBe(true);
    expect(isOutOfScope({ method: "GET", path: "/api/v1/inboxes/{id}" })).toBe(false);
  });

  it("keeps API routes and health in scope by default", () => {
    expect(isOutOfScope({ method: "GET", path: "/api/v1/macros" })).toBe(false);
    expect(isOutOfScope({ method: "GET", path: "/health" })).toBe(false);
  });
});

describe("compare", () => {
  const routes = [
    { method: "GET", path: "/api/v1/a/{uuid}" },
    { method: "GET", path: "/api/v1/new-thing" },
    { method: "GET", path: "/api/v1/ai/x" },
  ];

  it("matches regardless of parameter names and reports uncovered in-scope routes", () => {
    const r = compare({ routes, specOps: [{ method: "GET", path: "/api/v1/a/{id}" }], overlayOps: [] });
    expect(r.missingRoute).toEqual([]);
    expect(r.uncovered).toEqual([{ method: "GET", path: "/api/v1/new-thing" }]);
  });

  it("flags a spec or overlay operation whose route disappeared", () => {
    const r = compare({
      routes,
      specOps: [{ method: "PUT", path: "/api/v1/ai/provider" }],
      overlayOps: [{ method: "GET", path: "/api/v1/gone" }],
    });
    expect(r.missingRoute.map((o) => `${o.from} ${o.method} ${o.path}`)).toEqual([
      "spec PUT /api/v1/ai/provider",
      "overlay GET /api/v1/gone",
    ]);
  });

  it("flags an overlay operation the docs spec now covers", () => {
    const op = { method: "GET", path: "/api/v1/a/{uuid}" };
    expect(compare({ routes, specOps: [op], overlayOps: [op] }).overlayDuplicates).toEqual([op]);
  });
});
