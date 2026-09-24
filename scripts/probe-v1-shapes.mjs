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
try {
  out.listSessions = await agent.listSessions({});
} catch (error) {
  out.listSessions = { error: error?.message };
}
out.updatesDuringSetup = updates;

writeFileSync("docs/mapping/EVIDENCE-v1-shapes.json", `${JSON.stringify(out, null, 2)}\n`);

console.log("wrote docs/mapping/EVIDENCE-v1-shapes.json");
console.log("  updates during setup:", updates.length);
console.log("  config options:", out.newSession?.configOptions?.map((o) => `${o.id}:${o.type}`).join(", "));
await agent.dispose?.();
process.exit(0);
