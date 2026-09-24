import { writeFileSync } from "node:fs";
import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";
const updates = [];
const stub = {
  sessionUpdate: async (p) => { updates.push(p); },
  requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  readTextFile: async () => ({ content: "" }),
  writeTextFile: async () => ({}),
  createElicitation: async () => ({ outcome: { outcome: "cancelled" } }),
  completeElicitation: async () => {},
  extNotification: async () => {},
};
const agent = new ClaudeAcpAgent(stub, { log: () => {}, error: () => {}, warn: () => {} });
const out = {};
out.initialize = await agent.initialize({
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  clientInfo: { name: "probe", version: "0" },
});
out.newSession = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
try { out.listSessions = await agent.listSessions({}); } catch (e) { out.listSessions = { error: e?.message }; }
out.updatesDuringSetup = updates;
writeFileSync("docs/mapping/EVIDENCE-v1-shapes.json", JSON.stringify(out, null, 2));
console.log("wrote evidence. updates during setup:", updates.length);
console.log("modes:", out.newSession?.modes?.availableModes?.map(m => m.id).join(", "));
console.log("newSession keys:", Object.keys(out.newSession).join(", "));
await agent.dispose?.();
process.exit(0);
