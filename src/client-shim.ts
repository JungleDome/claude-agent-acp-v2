/**
 * `AcpClient`, implemented over a v2 connection.
 *
 * The wrapped v1 agent was built to talk to a v1 client through a seven-method interface. This
 * class is that interface, with a v2 peer on the other side of it — which is the whole reason
 * the adapter needs no fork: the agent never learns that its client speaks a different protocol
 * version.
 *
 * Four of the seven methods are near-passthroughs. The three that are not:
 *
 * - `sessionUpdate` fans one v1 update out to zero or more v2 updates (see `update-map.ts`).
 * - `requestPermission` must synthesise the `title` v2 made required and wrap v1's bare
 *   `toolCall` in v2's tagged `subject`.
 * - `readTextFile`/`writeTextFile` have no v2 counterpart at all and are served locally
 *   (see `fs-bridge.ts`, which also records that the wrapped agent never actually calls them).
 *
 * The shim is also the {@link StateSink} the turn tracker writes through, so every notification
 * this adapter sends — content and lifecycle alike — leaves through one method and one ordering
 * discipline.
 */

import type {
  AgentContext,
  SessionUpdate,
  StateUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";

import { SessionUpdateMapper, type V1Update } from "./update-map.js";
import type { FsBridge, ReadTextFileParams, WriteTextFileParams } from "./fs-bridge.js";
import type { StateSink } from "./turn.js";
import type { TurnTracker } from "./turn.js";

/** The v1 notification shape the wrapped agent hands us. */
export interface V1SessionNotification {
  readonly sessionId: string;
  readonly update: V1Update;
}

/** v1's permission request: a bare tool call and the options to answer with. */
export interface V1RequestPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: Record<string, unknown>;
  readonly options: readonly unknown[];
  readonly _meta?: Record<string, unknown> | null;
}

export interface Logger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * The fallback title for a permission request.
 *
 * v2 made `title` required because a client has to put *something* in the dialog. v1 carries a
 * title on the tool call only optionally, so a fallback is not defensive programming here — it
 * is the difference between a valid request and a schema violation at the moment a user is
 * being asked to approve something.
 */
const PERMISSION_FALLBACK_TITLE = "Permission required";

export class V2ClientShim implements StateSink {
  readonly #ctx: AgentContext;
  readonly #fs: FsBridge;
  readonly #logger: Logger;
  readonly #mappers = new Map<string, SessionUpdateMapper>();
  /** Set late: the tracker needs the shim to construct, and the shim needs the tracker. */
  #turns: TurnTracker | undefined;

  constructor(ctx: AgentContext, fs: FsBridge, logger: Logger) {
    this.#ctx = ctx;
    this.#fs = fs;
    this.#logger = logger;
  }

  /** Completes the cycle between shim and tracker, once both exist. */
  attachTurnTracker(turns: TurnTracker): void {
    this.#turns = turns;
  }

  /** The mapper for a session, created on first sight. */
  mapperFor(sessionId: string): SessionUpdateMapper {
    let mapper = this.#mappers.get(sessionId);
    if (mapper === undefined) {
      mapper = new SessionUpdateMapper(sessionId);
      this.#mappers.set(sessionId, mapper);
    }
    return mapper;
  }

  /** Drop a closed or deleted session's translation state. */
  forget(sessionId: string): void {
    this.#mappers.delete(sessionId);
  }

  // --- the seven AcpClient methods -----------------------------------------------------

  /**
   * One v1 update becomes zero or more v2 updates, sent in order.
   *
   * Awaiting each `notify` is what keeps a turn's content ahead of the `idle` state update that
   * ends it: the wrapped agent's `prompt()` does not resolve until every notification it made
   * has been awaited through here, and the tracker only emits `idle` after that.
   */
  async sessionUpdate(params: V1SessionNotification): Promise<void> {
    const updates = this.mapperFor(params.sessionId).map(params.update);
    for (const update of updates) {
      await this.#notifyUpdate(params.sessionId, update);
    }
  }

  /**
   * v1's permission request, given the title and subject v2 requires.
   *
   * Wrapped in `requires_action` so a v2 client can distinguish "the agent is working" from
   * "the agent is waiting for you" — which is the reason v2 added the state.
   */
  async requestPermission(
    params: V1RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const toolCall = params.toolCall ?? {};
    const request: Record<string, unknown> = {
      sessionId: params.sessionId,
      title: permissionTitle(toolCall),
      subject: { type: "tool_call", toolCall },
      options: params.options,
    };
    const description = toolCall["description"];
    if (typeof description === "string" && description !== "") {
      request["description"] = description;
    }
    if (params._meta != null) request["_meta"] = params._meta;

    return this.#awaitingClient(params.sessionId, () =>
      this.#ctx.request(
        "session/request_permission",
        request as never,
        signal !== undefined ? { cancellationSignal: signal } : undefined,
      ),
    );
  }

  async createElicitation(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    const send = (): Promise<unknown> =>
      this.#ctx.request(
        "elicitation/create",
        params as never,
        signal !== undefined ? { cancellationSignal: signal } : undefined,
      );
    return sessionId === undefined ? send() : this.#awaitingClient(sessionId, send);
  }

  async completeElicitation(params: Record<string, unknown>): Promise<void> {
    await this.#ctx.notify("elicitation/complete", params as never);
  }

  readTextFile(params: ReadTextFileParams): Promise<{ content: string }> {
    return this.#fs.readTextFile(params);
  }

  writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>> {
    return this.#fs.writeTextFile(params);
  }

  /**
   * A custom notification, forwarded unchanged.
   *
   * v2 keeps `_`-prefixed extension methods and `_meta` exactly as v1 had them, so the wrapped
   * agent's own extensions (`_claude/sdkMessage`, the AIR and goal surfaces) continue to work
   * without this adapter needing to know what any of them mean.
   */
  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.#ctx.notify(method as never, params as never);
    } catch (error) {
      // An extension the peer does not implement must not take down the connection: these are
      // notifications, so there is nothing for the agent to do about a failure either way.
      this.#logger.warn?.(`extension notification ${method} failed`, error);
    }
  }

  // --- StateSink -----------------------------------------------------------------------

  /**
   * The turn tracker's transitions travel the same channel as content updates.
   *
   * The tracker deals in bare `StateUpdate`s (`{ state: "running" }`); becoming a
   * `SessionUpdate` means acquiring the `sessionUpdate: "state_update"` tag. Tagging here
   * rather than in the tracker keeps the tracker a state machine with no wire format in it.
   */
  async emitState(sessionId: string, update: StateUpdate): Promise<void> {
    await this.#notifyUpdate(sessionId, {
      ...update,
      sessionUpdate: "state_update",
    } as unknown as SessionUpdate);
  }

  // --- internals -----------------------------------------------------------------------

  async #notifyUpdate(sessionId: string, update: SessionUpdate): Promise<void> {
    await this.#ctx.notify("session/update", { sessionId, update } as never);
  }

  /**
   * Run an ask inside `requires_action`, if a tracker is attached.
   *
   * Tolerates the tracker being absent so the shim stays usable on its own — in tests, and in
   * the window before `attachTurnTracker` during connection setup.
   */
  #awaitingClient<T>(sessionId: string, ask: () => Promise<T>): Promise<T> {
    return this.#turns === undefined ? ask() : this.#turns.whileAwaitingClient(sessionId, ask);
  }
}

/**
 * A human-readable title for a permission dialog, from whatever v1 supplied.
 *
 * Preference order is what a user would want to read: the tool call's own title, then the tool
 * name, then a generic string. Returning an empty title would satisfy `tsc` and fail the
 * schema.
 */
export function permissionTitle(toolCall: Record<string, unknown>): string {
  const title = toolCall["title"];
  if (typeof title === "string" && title.trim() !== "") return title;

  const name = toolCall["name"];
  if (typeof name === "string" && name.trim() !== "") return name;

  return PERMISSION_FALLBACK_TITLE;
}
