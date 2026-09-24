/**
 * The filesystem hole, and why it turns out not to be one here.
 *
 * v2 removes `fs/read_text_file` and `fs/write_text_file` from the client surface outright; the
 * migration guide's advice is to supply an MCP server instead. That reads like a serious
 * problem for this adapter, because the `AcpClient` interface the wrapped v1 agent is
 * constructed with declares both methods **non-optionally**, so there is no way to construct
 * `ClaudeAcpAgent` without supplying something.
 *
 * Measured against the wrapped agent at 0.81.1, the methods are unreachable:
 *
 * - `clientCapabilities` is never consulted for `fs` anywhere in the compiled agent.
 * - `ClaudeAcpAgent.readTextFile` / `.writeTextFile` are one-line pass-throughs on the public
 *   class surface, and **nothing inside the package calls them**.
 * - There is no ACP-backed filesystem MCP server either. An earlier adapter generation exposed
 *   `Read`/`Write`/`Edit` as MCP tools proxying to the client; 0.81.1 does not. File I/O for
 *   the model happens inside the Claude Code subprocess against the real disk, gated by
 *   `session/request_permission`.
 *
 * So the unsaved-editor-buffer semantics v2 gives up were never in play on this path.
 *
 * **Reads degrade; writes refuse.** The asymmetry is deliberate, and it is about authority
 * rather than convenience:
 *
 * - A read through `node:fs` grants nothing the Claude subprocess does not already have. The
 *   worst case is staleness — the saved file rather than an unsaved buffer — and failing
 *   instead would turn a degraded answer into an error.
 * - A write through `node:fs` *does* grant new authority: it is the only path in this adapter
 *   that could mutate a user's files without a `session/request_permission` round trip.
 *   Refusing is recoverable; a silent unapproved write is not. Because the path is unreachable
 *   in the pinned version, the refusal costs nothing today and guarantees we find out the
 *   moment an upstream bump starts using it.
 *
 * `allowUnnegotiatedDiskWrites` exists so an operator who wants the old behaviour can have it
 * deliberately, rather than by patching this file.
 *
 * All of the above rests on a measurement of one pinned version, which is why
 * `fs-bridge.test.ts` asserts the call-site count against the resolved package: an npm bump
 * that reintroduces an internal caller turns that test red before it turns production silent.
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
  /** Whether this bridge will perform a write, for the honest downward capability report. */
  readonly writesEnabled: boolean;
}

/** Notified the first time the bridge is used, so a changed upstream is visible, once. */
export type FsBridgeObserver = (method: "readTextFile" | "writeTextFile", path: string) => void;

export interface FsBridgeOptions {
  readonly observer?: FsBridgeObserver;
  /**
   * Permit writes straight to disk, bypassing any permission prompt.
   *
   * Off by default. See the module comment for why reads and writes are treated differently.
   */
  readonly allowUnnegotiatedDiskWrites?: boolean;
}

/** Thrown when the wrapped agent attempts a write this bridge will not perform. */
export class UnnegotiatedWriteError extends Error {
  constructor(path: string) {
    super(
      `refusing to write ${path}: ACP v2 has no client filesystem, so this write would ` +
        `bypass the permission round trip that normally gates file changes. Set ` +
        `allowUnnegotiatedDiskWrites to permit it deliberately.`,
    );
    this.name = "UnnegotiatedWriteError";
  }
}

class NodeFsBridge implements FsBridge {
  #servedCalls = 0;
  readonly #observer: FsBridgeObserver;
  readonly writesEnabled: boolean;

  constructor(options: FsBridgeOptions) {
    this.#observer = options.observer ?? ((): void => {});
    this.writesEnabled = options.allowUnnegotiatedDiskWrites ?? false;
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
    if (!this.writesEnabled) {
      throw new UnnegotiatedWriteError(params.path);
    }
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
 * `observer` is called once, on first use, so the adapter can report that an assumption about
 * the wrapped agent no longer holds without emitting a line per file.
 */
export function createNodeFsBridge(options: FsBridgeOptions = {}): FsBridge {
  return new NodeFsBridge(options);
}
