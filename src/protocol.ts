/**
 * The stable ACP v2 surface this adapter serves.
 *
 * Two things are true of v2 at once: `@agentclientprotocol/sdk/experimental/v2` exports a
 * `methods` tree covering the **draft superset** (`providers/*`, `mcp/*`, `nes/*`,
 * `document/*`, `session/fork`), and the published `schema/v2/meta.json` names a much smaller
 * **stable baseline**. The migration guide is explicit that negotiating `protocolVersion: 2`
 * implies none of the draft features, so this module fixes the baseline as data and every
 * handler registration reads it from here.
 *
 * Keeping the list here rather than inline at the registration site is what makes
 * `protocol.test.ts` able to assert it equals the vendored `meta.json` — an inline list can
 * only be eyeballed.
 */

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";

/** The ACP protocol version this adapter speaks. Sourced from the SDK, never restated. */
export const ADAPTER_PROTOCOL_VERSION: 2 = PROTOCOL_VERSION;

/**
 * The eleven agent methods of the stable v2 baseline, verbatim from `schema/v2/meta.json`.
 *
 * An agent that advertises `capabilities.session` at all is committed to `session/new`,
 * `session/list`, `session/resume`, `session/close`, `session/prompt` and `session/cancel`;
 * only `session.delete` and the `session.prompt.*` / `session.mcp.*` markers are
 * capability-gated. That is why this set is flat rather than split by capability.
 */
export const STABLE_AGENT_METHODS = [
  "initialize",
  "auth/login",
  "auth/logout",
  "session/new",
  "session/list",
  "session/resume",
  "session/close",
  "session/delete",
  "session/prompt",
  "session/cancel",
  "session/set_config_option",
] as const;

/** The four client methods of the stable v2 baseline. */
export const STABLE_CLIENT_METHODS = [
  "session/update",
  "session/request_permission",
  "elicitation/create",
  "elicitation/complete",
] as const;

/** The one protocol method, which is neither an agent nor a client method. */
export const CANCEL_REQUEST_METHOD = "$/cancel_request" as const;

export type StableAgentMethod = (typeof STABLE_AGENT_METHODS)[number];
export type StableClientMethod = (typeof STABLE_CLIENT_METHODS)[number];

/**
 * The draft-superset methods this adapter deliberately does **not** serve.
 *
 * Recorded as data rather than as a comment so the test can assert the two sets are disjoint
 * and that nothing here is ever registered. Dropping a name from this list is then a visible
 * diff rather than a silent widening of the surface.
 */
export const EXCLUDED_DRAFT_METHODS = [
  "session/fork",
  "providers/list",
  "providers/set",
  "providers/disable",
  "mcp/message",
  "mcp/connect",
  "mcp/disconnect",
  "nes/start",
  "nes/suggest",
  "nes/accept",
  "nes/reject",
  "nes/close",
  "document/didOpen",
  "document/didChange",
  "document/didClose",
  "document/didSave",
  "document/didFocus",
] as const;
