/**
 * End-to-end, over a real v2 connection.
 *
 * The SDK can connect an agent app directly to a client app, so these tests exercise the
 * genuine article: real JSON-RPC framing, real schema parsing of every handler's params by the
 * SDK before our code sees them, and a real client observing real notifications. The only fake
 * is the wrapped agent, which stands in for `ClaudeAcpAgent` so the suite needs no Claude
 * installation, no network and no credentials.
 *
 * What that buys over unit tests: the SDK validates inbound params against its generated
 * schemas, so a handler registered under a name the baseline does not define, or one returning
 * a response of the wrong shape, fails here rather than in front of a user.
 */

import { describe, expect, it, vi } from "vitest";
import {
  client as clientApp,
  type ClientContext,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";

import { createV2App, type WrappedAgent } from "./app.js";
import { validateSessionUpdate } from "./test-support/wire-schema.js";

/** A promise with an external resolver, so a test can hold a turn open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const V1_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    loadSession: true,
    auth: { logout: {} },
    sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {} },
  },
  agentInfo: { name: "fake-claude", title: "Fake Claude", version: "9.9.9" },
  authMethods: [],
};

const MODE_OPTION = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "default",
  options: [
    { value: "default", name: "Manual" },
    { value: "plan", name: "Plan" },
  ],
};

/** A stand-in for `ClaudeAcpAgent`, recording what it was asked and answering plausibly. */
class FakeAgent implements WrappedAgent {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  promptGate: Promise<{ stopReason?: string | null }> | undefined;
  /** Emits updates as the wrapped agent would, through the client it was constructed with. */
  emit: ((sessionId: string, update: Record<string, unknown>) => Promise<void>) | undefined;

  #record(method: string, params: unknown): void {
    this.calls.push({ method, params });
  }

  async initialize(params: unknown) {
    this.#record("initialize", params);
    return V1_INITIALIZE;
  }
  async newSession(params: unknown) {
    this.#record("newSession", params);
    return { sessionId: "sess-1", configOptions: [MODE_OPTION], modes: { currentModeId: "default" } };
  }
  async resumeSession(params: unknown) {
    this.#record("resumeSession", params);
    return { configOptions: [MODE_OPTION] };
  }
  async loadSession(params: unknown) {
    this.#record("loadSession", params);
    return { configOptions: [MODE_OPTION] };
  }
  async listSessions(params: unknown) {
    this.#record("listSessions", params);
    return { sessions: [] };
  }
  async prompt(params: unknown) {
    this.#record("prompt", params);
    return this.promptGate ?? { stopReason: "end_turn" };
  }
  async cancel(params: unknown) {
    this.#record("cancel", params);
  }
  async authenticate(params: unknown) {
    this.#record("authenticate", params);
    return {};
  }
  async logout(params: unknown) {
    this.#record("logout", params);
    return {};
  }
  async closeSession(params: unknown) {
    this.#record("closeSession", params);
    return {};
  }
  async deleteSession(params: unknown) {
    this.#record("deleteSession", params);
    return {};
  }
  async setSessionConfigOption(params: unknown) {
    this.#record("setSessionConfigOption", params);
    return { configOptions: [MODE_OPTION] };
  }
}

/** Stand up a connected agent+client pair and collect every update the client observes. */
async function connect(): Promise<{
  agent: FakeAgent;
  updates: Array<{ sessionId: string; update: SessionUpdate }>;
  run: <T>(op: (cx: ClientContext) => Promise<T>) => Promise<T>;
}> {
  const agent = new FakeAgent();
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];

  const app = createV2App({
    logger: { log: () => {}, error: () => {}, warn: () => {} },
    identity: { name: "claude-agent-acp-v2", version: "0.1.0" },
    createAgent: (shim) => {
      agent.emit = (sessionId, update) => shim.sessionUpdate({ sessionId, update: update as never });
      return agent;
    },
  });

  const peer = clientApp({ name: "test-client" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params as never);
    })
    .onRequest("session/request_permission", () => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }));

  // Connect from the *client* side: `ClientConnection.agent` is the context a client calls the
  // agent through. (`AgentApp.connect` returns the mirror image and would hand back the context
  // for calling the client.)
  const connection = peer.connect(app);
  const run = async <T>(op: (cx: ClientContext) => Promise<T>): Promise<T> => op(connection.agent);

  return { agent, updates, run };
}

/** `initialize` + `session/new`, the preamble almost every test needs. */
async function openSession(harness: Awaited<ReturnType<typeof connect>>): Promise<string> {
  await harness.run((cx) =>
    cx.request("initialize", { protocolVersion: 2, info: { name: "test", version: "1" } }),
  );
  const created = (await harness.run((cx) =>
    cx.request("session/new", { cwd: "/tmp" }),
  )) as { sessionId: string };
  return created.sessionId;
}

describe("initialize", () => {
  it("negotiates v2 and reshapes the wrapped agent's capabilities", async () => {
    const harness = await connect();
    const response = (await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "zed", version: "1.0" } }),
    )) as Record<string, unknown>;

    expect(response["protocolVersion"]).toBe(2);
    expect(response["info"]).toMatchObject({ name: "fake-claude", version: "9.9.9" });
    const capabilities = response["capabilities"] as Record<string, Record<string, unknown>>;
    expect(capabilities["session"]).toHaveProperty("prompt");
    expect(capabilities["session"]).not.toHaveProperty("fork");
    expect(capabilities["session"]?.["mcp"]).not.toHaveProperty("sse");
  });

  it("tells the wrapped agent it is speaking v1", async () => {
    const harness = await connect();
    await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "zed", version: "1.0" } }),
    );
    const call = harness.agent.calls.find((c) => c.method === "initialize");
    expect((call?.params as Record<string, unknown>)["protocolVersion"]).toBe(1);
    expect((call?.params as Record<string, unknown>)["clientInfo"]).toMatchObject({ name: "zed" });
  });
});

describe("session/new", () => {
  it("returns the session id and config options in v2 spelling", async () => {
    const harness = await connect();
    await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "t", version: "1" } }),
    );
    const response = (await harness.run((cx) =>
      cx.request("session/new", { cwd: "/tmp" }),
    )) as Record<string, unknown>;

    expect(response["sessionId"]).toBe("sess-1");
    const options = response["configOptions"] as Array<Record<string, unknown>>;
    expect(options[0]).toHaveProperty("configId", "mode");
    expect(options[0]).not.toHaveProperty("id");
  });

  it("defaults the mcpServers v1 requires and v2 makes optional", async () => {
    const harness = await connect();
    await openSession(harness);
    const call = harness.agent.calls.find((c) => c.method === "newSession");
    expect((call?.params as Record<string, unknown>)["mcpServers"]).toEqual([]);
  });

  it("strips the type tag from a stdio server and fills v1's required fields", async () => {
    const harness = await connect();
    await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "t", version: "1" } }),
    );
    await harness.run((cx) =>
      cx.request("session/new", {
        cwd: "/tmp",
        mcpServers: [{ type: "stdio", name: "srv", command: "/bin/srv" }],
      }),
    );
    const call = harness.agent.calls.find((c) => c.method === "newSession");
    const servers = (call?.params as Record<string, unknown>)["mcpServers"] as Array<
      Record<string, unknown>
    >;
    expect(servers[0]).toEqual({ name: "srv", command: "/bin/srv", args: [], env: [] });
  });
});

describe("the prompt-turn inversion", () => {
  it("answers session/prompt with an empty acknowledgement", async () => {
    const harness = await connect();
    const sessionId = await openSession(harness);

    const response = await harness.run((cx) =>
      cx.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      }),
    );
    expect(response).toEqual({});
  });

  it("ends the turn with an idle state_update carrying the stop reason", async () => {
    const harness = await connect();
    const sessionId = await openSession(harness);

    await harness.run((cx) =>
      cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }),
    );
    await vi.waitFor(() => {
      expect(harness.updates.some((u) => (u.update as { state?: string }).state === "idle")).toBe(
        true,
      );
    });

    const states = harness.updates
      .filter((u) => u.update.sessionUpdate === "state_update")
      .map((u) => (u.update as unknown as { state: string; stopReason?: string }));
    expect(states.map((s) => s.state)).toEqual(["running", "idle"]);
    expect(states.at(-1)?.stopReason).toBe("end_turn");
  });

  it("acknowledges before the turn finishes", async () => {
    const harness = await connect();
    const sessionId = await openSession(harness);
    const gate = deferred<{ stopReason: string }>();
    harness.agent.promptGate = gate.promise;

    const response = await harness.run((cx) =>
      cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }),
    );
    // The acknowledgement is back while the wrapped prompt is still running — the whole point
    // of the v2 change.
    expect(response).toEqual({});
    await vi.waitFor(() => {
      expect(harness.updates.some((u) => (u.update as { state?: string }).state === "running")).toBe(
        true,
      );
    });
    expect(harness.updates.some((u) => (u.update as { state?: string }).state === "idle")).toBe(
      false,
    );

    gate.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => {
      expect(harness.updates.some((u) => (u.update as { state?: string }).state === "idle")).toBe(
        true,
      );
    });
  });

  it("rejects a prompt for a session it never opened", async () => {
    const harness = await connect();
    await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "t", version: "1" } }),
    );
    await expect(
      harness.run((cx) =>
        cx.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] }),
      ),
    ).rejects.toThrow(/unknown session/);
  });

  it("orders a turn's content ahead of the idle that ends it", async () => {
    const harness = await connect();
    const sessionId = await openSession(harness);
    const gate = deferred<{ stopReason: string }>();
    harness.agent.promptGate = gate.promise;

    await harness.run((cx) =>
      cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }),
    );
    await harness.agent.emit?.(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "answer" },
    });
    gate.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => {
      expect(harness.updates.some((u) => (u.update as { state?: string }).state === "idle")).toBe(
        true,
      );
    });

    const order = harness.updates.map((u) => u.update.sessionUpdate);
    expect(order.indexOf("agent_message_chunk")).toBeLessThan(order.lastIndexOf("state_update"));
  });
});

describe("session/resume chooses between v1's two methods", () => {
  it("replays through loadSession when asked to start from the beginning", async () => {
    const harness = await connect();
    await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "t", version: "1" } }),
    );
    await harness.run((cx) =>
      cx.request("session/resume", {
        sessionId: "old",
        cwd: "/tmp",
        replayFrom: { type: "start" },
      }),
    );
    expect(harness.agent.calls.map((c) => c.method)).toContain("loadSession");
    expect(harness.agent.calls.map((c) => c.method)).not.toContain("resumeSession");
  });

  it("rejects an unknown cursor rather than guessing where to replay from", async () => {
    // v2's ReplayFrom union is open and its `other` branch says receivers should "reject the
    // request rather than guessing where to replay from". Both guesses corrupt something: no
    // replay reads as "there was no history", full replay duplicates it.
    const harness = await connect();
    await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "t", version: "1" } }),
    );
    await expect(
      harness.run((cx) =>
        cx.request("session/resume", {
          sessionId: "old",
          cwd: "/tmp",
          replayFrom: { type: "_vendor_checkpoint", at: "abc" },
        }),
      ),
    ).rejects.toThrow(/unsupported replayFrom cursor/);
    expect(harness.agent.calls.map((c) => c.method)).not.toContain("loadSession");
    expect(harness.agent.calls.map((c) => c.method)).not.toContain("resumeSession");
  });

  it("treats a null cursor as no replay, which the schema states directly", async () => {
    const harness = await connect();
    await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "t", version: "1" } }),
    );
    await harness.run((cx) =>
      cx.request("session/resume", { sessionId: "old", cwd: "/tmp", replayFrom: null }),
    );
    expect(harness.agent.calls.map((c) => c.method)).toContain("resumeSession");
  });

  it("resumes without replay when no cursor is given", async () => {
    const harness = await connect();
    await harness.run((cx) =>
      cx.request("initialize", { protocolVersion: 2, info: { name: "t", version: "1" } }),
    );
    await harness.run((cx) => cx.request("session/resume", { sessionId: "old", cwd: "/tmp" }));
    expect(harness.agent.calls.map((c) => c.method)).toContain("resumeSession");
    expect(harness.agent.calls.map((c) => c.method)).not.toContain("loadSession");
  });
});

describe("notifications conform to the stable schema", () => {
  it("validates every update the client observed", async () => {
    const harness = await connect();
    const sessionId = await openSession(harness);

    await harness.run((cx) =>
      cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }),
    );
    await harness.agent.emit?.(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "Read a file",
      status: "pending",
    });
    await harness.agent.emit?.(sessionId, {
      sessionUpdate: "plan",
      entries: [{ content: "step", priority: "high", status: "pending" }],
    });
    await harness.agent.emit?.(sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    });
    await vi.waitFor(() => {
      expect(harness.updates.some((u) => (u.update as { state?: string }).state === "idle")).toBe(
        true,
      );
    });

    expect(harness.updates.length).toBeGreaterThan(4);
    for (const observed of harness.updates) {
      expect(
        validateSessionUpdate(observed),
        `a non-conformant update reached the client: ${JSON.stringify(observed.update)}`,
      ).toBeNull();
    }

    // And the translations really happened, rather than the loop above passing over an empty set.
    const variants = harness.updates.map((u) => u.update.sessionUpdate);
    expect(variants).toContain("tool_call_update");
    expect(variants).toContain("plan_update");
    expect(variants).toContain("config_option_update");
    expect(variants).not.toContain("tool_call");
    expect(variants).not.toContain("plan");
    expect(variants).not.toContain("current_mode_update");
  });
});

describe("session lifecycle", () => {
  it("forgets a closed session, so a later prompt is rejected", async () => {
    const harness = await connect();
    const sessionId = await openSession(harness);
    await harness.run((cx) => cx.request("session/close", { sessionId }));

    await expect(
      harness.run((cx) =>
        cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }),
      ),
    ).rejects.toThrow(/unknown session/);
  });

  it("passes set_config_option through with configId intact", async () => {
    const harness = await connect();
    const sessionId = await openSession(harness);
    await harness.run((cx) =>
      cx.request("session/set_config_option", {
        sessionId,
        configId: "mode",
        type: "id",
        value: "plan",
      }),
    );
    const call = harness.agent.calls.find((c) => c.method === "setSessionConfigOption");
    const params = call?.params as Record<string, unknown>;
    expect(params["configId"]).toBe("mode");
    // v1 has no `type: "id"` branch — only the untagged select form and `type: "boolean"`.
    expect(params).not.toHaveProperty("type");
    expect(params["value"]).toBe("plan");
  });
});


describe("connection teardown", () => {
  it("disposes the wrapped agent when the connection ends", async () => {
    const { connectV2 } = await import("./app.js");
    const { ndJsonStream } = await import("@agentclientprotocol/sdk/experimental/v2");

    const disposed = vi.fn(async () => {});
    const agent = new FakeAgent();
    (agent as unknown as { dispose: () => Promise<void> }).dispose = disposed;

    // The wrapped agent is constructed lazily, on the first handler call, so the connection
    // has to actually carry one before there is anything to dispose.
    let push!: (line: string) => void;
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        push = (line) => controller.enqueue(new TextEncoder().encode(`${line}\n`));
      },
    });
    const output = new WritableStream<Uint8Array>({ write: () => {} });
    const connection = connectV2(ndJsonStream(output, input), {
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      createAgent: () => agent,
    });

    push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 2, info: { name: "t", version: "1" } },
      }),
    );
    await vi.waitFor(() => {
      expect(agent.calls.some((c) => c.method === "initialize")).toBe(true);
    });

    connection.close();
    await vi.waitFor(() => {
      // Without this, a client that disconnects leaves the Claude subprocesses behind every
      // open session running.
      expect(disposed).toHaveBeenCalledOnce();
    });
  });
});
