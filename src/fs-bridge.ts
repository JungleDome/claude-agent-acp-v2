/**
 * The filesystem hole, and why it turns out not to be one here.
 *
 * v2 removes `fs/read_text_file` and `fs/write_text_file` from the client surface outright; the
 * migration guide's advice is to supply an MCP server instead. That reads like a serious
 * problem for this adapter, because the `AcpClient` interface the wrapped v1 agent is
 * constructed with still has both methods on it, and in v1 they are how an editor-hosted agent
 * reads a buffer the user has edited but not saved.
 *
 * Measured against the wrapped agent at 0.81.1, it is not a problem at all:
 *
 * - `clientCapabilities` is never consulted for `fs` anywhere in the compiled agent.
 * - `ClaudeAcpAgent.readTextFile` / `.writeTextFile` exist as public methods that forward to
 *   the client, and **nothing inside the package calls them**.
 *
 * Claude Code reaches the filesystem through its own `Read`/`Write`/`Edit` tools in the Claude
 * Agent SDK, not through ACP. So the unsaved-buffer semantics v2 gives up were never in play on
 * this path, and no MCP filesystem server needs to be required of the client.
 *
 * That is a fact about a version, not a law, so this module still provides a real
 * implementation rather than a thrower: if a later upstream release starts routing file access
 * through the client, the adapter keeps working instead of failing at the worst moment. Backing
 * it with `node:fs` grants nothing new — the wrapped agent already has direct filesystem access
 * as the same process user, through the tools it actually uses.
 *
 * {@link FsBridge.servedCalls} exists so the premise above is observable rather than assumed:
 * a non-zero count means upstream changed, and the adapter can say so.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** v1's `fs/read_text_file` params. `line` is 1-based; `limit` counts lines. */
export interface ReadTextFileParams {
  readonly path: string;
  readonly line?: number | null;
  readonly limit?: number | null;
  readonly sessionId?: string;
}

/** v1's `fs/write_text_file` params. */
export interface WriteTextFileParams {
  readonly path: string;
  readonly content: string;
  readonly sessionId?: string;
}

export interface FsBridge {
  readTextFile(params: ReadTextFileParams): Promise<{ content: string }>;
  writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>>;
  /**
   * How many times the wrapped agent has actually asked for filesystem work.
   *
   * Expected to stay at zero for the lifetime of a connection. See the module comment.
   */
  readonly servedCalls: number;
}

/** Notified the first time the bridge is used, so a changed upstream is visible, once. */
export type FsBridgeObserver = (method: "readTextFile" | "writeTextFile", path: string) => void;

class NodeFsBridge implements FsBridge {
  #servedCalls = 0;
  readonly #observer: FsBridgeObserver;

  constructor(observer: FsBridgeObserver) {
    this.#observer = observer;
  }

  get servedCalls(): number {
    return this.#servedCalls;
  }

  #record(method: "readTextFile" | "writeTextFile", path: string): void {
    this.#servedCalls += 1;
    if (this.#servedCalls === 1) this.#observer(method, path);
  }

  async readTextFile(params: ReadTextFileParams): Promise<{ content: string }> {
    this.#record("readTextFile", params.path);
    const whole = await readFile(params.path, "utf8");

    // `line` and `limit` are v1's windowed read. Applying them here rather than returning the
    // whole file matters for large files: the caller asked for a window and will treat what it
    // gets as that window.
    if (params.line == null && params.limit == null) return { content: whole };

    const lines = whole.split("\n");
    const from = params.line != null ? Math.max(0, params.line - 1) : 0;
    const to = params.limit != null ? from + params.limit : lines.length;
    return { content: lines.slice(from, to).join("\n") };
  }

  async writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>> {
    this.#record("writeTextFile", params.path);
    // v1 clients create the parent directory as a matter of course; a bridge that did not would
    // turn a working write into an ENOENT the agent has no way to interpret.
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, "utf8");
    return {};
  }
}

/**
 * A bridge backed by the local filesystem.
 *
 * `observer` is called once, on first use, so the adapter can log that an assumption about the
 * wrapped agent no longer holds without emitting a line per file.
 */
export function createNodeFsBridge(observer: FsBridgeObserver = () => {}): FsBridge {
  return new NodeFsBridge(observer);
}
