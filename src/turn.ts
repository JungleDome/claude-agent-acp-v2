/**
 * The prompt-turn inversion.
 *
 * This is the single largest behavioural change between v1 and v2, and the reason this adapter
 * needs a state machine at all rather than a pile of field renames.
 *
 * In v1, `session/prompt` stays pending for the entire turn and its **response** carries the
 * `stopReason`. In v2 the response is `{}` — a bare acknowledgement that the prompt was
 * accepted — and the turn ends when the agent emits a `state_update` with `state: "idle"`
 * carrying the `stopReason`. Turn completion moves from the request/response channel to the
 * notification channel.
 *
 * Three consequences drive the design here:
 *
 * 1. **A prompt failure can no longer be a JSON-RPC error.** By the time the wrapped v1
 *    `prompt()` rejects we have already answered `{}`. The failure must come back as an idle
 *    state update instead, which is why {@link TurnTracker.run} never rethrows.
 * 2. **Turn identity is ours to derive.** v2 has no turn id, so "the turn" is exactly the
 *    interval between the first `running` and the matching `idle`. With prompt queueing — which
 *    the wrapped agent advertises — several prompts can be in flight at once, and emitting
 *    `idle` when the *first* settles would end the turn while the agent is still working. The
 *    tracker therefore counts.
 * 3. **State emissions must be serialised.** `emitState` is async; two transitions racing
 *    produce a wire order that contradicts the state machine that generated it. Every session
 *    gets a promise chain.
 */

import type { StateUpdate, StopReason } from "@agentclientprotocol/sdk/experimental/v2";

/** The three states the stable v2 baseline defines. `state` itself is an open enum. */
export type TurnState = "running" | "idle" | "requires_action";

/**
 * The stop reason used when the wrapped agent fails a turn.
 *
 * v2's `StopReason` is an **open** enum with a documented extension convention: a value
 * prefixed with `_` is an implementation extension, while a bare unknown value is reserved for
 * future ACP. A failed turn is not one of the five defined reasons and inventing a bare name
 * for it would squat on ACP's namespace, so the extension spelling is the correct one. Clients
 * that do not recognise it are required to preserve it and fall back, which is exactly the
 * behaviour we want.
 */
export const ERROR_STOP_REASON = "_error" as const;

/** What the wrapped v1 `prompt()` resolves to. Read structurally; only `stopReason` is used. */
export interface V1PromptResult {
  readonly stopReason?: string | null;
  readonly _meta?: Record<string, unknown> | null;
}

/** The sink the tracker writes state transitions to — the client shim, in production. */
export interface StateSink {
  emitState(sessionId: string, update: StateUpdate): Promise<void>;
}

/** Reports a turn that failed, so the caller can log it. The tracker itself never throws. */
export type TurnErrorReporter = (sessionId: string, error: unknown) => void;

interface SessionTurnState {
  /** Prompts accepted and not yet settled. `running` while positive. */
  inFlight: number;
  /** Outstanding client-bound asks (permission, elicitation) nested inside the turn. */
  awaitingClient: number;
  /** The last state actually written to the wire, so no transition is emitted twice. */
  emitted: TurnState;
  /** Serialises emissions for this session. */
  tail: Promise<void>;
}

/**
 * Per-session turn bookkeeping.
 *
 * One instance serves a whole connection; sessions are independent and never share state.
 */
export class TurnTracker {
  readonly #sessions = new Map<string, SessionTurnState>();
  readonly #sink: StateSink;
  readonly #onError: TurnErrorReporter;

  constructor(sink: StateSink, onError: TurnErrorReporter = () => {}) {
    this.#sink = sink;
    this.#onError = onError;
  }

  #stateFor(sessionId: string): SessionTurnState {
    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = { inFlight: 0, awaitingClient: 0, emitted: "idle", tail: Promise.resolve() };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  /** The state the machine believes it is in, independent of what has reached the wire. */
  #intendedState(state: SessionTurnState): TurnState {
    if (state.inFlight === 0) return "idle";
    return state.awaitingClient > 0 ? "requires_action" : "running";
  }

  /**
   * Bring the wire into line with the machine, at most one notification per real change.
   *
   * `stopReason` is only meaningful on a transition **to** idle; v2 has nowhere to put it
   * otherwise.
   */
  #sync(sessionId: string, stopReason?: StopReason, meta?: Record<string, unknown>): Promise<void> {
    const state = this.#stateFor(sessionId);
    const target = this.#intendedState(state);
    if (target === state.emitted && stopReason === undefined) {
      return state.tail;
    }
    state.emitted = target;

    const update: StateUpdate =
      target === "idle"
        ? { state: "idle", ...(stopReason !== undefined ? { stopReason } : {}) }
        : { state: target };
    if (meta !== undefined) {
      (update as { _meta?: Record<string, unknown> })._meta = meta;
    }

    // Chain rather than await: callers must not be able to interleave two emissions, but they
    // also must not block each other's bookkeeping.
    state.tail = state.tail.then(
      () => this.#sink.emitState(sessionId, update),
      () => this.#sink.emitState(sessionId, update),
    );
    return state.tail;
  }

  /**
   * Accept one prompt and drive it to completion.
   *
   * Resolves as soon as the turn's state has been settled — which is *after* the wrapped
   * prompt finishes, not before. The v2 `{}` acknowledgement is sent by the caller without
   * awaiting this; see `app.ts`.
   *
   * Never rejects. A wrapped prompt that throws still ends its turn, because a turn left
   * `running` forever is worse for a client than one that ends with an extension stop reason:
   * the client has no timeout of its own and nothing else will ever move that session.
   */
  async run(sessionId: string, invoke: () => Promise<V1PromptResult>): Promise<void> {
    const state = this.#stateFor(sessionId);
    state.inFlight += 1;
    void this.#sync(sessionId);

    let stopReason: StopReason = ERROR_STOP_REASON;
    let meta: Record<string, unknown> | undefined;
    try {
      const result = await invoke();
      // v1 may resolve without a stop reason. `end_turn` is the honest reading: the wrapped
      // agent finished and declined to say why, which is what end_turn means.
      stopReason = result?.stopReason ?? "end_turn";
    } catch (error) {
      this.#onError(sessionId, error);
      meta = { error: describeError(error) };
    } finally {
      state.inFlight -= 1;
      if (state.inFlight === 0) {
        // Any client-bound asks still outstanding belong to a turn that is over; drop them so
        // the next turn does not start life in `requires_action`.
        state.awaitingClient = 0;
      }
    }

    // Only the prompt that empties the queue reports a stop reason: with queueing, the earlier
    // ones did not end the turn.
    if (state.inFlight === 0) {
      await this.#sync(sessionId, stopReason, meta);
    } else {
      await this.#sync(sessionId);
    }
  }

  /**
   * Mark the session as blocked on the client, for the duration of one ask.
   *
   * v2 gained `requires_action` precisely so a client can tell "the agent is thinking" from
   * "the agent is waiting for *you*". The wrapped v1 agent expresses the same thing by leaving
   * a `session/request_permission` or `elicitation/create` outstanding, so the shim wraps those
   * calls in this.
   */
  async whileAwaitingClient<T>(sessionId: string, ask: () => Promise<T>): Promise<T> {
    const state = this.#stateFor(sessionId);
    state.awaitingClient += 1;
    void this.#sync(sessionId);
    try {
      return await ask();
    } finally {
      state.awaitingClient -= 1;
      void this.#sync(sessionId);
    }
  }

  /** True while the session has an unsettled prompt. Used by `session/cancel`. */
  isRunning(sessionId: string): boolean {
    const state = this.#sessions.get(sessionId);
    return state !== undefined && state.inFlight > 0;
  }

  /** Drop a closed or deleted session's bookkeeping. */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** Flush pending emissions — used by tests and by shutdown, never on the hot path. */
  async settled(sessionId: string): Promise<void> {
    await this.#stateFor(sessionId).tail;
  }
}

/** A loggable, non-throwing rendering of whatever the wrapped agent threw. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
