/**
 * v2 request params -> v1 request params.
 *
 * The client-to-agent direction, and the quieter half of the adapter: most v2 requests are
 * already shaped the way the wrapped v1 agent wants them. Three are not, and each would fail in
 * a different way if forwarded untouched.
 *
 * 1. **MCP servers.** v2 requires a `type` discriminator on every entry and removed the `sse`
 *    transport. v1's stdio server is the union's *untagged* member — it has no `type` field at
 *    all — and it makes `args` and `env` **required**, where v2 makes both optional. So a
 *    perfectly valid v2 `{ type: "stdio", name, command }` is invalid v1 twice over.
 * 2. **Session resume.** v2 deleted `session/load`; `session/resume` does both jobs and picks
 *    between them with `replayFrom`. The wrapped agent still has the two v1 methods, so the
 *    choice of which to call is made here.
 * 3. **`mcpServers` itself.** Required in v1's `session/new`, optional in v2's.
 */

import { toV1ConfigOptionRequest } from "./config-options.js";

/** A v2 MCP server entry, read structurally. */
type V2McpServer = Record<string, unknown>;

/**
 * One MCP server, in v1 spelling.
 *
 * `args` and `env` are defaulted rather than omitted because v1's `McpServerStdio` requires
 * them; a v2 client that sensibly left them out would otherwise produce a request the wrapped
 * agent rejects.
 */
export function toV1McpServer(server: V2McpServer): Record<string, unknown> {
  const { type, ...rest } = server as { type?: unknown; [key: string]: unknown };

  if (type === "http") {
    return { ...rest, type: "http", headers: rest["headers"] ?? [] };
  }

  if (type === "stdio" || type === undefined) {
    // v1's stdio member is untagged: carrying `type: "stdio"` across would add a key v1's union
    // does not define on that branch.
    return { ...rest, args: rest["args"] ?? [], env: rest["env"] ?? [] };
  }

  // An `sse` server cannot arrive from a conformant v2 client (the transport was removed), and
  // an unknown tag belongs to a future variant. Either way, passing it through unchanged lets
  // the wrapped agent decide, which is better than this adapter guessing a shape for it.
  return { ...rest, type };
}

/** Every MCP server in a request, defaulted to the empty list v1 requires. */
export function toV1McpServers(servers: unknown): Record<string, unknown>[] {
  if (!Array.isArray(servers)) return [];
  return servers.filter(isRecord).map(toV1McpServer);
}

/** v2 `session/new` -> v1 `session/new`. */
export function toV1NewSession(params: Record<string, unknown>): Record<string, unknown> {
  const v1: Record<string, unknown> = {
    cwd: params["cwd"],
    // Required in v1, optional in v2.
    mcpServers: toV1McpServers(params["mcpServers"]),
  };
  if (Array.isArray(params["additionalDirectories"])) {
    v1["additionalDirectories"] = params["additionalDirectories"];
  }
  if (params["_meta"] != null) v1["_meta"] = params["_meta"];
  return v1;
}

/**
 * Which v1 method a v2 `session/resume` means, and with what params.
 *
 * v2 folded v1's two reattachment methods into one. The `replayFrom` cursor is what distinguishes
 * them: `{ "type": "start" }` asks the agent to replay the session's history, which is exactly
 * what v1's `session/load` does, while an omitted `replayFrom` asks it to resume without
 * replaying, which is v1's `session/resume`.
 *
 * Getting this backwards is not a crash — it is a session that silently loses its history, or
 * one that duplicates every message a client already had.
 */
export function toV1Resume(params: Record<string, unknown>): {
  method: "loadSession" | "resumeSession";
  params: Record<string, unknown>;
} {
  const replayFrom = params["replayFrom"];
  const wantsReplay = isRecord(replayFrom) && replayFrom["type"] === "start";

  const v1: Record<string, unknown> = {
    sessionId: params["sessionId"],
    cwd: params["cwd"],
    mcpServers: toV1McpServers(params["mcpServers"]),
  };
  if (Array.isArray(params["additionalDirectories"])) {
    v1["additionalDirectories"] = params["additionalDirectories"];
  }
  if (params["_meta"] != null) v1["_meta"] = params["_meta"];

  // An unrecognised `replayFrom` variant (v2's ReplayFrom union is open) is treated as "no
  // replay" rather than as "replay from the start": resuming without history is recoverable by
  // asking again, while replaying history a client did not ask for corrupts its transcript.
  return { method: wantsReplay ? "loadSession" : "resumeSession", params: v1 };
}

/** v2 `session/set_config_option` -> v1. Delegates the awkward part to `config-options.ts`. */
export function toV1SetConfigOption(params: Record<string, unknown>): Record<string, unknown> {
  return toV1ConfigOptionRequest({
    sessionId: String(params["sessionId"]),
    configId: String(params["configId"]),
    ...(typeof params["type"] === "string" ? { type: params["type"] } : {}),
    value: params["value"],
    ...(params["_meta"] != null ? { _meta: params["_meta"] as Record<string, unknown> } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
