import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  loadSpec,
  mergeOverlay,
  callOperation,
  resolveRef,
  dereference,
  toolNameFromOperationId,
  buildTools,
  authHeader,
  type OpenAPISpec,
  type ToolDef,
} from "./index.js";

const minimalSpec: OpenAPISpec = {
  paths: {
    "/health": {
      get: {
        operationId: "handleHealthCheck",
        summary: "Health Check",
        tags: ["Health"],
      },
    },
    "/api/v1/agents": {
      get: {
        operationId: "handleGetAgents",
        summary: "Get Agents",
        tags: ["Agents"],
        parameters: [
          { name: "page", in: "query", required: false, schema: { type: "integer" } },
        ],
      },
      post: {
        operationId: "handleCreateAgent",
        summary: "Create Agent",
        tags: ["Agents"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentRequest" },
            },
          },
        },
      },
    },
    "/api/v1/agents/{id}": {
      get: {
        operationId: "handleGetAgent",
        summary: "Get Agent",
        tags: ["Agents"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
      },
      put: {
        operationId: "handleUpdateAgent",
        summary: "Update Agent",
        tags: ["Agents"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentRequest" },
            },
          },
        },
      },
    },
    "/api/v1/ai/prompts": {
      get: {
        operationId: "handleGetAIPrompts",
        summary: "Get AI Prompts",
        tags: ["AI completions"],
      },
    },
    "/api/v1/media": {
      post: {
        operationId: "handleMediaUpload",
        summary: "Media Upload",
        tags: ["Media"],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  files: { type: "string", format: "binary", description: "File to upload" },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/agents/{id}/api-key": {
      post: {
        operationId: "handleGenerateAPIKey",
        summary: "Generate API Key",
        tags: ["Agents"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
      },
    },
  },
  components: {
    schemas: {
      AgentRequest: {
        type: "object",
        required: ["email", "first_name", "roles"],
        properties: {
          first_name: { type: "string", description: "Agent's first name" },
          last_name: { type: "string", description: "Agent's last name" },
          email: { type: "string", format: "email", description: "Agent's email" },
          roles: { type: "array", items: { type: "string" }, description: "Roles" },
          enabled: { type: "boolean", description: "Enabled status" },
        },
      },
    },
  },
};

// ============================================================
// resolveRef
// ============================================================
describe("resolveRef", () => {
  it("resolves a top-level schema reference", () => {
    const result = resolveRef(minimalSpec, "#/components/schemas/AgentRequest");
    expect(result).toBeDefined();
    expect(result.type).toBe("object");
    expect(result.required).toEqual(["email", "first_name", "roles"]);
  });

  it("returns empty object for invalid path", () => {
    const result = resolveRef(minimalSpec, "#/components/schemas/Nonexistent");
    expect(result).toEqual({});
  });

  it("returns empty object for non-#/ refs", () => {
    const result = resolveRef(minimalSpec, "https://example.com/schema");
    expect(result).toEqual({});
  });

  it("returns empty object for empty ref", () => {
    const result = resolveRef(minimalSpec, "");
    expect(result).toEqual({});
  });
});

// ============================================================
// dereference
// ============================================================
describe("dereference", () => {
  it("resolves $ref in a schema", () => {
    const schema = { $ref: "#/components/schemas/AgentRequest" };
    const result = dereference(minimalSpec, schema);
    expect(result.type).toBe("object");
    const props = result.properties as Record<string, unknown>;
    expect(props).toBeDefined();
    expect(props.first_name).toBeDefined();
  });

  it("resolves nested $refs", () => {
    const nestedSpec: OpenAPISpec = {
      paths: {},
      components: {
        schemas: {
          A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
          B: { type: "string", description: "nested" },
        },
      },
    };
    const result = dereference(nestedSpec, { $ref: "#/components/schemas/A" });
    const props = result.properties as Record<string, unknown>;
    expect((props.b as Record<string, unknown>).type).toBe("string");
  });

  it("handles circular refs gracefully", () => {
    const circularSpec: OpenAPISpec = {
      paths: {},
      components: {
        schemas: {
          A: { type: "object", properties: { self: { $ref: "#/components/schemas/A" } } },
        },
      },
    };
    const result = dereference(circularSpec, { $ref: "#/components/schemas/A" });
    const props = result.properties as Record<string, unknown>;
    expect(props.self).toEqual({});
  });

  it("returns primitives as-is", () => {
    expect(dereference(minimalSpec, "string" as unknown as Record<string, unknown>)).toBe("string");
    expect(dereference(minimalSpec, 42 as unknown as Record<string, unknown>)).toBe(42);
  });

  it("handles null/undefined", () => {
    expect(dereference(minimalSpec, null as unknown as Record<string, unknown>)).toBe(null);
    expect(dereference(minimalSpec, undefined as unknown as Record<string, unknown>)).toBe(undefined);
  });
});

// ============================================================
// toolNameFromOperationId
// ============================================================
describe("toolNameFromOperationId", () => {
  it("strips handle prefix", () => {
    expect(toolNameFromOperationId("handleGetAgents")).toBe("get_agents");
  });

  it("converts camelCase to snake_case", () => {
    expect(toolNameFromOperationId("handleCreateConversation")).toBe("create_conversation");
  });

  it("handles consecutive capitals as acronyms", () => {
    expect(toolNameFromOperationId("handleGetAIPrompts")).toBe("get_ai_prompts");
    expect(toolNameFromOperationId("handleAICompletion")).toBe("ai_completion");
    expect(toolNameFromOperationId("handleGenerateAPIKey")).toBe("generate_api_key");
    expect(toolNameFromOperationId("handleUpdateAIProvider")).toBe("update_ai_provider");
  });

  it("handles simple names", () => {
    expect(toolNameFromOperationId("handleHealthCheck")).toBe("health_check");
  });

  it("truncates names over 60 characters", () => {
    const long = "handle" + "A".repeat(70) + "VeryLongOperationNameThatExceedsTheLimit";
    const result = toolNameFromOperationId(long);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("returns original if stripping produces empty", () => {
    expect(toolNameFromOperationId("handle")).toBe("handle");
  });

  it("replaces non-alphanumeric with underscore", () => {
    expect(toolNameFromOperationId("handleGet-Agents")).toBe("get_agents");
  });
});

// ============================================================
// buildTools
// ============================================================
describe("buildTools", () => {
  const tools = buildTools(minimalSpec);
  const byName = new Map(tools.map((t) => [t.name, t]));

  it("builds correct number of tools", () => {
    // 8 operations defined in minimalSpec
    expect(tools.length).toBe(8);
  });

  it("generates correct tool names", () => {
    expect(byName.has("health_check")).toBe(true);
    expect(byName.has("get_agents")).toBe(true);
    expect(byName.has("create_agent")).toBe(true);
    expect(byName.has("get_agent")).toBe(true);
    expect(byName.has("update_agent")).toBe(true);
    expect(byName.has("get_ai_prompts")).toBe(true);
    expect(byName.has("media_upload")).toBe(true);
  });

  describe("health_check", () => {
    const tool = byName.get("health_check")!;

    it("is a GET with no params", () => {
      expect(tool.method).toBe("get");
      expect(tool.path).toBe("/health");
      expect(tool.pathParams).toEqual([]);
      expect(tool.queryParams).toEqual([]);
      expect(tool.hasBody).toBe(false);
    });

    it("has description with method and path", () => {
      expect(tool.description).toContain("Health Check");
      expect(tool.description).toContain("GET /health");
    });
  });

  describe("get_agents", () => {
    const tool = byName.get("get_agents")!;

    it("has query params", () => {
      expect(tool.queryParams).toHaveLength(1);
      expect(tool.queryParams[0].name).toBe("page");
      expect(tool.queryParams[0].required).toBe(false);
    });
  });

  describe("get_agent", () => {
    const tool = byName.get("get_agent")!;

    it("has required path param", () => {
      expect(tool.pathParams).toEqual(["id"]);
      expect(tool.inputSchema.required).toContain("id");
    });
  });

  describe("create_agent", () => {
    const tool = byName.get("create_agent")!;

    it("has JSON body", () => {
      expect(tool.method).toBe("post");
      expect(tool.hasBody).toBe(true);
      expect(tool.isMultipart).toBe(false);
      expect(tool.bodyContentType).toBe("application/json");
    });

    it("includes dereferenced body properties", () => {
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.first_name).toBeDefined();
      expect(props.email).toBeDefined();
      expect(props.roles).toBeDefined();
    });

    it("marks required body fields", () => {
      const req = tool.inputSchema.required as string[];
      expect(req).toContain("email");
      expect(req).toContain("first_name");
      expect(req).toContain("roles");
    });

    it("prefixes body fields with (body)", () => {
      const props = tool.inputSchema.properties as Record<string, unknown>;
      const desc = (props.first_name as Record<string, unknown>).description as string;
      expect(desc).toContain("(body)");
    });

    it("has bodyKeyMap mapping MCP arg names to real API names", () => {
      expect(tool.bodyKeyMap.get("first_name")).toBe("first_name");
      expect(tool.bodyKeyMap.get("email")).toBe("email");
    });
  });

  describe("update_agent (body/path collision)", () => {
    const tool = byName.get("update_agent")!;

    it("detects collision between path param 'id' and body field", () => {
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.id).toBeDefined(); // path param
      expect(props.body_id).toBeUndefined(); // no collision with 'id' since AgentRequest doesn't have 'id'
    });
  });

  describe("media_upload (multipart)", () => {
    const tool = byName.get("media_upload")!;

    it("is multipart", () => {
      expect(tool.isMultipart).toBe(true);
      expect(tool.bodyContentType).toBe("multipart/form-data");
    });

    it("tracks binary fields", () => {
      expect(tool.binaryFields.has("files")).toBe(true);
    });

    it("describes binary fields as file paths", () => {
      const props = tool.inputSchema.properties as Record<string, unknown>;
      const desc = (props.files as Record<string, unknown>).description as string;
      expect(desc).toContain("(body, file)");
      expect(desc).toContain("file path");
    });

    it("has bodyKeyMap for binary fields", () => {
      expect(tool.bodyKeyMap.get("files")).toBe("files");
    });
  });

  describe("generate_api_key", () => {
    const tool = byName.get("generate_api_key")!;

    it("has required path param but no body", () => {
      expect(tool.pathParams).toEqual(["id"]);
      expect(tool.hasBody).toBe(false);
    });
  });
});

// ============================================================
// body_ prefix collision detection
// ============================================================
describe("body_ prefix collision", () => {
  it("prefixes body field when it collides with a path/query param", () => {
    const spec: OpenAPISpec = {
      paths: {
        "/api/v1/items/{name}": {
          post: {
            operationId: "handleCreateItem",
            parameters: [
              { name: "name", in: "path", required: true, schema: { type: "string" } },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "Item name" },
                      description: { type: "string", description: "Item description" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const tools = buildTools(spec);
    const tool = tools[0];
    const props = tool.inputSchema.properties as Record<string, unknown>;

    // Path param 'name' stays
    expect(props.name).toBeDefined();
    // Body field 'name' gets body_ prefix
    expect(props.body_name).toBeDefined();

    // bodyKeyMap maps prefixed arg → real API name
    expect(tool.bodyKeyMap.get("body_name")).toBe("name");
    expect(tool.bodyKeyMap.get("description")).toBe("description");
  });
});

// ============================================================
// authHeader
// ============================================================
describe("authHeader", () => {
  it("returns token auth header", () => {
    expect(authHeader("key123", "secret456")).toBe("token key123:secret456");
  });
});

// ============================================================
// inputSchema shape
// ============================================================
describe("inputSchema", () => {
  const tools = buildTools(minimalSpec);

  it("all input schemas have type object", () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("all input schemas allow additional properties", () => {
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(true);
    }
  });
});

// ============================================================
// Tool name uniqueness
// ============================================================
describe("tool name uniqueness", () => {
  it("produces no duplicate tool names", () => {
    const tools = buildTools(minimalSpec);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ============================================================
// Bundled spec
// ============================================================
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

function countOperations(paths: Record<string, Record<string, unknown>>): number {
  let n = 0;
  for (const methods of Object.values(paths)) {
    for (const m of Object.keys(methods)) if (HTTP_METHODS.includes(m)) n++;
  }
  return n;
}

describe("bundled spec", () => {
  const readJson = (name: string) =>
    JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf-8")) as OpenAPISpec;
  const raw = readJson("openapi.json");
  const overlay = readJson("openapi.overlay.json");
  const tools = buildTools(loadSpec());

  it("registers one tool per operation of the spec plus overlay (count derived, not hard-coded)", () => {
    expect(tools.length).toBe(countOperations(raw.paths) + countOperations(overlay.paths));
    expect(tools.length).toBeGreaterThan(0);
  });

  it("gives every tool a unique name within the 60-character limit", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(60);
  });

  it("gives every operation an operationId", () => {
    for (const [path, methods] of Object.entries(raw.paths)) {
      for (const [m, op] of Object.entries(methods)) {
        if (HTTP_METHODS.includes(m)) expect(op.operationId, `${m} ${path}`).toBeTruthy();
      }
    }
  });

  it("no longer carries the removed PUT /api/v1/ai/provider operation", () => {
    expect(tools.some((t) => t.method === "put" && t.path === "/api/v1/ai/provider")).toBe(false);
  });

  it("describes POST /api/v1/conversations with the current optional fields", () => {
    const tool = tools.find((t) => t.method === "post" && t.path === "/api/v1/conversations")!;
    const props = Object.keys(tool.inputSchema.properties as Record<string, unknown>);
    for (const f of ["reuse_contact", "send_from", "cc", "bcc", "custom_attributes", "source_id", "external_user_id"]) {
      expect(props).toContain(f);
    }
    const required = tool.inputSchema.required as string[];
    expect(required).not.toContain("subject");
    expect(required).not.toContain("last_name");
  });
});

// ============================================================
// Overlay
// ============================================================
describe("overlay", () => {
  const readJson = (name: string) =>
    JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf-8")) as OpenAPISpec;
  const base = readJson("openapi.json");
  const overlay = readJson("openapi.overlay.json");
  const merged = loadSpec();
  const tools = buildTools(merged);
  const byName = new Map(tools.map((t) => [t.name, t]));

  it("only adds operations the base spec lacks", () => {
    for (const [p, methods] of Object.entries(overlay.paths)) {
      for (const m of Object.keys(methods)) expect(base.paths[p]?.[m], `${m} ${p}`).toBeUndefined();
    }
  });

  it("traces every overlay operation to a handler at v2.9.2", () => {
    for (const [p, methods] of Object.entries(overlay.paths)) {
      for (const [m, op] of Object.entries(methods)) {
        const src = (op as unknown as Record<string, Record<string, string>>)["x-source"];
        expect(src, `${m} ${p}`).toBeDefined();
        expect(src.tag).toBe("v2.9.2");
        expect(src.file).toMatch(/^cmd\/.+\.go$/);
        expect(src.handler).toBe(op.operationId);
      }
    }
  });

  it("resolves every $ref of the merged spec", () => {
    const refs: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "$ref" && typeof x === "string") refs.push(x);
          else walk(x);
        }
      }
    };
    walk(merged.paths);
    walk(merged.components);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(Object.keys(resolveRef(merged, r)).length, r).toBeGreaterThan(0);
  });

  it("exposes the overlay tools", () => {
    for (const n of [
      "get_sidebar_counts",
      "get_all_drafts",
      "upsert_conversation_draft",
      "delete_conversation_draft",
      "apply_macro",
      "get_inbox",
    ]) {
      expect(byName.has(n), n).toBe(true);
    }
  });

  it("models the macro body as a required array", () => {
    const tool = byName.get("apply_macro")!;
    expect(tool.pathParams).toEqual(["uuid", "id"]);
    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.body.type).toBe("array");
    expect(tool.inputSchema.required).toContain("body");
  });

  it("reads the draft type to delete from the query string", () => {
    const tool = byName.get("delete_conversation_draft")!;
    expect(tool.queryParams).toEqual([{ name: "type", required: false }]);
  });
});

describe("mergeOverlay", () => {
  const base: OpenAPISpec = {
    paths: { "/a": { get: { operationId: "handleA" } } },
    components: { schemas: { S: { type: "string" } } },
  };

  it("adds paths, methods on existing paths and schemas without mutating the base", () => {
    const merged = mergeOverlay(base, {
      paths: { "/a": { post: { operationId: "handleB" } }, "/c": { get: { operationId: "handleC" } } },
      components: { schemas: { T: { type: "integer" } } },
    });
    expect(Object.keys(merged.paths["/a"]).sort()).toEqual(["get", "post"]);
    expect(merged.paths["/c"].get.operationId).toBe("handleC");
    expect(Object.keys(merged.components!.schemas!).sort()).toEqual(["S", "T"]);
    expect(Object.keys(base.paths["/a"])).toEqual(["get"]);
  });

  it("refuses to redefine an existing method and path", () => {
    expect(() => mergeOverlay(base, { paths: { "/a": { get: { operationId: "handleX" } } } })).toThrow(/already exists/);
  });

  it("refuses a duplicate operationId", () => {
    expect(() => mergeOverlay(base, { paths: { "/z": { get: { operationId: "handleA" } } } })).toThrow(/operationId/);
  });

  it("refuses a duplicate schema name", () => {
    expect(() =>
      mergeOverlay(base, { paths: {}, components: { schemas: { S: { type: "number" } } } }),
    ).toThrow(/schema S/);
  });
});

// ============================================================
// Array request bodies
// ============================================================
describe("array request body", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends an array body as-is instead of spreading it into an object", async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":"ok"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = buildTools(loadSpec()).find((t) => t.name === "apply_macro")!;
    const actions = [{ type: "set_status", value: ["3"] }];

    await callOperation(tool, { uuid: "c-1", id: 7, body: actions }, "http://x.test", "k", "s");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x.test/api/v1/conversations/c-1/macros/7/apply");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(actions);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
