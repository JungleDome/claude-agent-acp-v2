/**
 * The turn state machine.
 *
 * These tests are written against the property that actually matters to a v2 client: the
 * sequence of `state_update` notifications it observes. Asserting on internal counters would
 * pass just as happily with a machine that never emitted anything, so every test here reads
 * the recorded wire sequence.
 */

import { describe, expect, it, vi } from "vitest";
import type { StateUpdate } from "@agentclientprotocol/sdk/experimental/v2";

import { ERROR_STOP_REASON, TurnTracker, type StateSink } from "./turn.js";

/** Records what reached the wire, in order, with the option to make emission slow. */
class RecordingSink implements StateSink {
  readonly seen: Array<{ sessionId: string; update: StateUpdate }> = [];
  delayMs = 0;

  async emitState(sessionId: string, update: StateUpdate): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.seen.push({ sessionId, update });
  }

  states(): string[] {
    return this.seen.map((entry) => String(entry.update.state));
  }

  stopReasons(): unknown[] {
    return this.seen
      .filter((entry) => entry.update.state === "idle")
      .map((entry) => (entry.update as { stopReason?: unknown }).stopReason);
  }
}

/** A promise with an external resolver, so a test can hold a turn open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("a single turn", () => {
  it("goes running then idle, carrying the stop reason", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    await tracker.run("s1", async () => ({ stopReason: "end_turn" }));
    await tracker.settled("s1");

    expect(sink.states()).toEqual(["running", "idle"]);
    expect(sink.stopReasons()).toEqual(["end_turn"]);
  });

  it("emits running before the wrapped prompt has finished", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);
    const gate = deferred<{ stopReason: string }>();

    const turn = tracker.run("s1", () => gate.promise);
    // The turn is open. A v2 client must already be able to see that the session is busy,
    // because the `{}` acknowledgement told it nothing.
    await tracker.settled("s1");
    expect(sink.states()).toEqual(["running"]);

    gate.resolve({ stopReason: "end_turn" });
    await turn;
    expect(sink.states()).toEqual(["running", "idle"]);
  });

  it("reads a missing stop reason as end_turn", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    await tracker.run("s1", async () => ({}));

    expect(sink.stopReasons()).toEqual(["end_turn"]);
  });

  it("carries a cancellation through as the reason the turn ended", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    // v1 confirms cancellation by resolving the prompt; v2 confirms it with this idle update.
    await tracker.run("s1", async () => ({ stopReason: "cancelled" }));

    expect(sink.states()).toEqual(["running", "idle"]);
    expect(sink.stopReasons()).toEqual(["cancelled"]);
  });

  it("preserves an unknown stop reason verbatim", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    // StopReason is an open enum in v2. Normalising this to a known value would destroy
    // information the client is required to be able to see.
    await tracker.run("s1", async () => ({ stopReason: "_vendor_specific" }));

    expect(sink.stopReasons()).toEqual(["_vendor_specific"]);
  });
});

describe("a failing turn", () => {
  it("ends the turn instead of rejecting", async () => {
    const sink = new RecordingSink();
    const onError = vi.fn();
    const tracker = new TurnTracker(sink, onError);

    // The `{}` acknowledgement has already been sent by the time this rejects, so there is no
    // JSON-RPC error left to fail. Rethrowing here would leave the session running forever.
    await expect(
      tracker.run("s1", async () => {
        throw new Error("claude exploded");
      }),
    ).resolves.toBeUndefined();

    expect(sink.states()).toEqual(["running", "idle"]);
    expect(sink.stopReasons()).toEqual([ERROR_STOP_REASON]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("puts the failure detail in _meta, where an open enum cannot carry it", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    await tracker.run("s1", async () => {
      throw new Error("rate limited");
    });

    const idle = sink.seen.at(-1)?.update as { _meta?: { error?: string } };
    expect(idle._meta?.error).toBe("rate limited");
  });

  it("survives a non-Error throw", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    await tracker.run("s1", async () => {
      throw { code: 42 };
    });

    const idle = sink.seen.at(-1)?.update as { _meta?: { error?: string } };
    expect(idle._meta?.error).toBe('{"code":42}');
    expect(sink.stopReasons()).toEqual([ERROR_STOP_REASON]);
  });
});

describe("queued prompts", () => {
  it("does not end the turn while another prompt is still in flight", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);
    const first = deferred<{ stopReason: string }>();
    const second = deferred<{ stopReason: string }>();

    const a = tracker.run("s1", () => first.promise);
    const b = tracker.run("s1", () => second.promise);

    first.resolve({ stopReason: "end_turn" });
    await a;
    // The agent is still working on the queued prompt. An idle here would tell the client the
    // turn was over while output was still coming.
    expect(sink.states()).toEqual(["running"]);

    second.resolve({ stopReason: "end_turn" });
    await b;
    expect(sink.states()).toEqual(["running", "idle"]);
  });

  it("reports the stop reason of the prompt that emptied the queue", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);
    const first = deferred<{ stopReason: string }>();
    const second = deferred<{ stopReason: string }>();

    const a = tracker.run("s1", () => first.promise);
    const b = tracker.run("s1", () => second.promise);
    first.resolve({ stopReason: "end_turn" });
    await a;
    second.resolve({ stopReason: "cancelled" });
    await b;

    expect(sink.stopReasons()).toEqual(["cancelled"]);
  });

  it("reports running while any prompt is unsettled", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);
    const gate = deferred<{ stopReason: string }>();

    const turn = tracker.run("s1", () => gate.promise);
    expect(tracker.isRunning("s1")).toBe(true);

    gate.resolve({ stopReason: "end_turn" });
    await turn;
    expect(tracker.isRunning("s1")).toBe(false);
  });
});

describe("requires_action", () => {
  it("brackets a client-bound ask and returns to running", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);
    const gate = deferred<{ stopReason: string }>();

    const turn = tracker.run("s1", async () => {
      await tracker.whileAwaitingClient("s1", async () => "allowed");
      return gate.promise;
    });
    gate.resolve({ stopReason: "end_turn" });
    await turn;
    await tracker.settled("s1");

    expect(sink.states()).toEqual(["running", "requires_action", "running", "idle"]);
  });

  it("stays in requires_action until the last nested ask answers", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);
    const outer = deferred<string>();
    const inner = deferred<string>();

    const turn = tracker.run("s1", async () => {
      const both = Promise.all([
        tracker.whileAwaitingClient("s1", () => outer.promise),
        tracker.whileAwaitingClient("s1", () => inner.promise),
      ]);
      outer.resolve("a");
      await new Promise((r) => setTimeout(r, 0));
      inner.resolve("b");
      await both;
      return { stopReason: "end_turn" };
    });
    await turn;
    await tracker.settled("s1");

    // One entry and one exit, not two of each: the second ask overlapped the first.
    expect(sink.states()).toEqual(["running", "requires_action", "running", "idle"]);
  });

  it("returns the ask's value to its caller", async () => {
    const tracker = new TurnTracker(new RecordingSink());
    await expect(tracker.whileAwaitingClient("s1", async () => "outcome")).resolves.toBe("outcome");
  });

  it("leaves requires_action even when the ask throws", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    await tracker.run("s1", async () => {
      await tracker
        .whileAwaitingClient("s1", async () => {
          throw new Error("client refused");
        })
        .catch(() => undefined);
      return { stopReason: "end_turn" };
    });
    await tracker.settled("s1");

    expect(sink.states()).toEqual(["running", "requires_action", "running", "idle"]);
  });

  it("does not start the next turn in requires_action", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    // An ask left dangling by a turn that failed must not colour the next one.
    await tracker.run("s1", async () => {
      void tracker.whileAwaitingClient("s1", () => new Promise(() => {}));
      throw new Error("died mid-ask");
    });
    sink.seen.length = 0;
    await tracker.run("s1", async () => ({ stopReason: "end_turn" }));
    await tracker.settled("s1");

    expect(sink.states()).toEqual(["running", "idle"]);
  });
});

describe("emission ordering", () => {
  it("serialises transitions even when the sink is slow", async () => {
    const sink = new RecordingSink();
    sink.delayMs = 5;
    const tracker = new TurnTracker(sink);

    await tracker.run("s1", async () => ({ stopReason: "end_turn" }));
    await tracker.settled("s1");

    // Without a per-session chain the idle could overtake the running and tell the client the
    // turn ended before it began.
    expect(sink.states()).toEqual(["running", "idle"]);
  });

  it("keeps sessions independent", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    await Promise.all([
      tracker.run("s1", async () => ({ stopReason: "end_turn" })),
      tracker.run("s2", async () => ({ stopReason: "refusal" })),
    ]);
    await tracker.settled("s1");
    await tracker.settled("s2");

    const forS1 = sink.seen.filter((e) => e.sessionId === "s1").map((e) => e.update.state);
    const forS2 = sink.seen.filter((e) => e.sessionId === "s2").map((e) => e.update.state);
    expect(forS1).toEqual(["running", "idle"]);
    expect(forS2).toEqual(["running", "idle"]);
  });

  it("does not repeat a state that is already on the wire", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);
    const gate = deferred<{ stopReason: string }>();

    const a = tracker.run("s1", () => gate.promise);
    const b = tracker.run("s1", () => gate.promise);
    gate.resolve({ stopReason: "end_turn" });
    await Promise.all([a, b]);
    await tracker.settled("s1");

    // Two prompts, one turn: exactly one running and one idle.
    expect(sink.states()).toEqual(["running", "idle"]);
  });

  it("forgets a session's bookkeeping on request", async () => {
    const sink = new RecordingSink();
    const tracker = new TurnTracker(sink);

    await tracker.run("s1", async () => ({ stopReason: "end_turn" }));
    tracker.forget("s1");
    expect(tracker.isRunning("s1")).toBe(false);

    sink.seen.length = 0;
    await tracker.run("s1", async () => ({ stopReason: "end_turn" }));
    await tracker.settled("s1");
    expect(sink.states()).toEqual(["running", "idle"]);
  });
});
