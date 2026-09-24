/**
 * The handshake, both directions.
 *
 * v2 reshapes `initialize` in three ways that matter here:
 *
 * 1. The fields are **role-agnostic**. v1 sent `clientCapabilities`/`clientInfo` up and
 *    `agentCapabilities`/`agentInfo` down; v2 sends `capabilities`/`info` in both directions
 *    and `info` is **required** on both sides.
 * 2. Every capability marker is an **object whose presence means supported**. A v2 reader must
 *    test `x != null`, never `x === true`. The v1 adapter we wrap already emits most of its
 *    markers this way (`sessionCapabilities: { close: {}, delete: {}, ... }`), which is why
 *    most of this file is a move rather than a conversion — but `loadSession: true` proves the
 *    v1 surface still mixes booleans in, so nothing here may assume the object form.
 * 3. Several v1 markers describe methods that are **baseline** in v2. An agent that advertises
 *    `capabilities.session` at all is committed to `session/new`, `session/list`,
 *    `session/resume`, `session/close`, `session/prompt` and `session/cancel`. Re-advertising
 *    them as markers would be wrong, not merely redundant: `SessionCapabilities` has no
 *    `list`, `resume` or `close` member to put them in.
 *
 * Every object here is built by assignment rather than by conditional spread. Under
 * `exactOptionalPropertyTypes` the spread idiom widens each optional field to include
 * `undefined`, which is exactly the distinction v2's "omitted vs null vs concrete" semantics
 * rest on — so the stricter construction is not a style preference, it is the one that keeps
 * "absent" and "present but undefined" from collapsing into each other.
 */

import type {
  AgentAuthCapabilities,
  AgentCapabilities as V2AgentCapabilities,
  AuthMethod as V2AuthMethod,
  ClientCapabilities as V2ClientCapabilities,
  Implementation as V2Implementation,
  InitializeRequest as V2InitializeRequest,
  InitializeResponse as V2InitializeResponse,
  McpCapabilities,
  PromptCapabilities,
  SessionAdditionalDirectoriesCapabilities,
  SessionCapabilities as V2SessionCapabilities,
  SessionDeleteCapabilities,
} from "@agentclientprotocol/sdk/experimental/v2";

import { ADAPTER_PROTOCOL_VERSION } from "./protocol.js";

/**
 * The v1 `initialize` response, read structurally.
 *
 * Declared here rather than imported from the v1 SDK on purpose: this adapter consumes the v1
 * agent as a *library*, and the only v1 types it should depend on are the ones it actually
 * reads. A structural type also keeps the two SDK copies in the tree (the wrapped agent
 * resolves its own `@agentclientprotocol/sdk`, our v2 code resolves ours) from having to be
 * nominally identical.
 */
export interface V1InitializeResponse {
  readonly protocolVersion: number;
  readonly agentCapabilities?: V1AgentCapabilities | null;
  readonly agentInfo?: V1Implementation | null;
  readonly authMethods?: readonly unknown[] | null;
  readonly _meta?: Record<string, unknown> | null;
}

interface V1Implementation {
  readonly name?: string | null;
  readonly title?: string | null;
  readonly version?: string | null;
}

interface V1AgentCapabilities {
  readonly promptCapabilities?: unknown;
  readonly mcpCapabilities?: unknown;
  readonly sessionCapabilities?: Record<string, unknown> | null;
  readonly auth?: unknown;
  readonly loadSession?: unknown;
  readonly _meta?: Record<string, unknown> | null;
}

/**
 * v2's support test, applied once and named.
 *
 * `x != null` is the whole rule, but writing it inline at nine call sites is how one of them
 * ends up as `x === true` during a later edit and silently drops a capability.
 */
export function supported(marker: unknown): boolean {
  return marker != null;
}

/**
 * A v1 marker re-expressed as the v2 marker object for its slot.
 *
 * v1 spells support three ways — `true`, `{}`, and a populated object — and v2 spells it one
 * way. Callers guard with {@link supported} first; this only converts. The cast is the point
 * of the function: a v1 marker's *contents* are not v2-typed, but v2 marker objects are open
 * (every one carries `_meta` and optional members), so carrying the payload through preserves
 * information a stricter conversion would drop on the floor.
 */
function marker<T>(v1Marker: unknown): T {
  const payload =
    typeof v1Marker === "object" && v1Marker !== null
      ? { ...(v1Marker as Record<string, unknown>) }
      : {};
  return payload as T;
}

/**
 * What we tell the wrapped v1 agent about the client's filesystem support.
 *
 * v2 has no `fs/read_text_file` or `fs/write_text_file`, so this is never a passthrough of
 * something the v2 client said — it is a statement about what *this adapter* will service on
 * the client's behalf. See `fs-bridge.ts` for who actually answers.
 */
export interface FsSupport {
  readonly readTextFile: boolean;
  readonly writeTextFile: boolean;
}

/**
 * v2 `initialize` params, as the wrapped v1 agent needs to see them.
 *
 * The v1 agent stores `clientCapabilities` and consults it for the rest of the connection, so
 * this is the one place that decides what it believes about its client for good.
 */
export function toV1InitializeRequest(
  request: V2InitializeRequest,
  fs: FsSupport,
): Record<string, unknown> {
  const capabilities: V2ClientCapabilities | undefined = request.capabilities ?? undefined;

  const clientCapabilities: Record<string, unknown> = {
    // v1 expresses fs support as a nested pair of booleans. v2 clients never send this, so the
    // value is ours to assert — and asserting `true` here is a promise `fs-bridge.ts` keeps.
    fs: { readTextFile: fs.readTextFile, writeTextFile: fs.writeTextFile },
    // v2 removed the client terminal surface outright. Telling v1 `false` is not a limitation
    // we are imposing; it is the accurate statement that no v2 client has one.
    terminal: false,
  };
  if (supported(capabilities?.elicitation)) {
    clientCapabilities["elicitation"] = marker<Record<string, unknown>>(capabilities?.elicitation);
  }
  if (supported(capabilities?.auth)) {
    clientCapabilities["auth"] = marker<Record<string, unknown>>(capabilities?.auth);
  }

  const clientInfo: Record<string, unknown> = {
    name: request.info.name,
    version: request.info.version,
  };
  if (request.info.title != null) clientInfo["title"] = request.info.title;

  const v1Request: Record<string, unknown> = {
    // We speak v1 downward unconditionally. The version we negotiated *upward* is 2, and the
    // two numbers are deliberately unrelated: this argument describes the wrapped agent's
    // wire, not ours.
    protocolVersion: 1,
    clientCapabilities,
    clientInfo,
  };
  if (request._meta != null) v1Request["_meta"] = request._meta;
  return v1Request;
}

/** Identity for this adapter, used when the wrapped agent declines to name itself. */
export interface AdapterIdentity {
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}

/**
 * The v1 response, reshaped into v2.
 *
 * `info` is **required** in v2 while `agentInfo` is optional in v1, so this cannot be a
 * passthrough: a v1 agent that omits it would otherwise produce a v2 response that fails its
 * own schema. The fallback names the adapter, which is honest — if the wrapped agent did not
 * identify itself, the only implementation we can truthfully name is this one.
 */
export function toV2InitializeResponse(
  response: V1InitializeResponse,
  identity: AdapterIdentity,
): V2InitializeResponse {
  const v1 = response.agentCapabilities ?? {};
  const v1Session = v1.sessionCapabilities ?? {};

  const session: V2SessionCapabilities = {};
  if (supported(v1.promptCapabilities)) {
    session.prompt = marker<PromptCapabilities>(v1.promptCapabilities);
  }
  if (supported(v1.mcpCapabilities)) {
    session.mcp = mcpCapabilitiesToV2(v1.mcpCapabilities);
  }
  if (supported(v1Session["delete"])) {
    session.delete = marker<SessionDeleteCapabilities>(v1Session["delete"]);
  }
  if (supported(v1Session["additionalDirectories"])) {
    session.additionalDirectories = marker<SessionAdditionalDirectoriesCapabilities>(
      v1Session["additionalDirectories"],
    );
  }
  // `list`, `resume` and `close` are deliberately absent: v2 makes them baseline obligations of
  // advertising `session` at all, and `SessionCapabilities` has no member for them. `fork` is
  // deliberately absent too — it lives only in the draft superset (see `protocol.ts`).

  const capabilities: V2AgentCapabilities = { session };
  if (supported(v1.auth)) {
    capabilities.auth = marker<AgentAuthCapabilities>(v1.auth);
  }

  const info: V2Implementation = {
    name: response.agentInfo?.name ?? identity.name,
    version: response.agentInfo?.version ?? identity.version,
  };
  const title = response.agentInfo?.title ?? identity.title;
  if (title != null) info.title = title;

  const v2Response: V2InitializeResponse = {
    protocolVersion: ADAPTER_PROTOCOL_VERSION,
    info,
    capabilities,
  };

  // v2 reads a non-empty `authMethods` as the advertisement that `auth/login` and `auth/logout`
  // are supported, so an empty list is omitted rather than sent empty: the two describe the
  // same fact, but only one of them is the spelling v2 defines.
  const authMethods = response.authMethods ?? [];
  if (authMethods.length > 0) {
    v2Response.authMethods = authMethods as V2AuthMethod[];
  }
  if (response._meta != null) {
    v2Response._meta = response._meta;
  }
  return v2Response;
}

/**
 * v1 `mcpCapabilities` minus the transport v2 deleted.
 *
 * v1 advertises `{ http: true, sse: true }`. v2 removed the `sse` transport entirely, so
 * carrying the flag through would advertise a transport no v2 client can ask for — and, worse,
 * would do it in the object-presence dialect where any value at the key reads as support.
 */
function mcpCapabilitiesToV2(v1Mcp: unknown): McpCapabilities {
  const source = marker<Record<string, unknown>>(v1Mcp);
  delete source["sse"];
  return source as McpCapabilities;
}
