/**
 * The v2 surface: eleven handlers over one wrapped v1 agent.
 *
 * This is the file that would have been a fork. Upstream's own entry point registers the v1
 * method set on a v1 `agent()` app and constructs `ClaudeAcpAgent` with a v1 client; this
 * registers the **stable v2** method set on a v2 app and constructs the same class with
 * {@link V2ClientShim}. The agent in the middle is byte-identical — it arrives from npm.
 *
 * The one handler that is not a translate-and-forward is `session/prompt`, and it is the reason
 * `turn.ts` exists: v2 requires an immediate `{}` acknowledgement while the wrapped `prompt()`
 * runs for the whole turn. See {@link registerHandlers} for the ordering that makes that safe.
 */

import { agent as agentApp, RequestError } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentApp, AgentContext, Stream } from "@agentclientprotocol/sdk/experimental/v2";

import {
  toV1InitializeRequest,
  toV2InitializeResponse,
  type AdapterIdentity,
  type FsSupport,
  type V1InitializeResponse,
} from "./capabilities.js";
import { toV2ConfigOptions, type V1ConfigOption } from "./config-options.js";
import { createNodeFsBridge, type FsBridge } from "./fs-bridge.js";
import { toV1NewSession, toV1Resume, toV1SetConfigOption } from "./inbound.js";
import { V2ClientShim, type Logger } from "./client-shim.js";
import { TurnTracker } from "./turn.js";

/**
 * The part of `ClaudeAcpAgent` this adapter uses, as a structural type.
 *
 * Structural rather than a direct import of the class so the whole surface can be faked in
 * tests without a Claude installation, and so a change to an upstream method this adapter does
 * not call cannot break the build.
 */
export interface WrappedAgent {
  initialize(params: unknown): Promise<V1InitializeResponse>;
  newSession(params: unknown): Promise<Record<string, unknown>>;
  resumeSession(params: unknown): Promise<Record<string, unknown>>;
  loadSession(params: unknown): Promise<Record<string, unknown>>;
  listSessions(params: unknown): Promise<Record<string, unknown>>;
  prompt(params: unknown): Promise<{ stopReason?: string | null }>;
  cancel(params: unknown): Promise<void>;
  authenticate(params: unknown): Promise<unknown>;
  logout(params: unknown): Promise<unknown>;
  closeSession(params: unknown): Promise<Record<string, unknown>>;
  deleteSession(params: unknown): Promise<Record<string, unknown>>;
  setSessionConfigOption(params: unknown): Promise<Record<string, unknown>>;
  dispose?(): Promise<void>;
}

/** Builds the wrapped agent once the client it talks through exists. */
export type AgentFactory = (client: V2ClientShim, logger: Logger) => WrappedAgent;

export interface AdapterOptions {
  readonly logger?: Logger;
  readonly identity?: AdapterIdentity;
  /** Overridden in tests; production passes the real `ClaudeAcpAgent`. */
  readonly createAgent: AgentFactory;
  readonly fs?: FsBridge;
}

/**
 * What this adapter tells the wrapped agent about client filesystem support.
 *
 * Both true, and truthfully so: v2 clients have no `fs/*` surface, but {@link createNodeFsBridge}
 * services those calls locally, so claiming support is a promise the adapter keeps rather than
 * one it delegates. See `fs-bridge.ts` for why it is never exercised in practice.
 */
const FS_SUPPORT: FsSupport = { readTextFile: true, writeTextFile: true };

/** One connection's worth of state. */
class Connection {
  readonly shim: V2ClientShim;
  readonly turns: TurnTracker;
  readonly agent: WrappedAgent;
  /** Sessions this connection has opened, so an unknown id is a clean JSON-RPC error. */
  readonly live = new Set<string>();

  constructor(ctx: AgentContext, options: AdapterOptions) {
    const logger = options.logger ?? console;
    const fs = options.fs ?? createNodeFsBridge((method, path) =>
      logger.warn?.(
        `the wrapped agent called ${method} for ${path}; v2 has no client filesystem, ` +
          `so it was served locally. This is unexpected for this upstream version.`,
      ),
    );
    this.shim = new V2ClientShim(ctx, fs, logger);
    this.turns = new TurnTracker(this.shim, (sessionId, error) =>
      logger.error(`turn failed for session ${sessionId}`, error),
    );
    this.shim.attachTurnTracker(this.turns);
    this.agent = options.createAgent(this.shim, logger);
  }

  /** Records a session and seeds its translation state from a v1 lifecycle response. */
  adopt(sessionId: string, v1Response: Record<string, unknown>): void {
    this.live.add(sessionId);
    const options = v1Response["configOptions"];
    if (Array.isArray(options)) {
      this.shim.mapperFor(sessionId).rememberConfigOptions(options as V1ConfigOption[]);
    }
  }

  forget(sessionId: string): void {
    this.live.delete(sessionId);
    this.shim.forget(sessionId);
    this.turns.forget(sessionId);
  }

  /** Throws the JSON-RPC error v2 clients expect for an id this connection never opened. */
  requireLive(sessionId: string): void {
    if (!this.live.has(sessionId)) {
      throw new RequestError(-32602, `unknown session: ${sessionId}`);
    }
  }
}

/**
 * The v2 response for a v1 lifecycle response that carries config options.
 *
 * `session/new` answers `{ sessionId, configOptions? }` and `session/resume` answers
 * `{ configOptions? }`; both need the `id` -> `configId` rename that `tsc` cannot see.
 */
function lifecycleResponse(
  v1Response: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const response: Record<string, unknown> = { ...extra };
  const options = v1Response["configOptions"];
  if (Array.isArray(options)) {
    response["configOptions"] = toV2ConfigOptions(options as V1ConfigOption[]);
  }
  if (v1Response["_meta"] != null) response["_meta"] = v1Response["_meta"];
  return response;
}

/**
 * Register the eleven stable v2 agent methods.
 *
 * Exported so a test can drive the same registration over an in-memory stream rather than
 * stdio, and so the method set is one list in one place — `protocol.test.ts` compares it to the
 * vendored `meta.json`.
 */
export function registerHandlers(app: AgentApp, options: AdapterOptions): AgentApp {
  // One `Connection` per connect, created on the first handler call. `onConnect` would be the
  // natural home, but the wrapped agent needs the peer handle that only arrives with the
  // context, so this defers construction to first use and memoises it.
  let connection: Connection | undefined;
  const connectionFor = (ctx: AgentContext): Connection => {
    connection ??= new Connection(ctx, options);
    return connection;
  };

  return app
    .onRequest("initialize", async (ctx) => {
      const self = connectionFor(ctx.client);
      const v1 = await self.agent.initialize(toV1InitializeRequest(ctx.params, FS_SUPPORT));
      return toV2InitializeResponse(
        v1,
        options.identity ?? { name: "claude-agent-acp-v2", version: "0.0.0" },
      ) as never;
    })

    .onRequest("session/new", async (ctx) => {
      const self = connectionFor(ctx.client);
      const v1 = await self.agent.newSession(toV1NewSession(ctx.params as never));
      const sessionId = String(v1["sessionId"]);
      self.adopt(sessionId, v1);
      return lifecycleResponse(v1, { sessionId }) as never;
    })

    .onRequest("session/resume", async (ctx) => {
      const self = connectionFor(ctx.client);
      const plan = toV1Resume(ctx.params as never);
      if (plan.kind === "unsupported-cursor") {
        // The schema requires rejection rather than a guess; the raw cursor travels back in
        // `data` so the client can see exactly what was not understood.
        throw new RequestError(-32602, "unsupported replayFrom cursor", {
          replayFrom: plan.replayFrom,
        });
      }
      const v1 = await self.agent[plan.method](plan.params);
      self.adopt(String((ctx.params as Record<string, unknown>)["sessionId"]), v1);
      return lifecycleResponse(v1) as never;
    })

    .onRequest("session/prompt", (ctx) => {
      const self = connectionFor(ctx.client);
      const params = ctx.params as Record<string, unknown>;
      const sessionId = String(params["sessionId"]);
      // Validated *before* acknowledging: once `{}` goes out there is no error channel left,
      // and "unknown session" is the one failure a client can act on.
      self.requireLive(sessionId);

      self.shim.mapperFor(sessionId).beginTurn();
      // Deliberately not awaited. v2's `session/prompt` response is an acknowledgement; the
      // turn ends later with an idle `state_update`. `TurnTracker.run` never rejects, so there
      // is no unhandled rejection behind this `void`.
      void self.turns.run(sessionId, () => self.agent.prompt(params));
      return {} as never;
    })

    .onNotification("session/cancel", async (ctx) => {
      const self = connectionFor(ctx.client);
      // Cancellation is confirmed by the idle `state_update` the in-flight turn will emit, not
      // by this notification — so nothing is sent back here even when the session is unknown.
      await self.agent.cancel(ctx.params);
    })

    .onRequest("session/list", async (ctx) => {
      const self = connectionFor(ctx.client);
      return (await self.agent.listSessions(ctx.params)) as never;
    })

    .onRequest("session/close", async (ctx) => {
      const self = connectionFor(ctx.client);
      const sessionId = String((ctx.params as Record<string, unknown>)["sessionId"]);
      const v1 = await self.agent.closeSession(ctx.params);
      self.forget(sessionId);
      return (v1 ?? {}) as never;
    })

    .onRequest("session/delete", async (ctx) => {
      const self = connectionFor(ctx.client);
      const sessionId = String((ctx.params as Record<string, unknown>)["sessionId"]);
      const v1 = await self.agent.deleteSession(ctx.params);
      self.forget(sessionId);
      return (v1 ?? {}) as never;
    })

    .onRequest("session/set_config_option", async (ctx) => {
      const self = connectionFor(ctx.client);
      const v1 = await self.agent.setSessionConfigOption(
        toV1SetConfigOption(ctx.params as never),
      );
      return lifecycleResponse(v1 ?? {}) as never;
    })

    .onRequest("auth/login", async (ctx) => {
      const self = connectionFor(ctx.client);
      return ((await self.agent.authenticate(ctx.params)) ?? {}) as never;
    })

    .onRequest("auth/logout", async (ctx) => {
      const self = connectionFor(ctx.client);
      return ((await self.agent.logout(ctx.params)) ?? {}) as never;
    });
}

/** A configured, unconnected v2 app. */
export function createV2App(options: AdapterOptions): AgentApp {
  return registerHandlers(agentApp({ name: "claude-agent-acp-v2" }), options);
}

/** Connect a configured app to a stream. */
export function connectV2(stream: Stream, options: AdapterOptions): ReturnType<AgentApp["connect"]> {
  return createV2App(options).connect(stream);
}
