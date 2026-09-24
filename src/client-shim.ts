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
import { ensurePermissionOptions, sanitiseElicitationRequest } from "./sanitise.js";
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
      title: permissionTitle(params),
      // Always sent, and always as a tool call. A client reads
      // `subject.toolCall.toolCallId` to attach the approval to the tool-call it is about, so
      // omitting the subject costs that linkage. The `command` subject is not used: v2 makes
      // its `cwd` required and the v1 request does not carry one — the session cwd is not the
      // command's, since a shell can change directory.
      subject: { type: "tool_call", toolCall },
      // v2 requires at least one option; v1 sets no lower bound.
      options: ensurePermissionOptions(params.options),
    };

    const description = permissionDescription(params);
    if (description !== undefined) request["description"] = description;
    // Forwarded verbatim, which does mean `title` and `description` travel twice for a client
    // that already understood `_meta.permission`. That is the lesser cost: `defaultToNo` has no
    // v2 field at all and lives only here, and the schema's guidance for a proxy is to preserve
    // raw payloads rather than edit them.
    if (params._meta != null) request["_meta"] = params._meta;

    const offered = new Set(
      params.options
        .map((option) => (option as { optionId?: unknown })?.optionId)
        .filter((id): id is string => typeof id === "string"),
    );

    const outcome = await this.#awaitingClient(params.sessionId, () =>
      this.#ctx
        .request(
          "session/request_permission",
          request as never,
          signal !== undefined ? { cancellationSignal: signal } : undefined,
        )
        .catch((error: unknown) => {
          // -32800 is v2's "request cancelled". The wrapped agent understands a cancelled
          // permission; it does not understand a transport error, and would fail the whole
          // tool call over one.
          if (isRequestCancelled(error)) return { outcome: { outcome: "cancelled" } };
          throw error;
        }),
    );

    return normalisePermissionOutcome(outcome, offered, this.#logger);
  }

  async createElicitation(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    // An MCP server's `requestedSchema` reaches this point unvalidated, and v2 added cardinality
    // constraints v1 never had. Rewriting is better than letting the frame be rejected while a
    // user waits to be asked something.
    const sanitised = sanitiseElicitationRequest(params, (what) =>
      this.#logger.warn?.(`elicitation schema rewritten for ACP v2: ${what}`),
    );
    const send = (): Promise<unknown> =>
      this.#ctx.request(
        "elicitation/create",
        sanitised as never,
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
    if (!method.startsWith("_")) {
      // v2 reserves bare unknown method names for future ACP and `_`-prefixed ones for
      // implementations. Emitting an unprefixed custom method would squat on ACP's namespace,
      // and a name it later defines would collide with ours. Logged rather than thrown: an
      // extension is not worth failing a turn over.
      this.#logger.warn?.(`refusing to send unprefixed extension notification ${method}`);
      return;
    }
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

/** The `_meta.permission` block the wrapped agent attaches to a permission request. */
function permissionMeta(params: V1RequestPermissionRequest): Record<string, unknown> | undefined {
  const block = (params._meta as { permission?: unknown } | null | undefined)?.permission;
  return typeof block === "object" && block !== null ? (block as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The title v2 requires on a permission request.
 *
 * The wrapped agent has already solved this problem for its own clients: it builds
 * `_meta.permission = { version: 1, title, description?, defaultToNo? }`, where `title` is the
 * heading it wants shown — including special cases like "Ready to code?" for `ExitPlanMode`.
 * Promoting that is strictly better than re-deriving a title from the tool call, and it is why
 * the ladder starts there rather than at `toolCall.title`.
 *
 * Never returns an empty string: v2 makes `title` required, and a client that takes it only
 * when it is a non-empty string would otherwise render an unlabelled dialog asking a user to
 * approve something anonymous.
 */
export function permissionTitle(params: V1RequestPermissionRequest): string {
  const meta = permissionMeta(params);
  const toolCall = params.toolCall ?? {};

  const fromMeta = nonEmptyString(meta?.["title"]);
  if (fromMeta !== undefined) return fromMeta;

  const fromToolCall = nonEmptyString(toolCall["title"]);
  if (fromToolCall !== undefined) return fromToolCall;

  const name = nonEmptyString(toolCall["name"]);
  if (name !== undefined) return `Use ${name}?`;

  return PERMISSION_FALLBACK_TITLE;
}

/**
 * The optional `description`, taken only from where the wrapped agent actually puts one.
 *
 * Never synthesised. v2 reads an omitted description as "there is no separate description", and
 * inventing one would be this adapter making a claim about *why* the agent wants permission
 * that it has no basis for.
 */
export function permissionDescription(params: V1RequestPermissionRequest): string | undefined {
  return nonEmptyString(permissionMeta(params)?.["description"]);
}

/** True for v2's "request cancelled" error code. */
function isRequestCancelled(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === -32800;
}

/**
 * A client's answer, reduced to something the wrapped agent can act on.
 *
 * Two v2 openings have to be closed here. `RequestPermissionOutcome` is an **open** union in v2
 * and closed in v1, and a client may answer `selected` with an `optionId` that was never
 * offered. Either would reach the wrapped agent's decoder, which throws "Permission option was
 * not offered" out of `canUseTool` and fails the entire tool call with a message the user can do
 * nothing about.
 *
 * Both degrade to `cancelled`, which the wrapped agent handles as a matter of course. The rule
 * that must not be broken in the other direction: an unrecognised answer may never become
 * `selected`. Turning "I do not understand this response" into "the user approved it" is the
 * one mistake here with a real cost.
 */
export function normalisePermissionOutcome(
  response: unknown,
  offered: ReadonlySet<string>,
  logger: Logger,
): unknown {
  const outcome = (response as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)
    ?.outcome;
  if (outcome == null) return { outcome: { outcome: "cancelled" } };

  if (outcome.outcome === "cancelled") return response;

  if (outcome.outcome !== "selected") {
    logger.warn?.(`unrecognised permission outcome ${String(outcome.outcome)}; treating as cancelled`);
    return { outcome: { outcome: "cancelled" } };
  }

  if (typeof outcome.optionId !== "string" || !offered.has(outcome.optionId)) {
    logger.error(
      `client selected permission option ${String(outcome.optionId)}, which was not offered; ` +
        `treating as cancelled`,
    );
    return { outcome: { outcome: "cancelled" } };
  }

  return response;
}
