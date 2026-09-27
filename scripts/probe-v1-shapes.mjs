/**
 * Capture the wrapped agent's real v1 shapes, as the adapter actually asks for them.
 *
 * `docs/mapping/EVIDENCE-v1-shapes.json` is used directly as test input, so what it is evidence
 * *of* matters as much as its contents. A v1 response is not a fixed fact about the agent — it
 * is a function of the `clientCapabilities` sent down. `createFastModeConfigOption`, for one,
 * returns a two-value `select` or a `boolean` depending on what the client advertised, so a
 * capture taken under a hand-written capability set describes a client that does not exist.
 *
 * So this probe sends exactly what the adapter sends, by calling the adapter's own
 * `toV1InitializeRequest`, and records that request inside the evidence file beside the
 * responses. A reader never has to guess, and a later change to the downward capabilities makes
 * the evidence visibly stale rather than quietly wrong.
 *
 * Run with: node scripts/probe-v1-shapes.mjs
 */

import { writeFileSync } from "node:fs";
import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";

import { toV1InitializeRequest } from "../dist/capabilities.js";
import { createNodeFsBridge } from "../dist/fs-bridge.js";

const updates = [];
const stub = {
  sessionUpdate: async (params) => {
    updates.push(params);
  },
  requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  readTextFile: async () => ({ content: "" }),
  writeTextFile: async () => ({}),
  createElicitation: async () => ({ outcome: { outcome: "cancel" } }),
  completeElicitation: async () => {},
  extNotification: async () => {},
};

const fs = createNodeFsBridge();

/** The v2 request a client would send us, shaped like a real one. */
const v2Request = {
  protocolVersion: 2,
  info: { name: "acp-v2-probe", version: "0.1.0" },
  capabilities: { elicitation: {} },
};

/** What the adapter turns that into — the exact bytes the wrapped agent will see. */
const v1Request = toV1InitializeRequest(v2Request, {
  readTextFile: true,
  writeTextFile: fs.writesEnabled,
});

const agent = new ClaudeAcpAgent(stub, { log: () => {}, error: () => {}, warn: () => {} });

const out = {
  capturedUnder: {
    note:
      "The v1 initialize request the adapter actually sent. A v1 response is a function of " +
      "these capabilities, so the responses below are evidence only of this input.",
    v2Request,
    v1Request,
  },
};

out.initialize = await agent.initialize(v1Request);
out.newSession = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

// `session/list` and the setup notifications are captured as SHAPE ONLY, never as content.
//
// Both carry real user data: `listSessions` returns every Claude session on the machine with
// its title and working directory, and `available_commands_update` enumerates the operator's
// installed commands. None of it is needed — the tests read `initialize` alone — and this file
// is committed, so capturing it verbatim would put a list of someone's private projects into a
// repository. Shape is the part that is evidence; content is the part that is a leak.
const shapeOf = (value) => {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v)]));
  }
  return typeof value;
};

try {
  const sessions = await agent.listSessions({});
  out.listSessionsShape = {
    note: "Shape only. Real session titles and working directories are deliberately not captured.",
    count: Array.isArray(sessions?.sessions) ? sessions.sessions.length : 0,
    entryShape: shapeOf(sessions?.sessions?.[0] ?? {}),
  };
} catch (error) {
  out.listSessionsShape = { error: error?.message };
}

out.updatesDuringSetupShape = {
  note: "Shape only. Command names and descriptions are the operator's, not the protocol's.",
  variants: updates.map((u) => u?.update?.sessionUpdate),
  shapes: updates.map((u) => shapeOf(u?.update)),
};

writeFileSync("docs/mapping/EVIDENCE-v1-shapes.json", `${JSON.stringify(out, null, 2)}\n`);

console.log("wrote docs/mapping/EVIDENCE-v1-shapes.json");
console.log("  updates during setup:", updates.length, "(shape only)");
console.log("  config options:", out.newSession?.configOptions?.map((o) => `${o.id}:${o.type}`).join(", "));
await agent.dispose?.();
process.exit(0);
