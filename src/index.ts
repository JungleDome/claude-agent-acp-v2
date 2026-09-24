#!/usr/bin/env node
/**
 * The `claude-agent-acp-v2` binary: ACP v2 over stdio.
 *
 * Everything interesting is in `app.ts`. This file exists to do the three things a process
 * entry point does and nothing else — wrap stdio as a stream, name the real agent, and keep
 * diagnostics off the protocol channel.
 */

import { ClaudeAcpAgent, nodeToWebReadable, nodeToWebWritable } from "@agentclientprotocol/claude-agent-acp";
import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";

import { connectV2 } from "./app.js";
import type { Logger } from "./client-shim.js";
import type { WrappedAgent } from "./app.js";

/**
 * Diagnostics go to stderr, always.
 *
 * `console.log` writes to stdout, which on this process *is the protocol stream*. A single
 * stray log line there is a JSON parse error at the client and a dead connection, so the
 * adapter never uses the default console.
 */
const stderrLogger: Logger = {
  log: (...args: unknown[]) => console.error(...args),
  error: (...args: unknown[]) => console.error(...args),
  warn: (...args: unknown[]) => console.error(...args),
};

export function main(): void {
  const stream = ndJsonStream(nodeToWebWritable(process.stdout), nodeToWebReadable(process.stdin));

  connectV2(stream, {
    logger: stderrLogger,
    identity: {
      name: "claude-agent-acp-v2",
      title: "Claude Agent (ACP v2)",
      version: VERSION,
    },
    createAgent: (client, logger) =>
      // The wrapped agent is upstream's published class, unmodified. It is handed our v2-backed
      // client and never learns which protocol version its peer speaks.
      new ClaudeAcpAgent(client as never, logger as never) as unknown as WrappedAgent,
  });
}

/** Kept in step with package.json by `version.test.ts`. */
export const VERSION = "0.1.0";

// `import.meta.main` is Node 24+; the argv comparison keeps Node 22 working.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (invokedDirectly) {
  main();
}
