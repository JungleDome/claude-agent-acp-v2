/**
 * The library surface.
 *
 * Exported so the adapter can be embedded — a host that already owns its stdio, or a test that
 * wants to drive the v2 surface over an in-memory stream, needs `createV2App`/`connectV2`
 * rather than the binary. Everything else here is exported because it is independently useful
 * when *reading* the traffic this adapter produces, not because it is a stable API: the version
 * this targets is a draft, and so is this.
 */

export { createV2App, connectV2, registerHandlers } from "./app.js";
export type { AdapterOptions, AgentFactory, WrappedAgent } from "./app.js";

export {
  V2ClientShim,
  normalisePermissionOutcome,
  permissionDescription,
  permissionTitle,
} from "./client-shim.js";
export type { Logger, V1RequestPermissionRequest, V1SessionNotification } from "./client-shim.js";

export { TurnTracker, ERROR_STOP_REASON } from "./turn.js";
export type { StateSink, TurnState, V1PromptResult } from "./turn.js";

export { SessionUpdateMapper } from "./update-map.js";
export type { V1Update } from "./update-map.js";

export { toV2ConfigOption, toV2ConfigOptions, toV1ConfigOptionRequest } from "./config-options.js";
export type { V1ConfigOption } from "./config-options.js";

export { toV1McpServer, toV1McpServers, toV1NewSession, toV1Resume, toV1SetConfigOption } from "./inbound.js";
export type { ResumePlan } from "./inbound.js";

export { toV1InitializeRequest, toV2InitializeResponse, supported } from "./capabilities.js";
export type { AdapterIdentity, FsSupport, V1InitializeResponse } from "./capabilities.js";

export { ensurePermissionOptions, sanitiseElicitationRequest } from "./sanitise.js";

export { createNodeFsBridge, UnnegotiatedWriteError } from "./fs-bridge.js";
export type { FsBridge, FsBridgeObserver } from "./fs-bridge.js";

export {
  ADAPTER_PROTOCOL_VERSION,
  CANCEL_REQUEST_METHOD,
  EXCLUDED_DRAFT_METHODS,
  STABLE_AGENT_METHODS,
  STABLE_CLIENT_METHODS,
} from "./protocol.js";
export type { StableAgentMethod, StableClientMethod } from "./protocol.js";

export { VERSION } from "./index.js";
