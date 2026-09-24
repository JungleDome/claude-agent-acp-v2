/**
 * The handshake mapping, measured against a real v1 response.
 *
 * `docs/mapping/EVIDENCE-v1-shapes.json` is not a hand-written fixture: it is the actual
 * `initialize` response of the wrapped agent, captured by driving it with a stub client. That
 * matters because the interesting cases in this mapping are the ones a fixture author would
 * not think to write — `loadSession: true` sitting next to `sessionCapabilities: { close: {} }`
 * in the same object, `mcpCapabilities.sse` still being advertised, `authMethods` being empty
 * rather than absent. A fixture would have been tidier and would have tested less.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  toV1InitializeRequest,
  toV2InitializeResponse,
  type AdapterIdentity,
  type V1InitializeResponse,
} from "./capabilities.js";

const evidencePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "mapping",
  "EVIDENCE-v1-shapes.json",
);

const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
  initialize: V1InitializeResponse;
};

const IDENTITY: AdapterIdentity = {
  name: "claude-agent-acp-v2",
  title: "Claude Agent (ACP v2)",
  version: "0.1.0",
};

describe("v1 initialize response -> v2", () => {
  const v2 = toV2InitializeResponse(evidence.initialize, IDENTITY);

  it("negotiates protocol version 2", () => {
    expect(v2.protocolVersion).toBe(2);
    // The wrapped agent answered 1. Nothing may leak that number upward.
    expect(evidence.initialize.protocolVersion).toBe(1);
  });

  it("carries the required info, taken from the wrapped agent", () => {
    expect(v2.info.name).toBe("@agentclientprotocol/claude-agent-acp");
    expect(v2.info.version).toBe(evidence.initialize.agentInfo?.version);
    expect(v2.info.title).toBe("Claude Agent");
  });

  it("falls back to the adapter's own identity when v1 names nobody", () => {
    const anonymous = toV2InitializeResponse({ protocolVersion: 1 }, IDENTITY);
    expect(anonymous.info).toEqual({
      name: "claude-agent-acp-v2",
      title: "Claude Agent (ACP v2)",
      version: "0.1.0",
    });
  });

  it("maps prompt and mcp capabilities into session", () => {
    expect(v2.capabilities?.session?.prompt).toEqual({ image: true, embeddedContext: true });
    expect(v2.capabilities?.session?.mcp).toBeDefined();
  });

  it("drops the sse transport v2 removed", () => {
    // v1 really does advertise it — if this premise ever stops holding, the assertion below
    // would pass vacuously, so it is checked rather than assumed.
    const v1Mcp = evidence.initialize.agentCapabilities?.mcpCapabilities as Record<string, unknown>;
    expect(v1Mcp["sse"]).toBe(true);
    expect(v2.capabilities?.session?.mcp).not.toHaveProperty("sse");
    expect(v2.capabilities?.session?.mcp).toHaveProperty("http");
  });

  it("carries the object-presence markers v2 has a slot for", () => {
    expect(v2.capabilities?.session?.delete).toBeDefined();
    expect(v2.capabilities?.session?.additionalDirectories).toBeDefined();
    expect(v2.capabilities?.auth).toBeDefined();
  });

  it("does not re-advertise what v2 makes baseline", () => {
    // v1 advertised list, resume and close. In v2 these are implied by `session` existing at
    // all, and SessionCapabilities has no member for them.
    const v1Session = evidence.initialize.agentCapabilities?.sessionCapabilities ?? {};
    expect(Object.keys(v1Session)).toEqual(
      expect.arrayContaining(["list", "resume", "close"]),
    );
    expect(v2.capabilities?.session).not.toHaveProperty("list");
    expect(v2.capabilities?.session).not.toHaveProperty("resume");
    expect(v2.capabilities?.session).not.toHaveProperty("close");
  });

  it("does not carry the draft-superset fork marker", () => {
    const v1Session = evidence.initialize.agentCapabilities?.sessionCapabilities ?? {};
    expect(v1Session).toHaveProperty("fork");
    expect(v2.capabilities?.session).not.toHaveProperty("fork");
  });

  it("drops loadSession, whose method v2 deleted", () => {
    expect(evidence.initialize.agentCapabilities?.loadSession).toBe(true);
    expect(v2.capabilities).not.toHaveProperty("loadSession");
    expect(v2.capabilities?.session).not.toHaveProperty("loadSession");
  });

  it("omits an empty authMethods rather than sending it empty", () => {
    expect(evidence.initialize.authMethods).toEqual([]);
    expect(v2).not.toHaveProperty("authMethods");
  });

  it("advertises authMethods when the wrapped agent has any", () => {
    const withAuth = toV2InitializeResponse(
      { protocolVersion: 1, authMethods: [{ id: "oauth", name: "Sign in" }] },
      IDENTITY,
    );
    expect(withAuth.authMethods).toHaveLength(1);
  });

  it("treats a boolean v1 marker as present, not as the value true", () => {
    const booleanMarkers = toV2InitializeResponse(
      {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: true, sessionCapabilities: { delete: true } },
      },
      IDENTITY,
    );
    // Presence is the signal; the payload of a bare `true` is simply empty.
    expect(booleanMarkers.capabilities?.session?.prompt).toEqual({});
    expect(booleanMarkers.capabilities?.session?.delete).toEqual({});
  });

  it("omits a marker the wrapped agent did not advertise", () => {
    const none = toV2InitializeResponse(
      { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } },
      IDENTITY,
    );
    expect(none.capabilities?.session).toEqual({});
    expect(none.capabilities).not.toHaveProperty("auth");
  });
});

describe("v2 initialize request -> v1", () => {
  it("tells the wrapped agent it is speaking v1", () => {
    const v1 = toV1InitializeRequest(
      { protocolVersion: 2, info: { name: "zed", version: "1.0" } },
      { readTextFile: true, writeTextFile: true },
    );
    expect(v1["protocolVersion"]).toBe(1);
  });

  it("asserts the filesystem support the bridge promises to service", () => {
    const enabled = toV1InitializeRequest(
      { protocolVersion: 2, info: { name: "c", version: "1" } },
      { readTextFile: true, writeTextFile: false },
    );
    expect(enabled["clientCapabilities"]).toMatchObject({
      fs: { readTextFile: true, writeTextFile: false },
    });
  });

  it("always reports no terminal, because v2 clients have none", () => {
    const v1 = toV1InitializeRequest(
      { protocolVersion: 2, info: { name: "c", version: "1" } },
      { readTextFile: false, writeTextFile: false },
    );
    expect((v1["clientCapabilities"] as Record<string, unknown>)["terminal"]).toBe(false);
  });

  it("renames info to clientInfo and keeps an optional title", () => {
    const withTitle = toV1InitializeRequest(
      { protocolVersion: 2, info: { name: "zed", title: "Zed", version: "1.0" } },
      { readTextFile: true, writeTextFile: true },
    );
    expect(withTitle["clientInfo"]).toEqual({ name: "zed", title: "Zed", version: "1.0" });

    const withoutTitle = toV1InitializeRequest(
      { protocolVersion: 2, info: { name: "zed", version: "1.0" } },
      { readTextFile: true, writeTextFile: true },
    );
    expect(withoutTitle["clientInfo"]).toEqual({ name: "zed", version: "1.0" });
  });

  it("passes the client's elicitation and auth markers down", () => {
    const v1 = toV1InitializeRequest(
      {
        protocolVersion: 2,
        info: { name: "c", version: "1" },
        capabilities: { elicitation: {}, auth: { terminal: {} } },
      },
      { readTextFile: true, writeTextFile: true },
    );
    const caps = v1["clientCapabilities"] as Record<string, unknown>;
    expect(caps["elicitation"]).toEqual({});
    // The marker's payload is carried through, not flattened to a bare presence flag.
    expect(caps["auth"]).toEqual({ terminal: {} });
  });

  it("omits markers the v2 client did not send", () => {
    const v1 = toV1InitializeRequest(
      { protocolVersion: 2, info: { name: "c", version: "1" }, capabilities: {} },
      { readTextFile: true, writeTextFile: true },
    );
    const caps = v1["clientCapabilities"] as Record<string, unknown>;
    expect(caps).not.toHaveProperty("elicitation");
    expect(caps).not.toHaveProperty("auth");
  });
});
