/**
 * The update mapper, held against the **stable** v2 schema.
 *
 * Every test that asserts conformance runs the mapper's output through
 * `validateSessionUpdate`, which validates against the vendored stable `schema.json` — not
 * against the SDK's TypeScript types, which are generated from the draft superset and would
 * accept variants the baseline does not define.
 */

import { describe, expect, it } from "vitest";

import { SessionUpdateMapper, type V1Update } from "./update-map.js";
import { stableUpdateVariants, validateSessionUpdate } from "./test-support/wire-schema.js";

const SESSION = "sess-1";

/** Wrap an update as the `session/update` params an agent actually sends. */
function asNotification(update: unknown): unknown {
  return { sessionId: SESSION, update };
}

/** Map one v1 update and assert every result conforms; return them for further assertions. */
function mapConforming(mapper: SessionUpdateMapper, v1: V1Update): unknown[] {
  const results = mapper.map(v1);
  for (const result of results) {
    expect(
      validateSessionUpdate(asNotification(result)),
      `mapping ${v1.sessionUpdate} produced a non-conformant update: ${JSON.stringify(result)}`,
    ).toBeNull();
  }
  return results;
}

describe("the stable baseline is what we validate against", () => {
  it("has sixteen named variants, not the SDK's nineteen", () => {
    const variants = stableUpdateVariants();
    expect(variants).toHaveLength(16);
    // The three the SDK's generated union has and the stable schema does not. If an alpha bump
    // promotes one of these, this fails and the mapper gets revisited rather than silently
    // starting to emit it.
    expect(variants).not.toContain("plan_removed");
    expect(variants).not.toContain("compaction_update");
    expect(variants).not.toContain("compaction_summary_chunk");
  });

  it("rejects a malformed update — positive control", () => {
    // Without this, every `toBeNull()` above would pass just as happily against a validator
    // that could not detect anything at all.
    const violation = validateSessionUpdate(
      asNotification({ sessionUpdate: "agent_message_chunk" }),
    );
    expect(violation).not.toBeNull();
  });
});

describe("message chunks gain the messageId v2 requires", () => {
  it("passes a supplied messageId through", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg-real",
      content: { type: "text", text: "hi" },
    });
    expect((out as { messageId: string }).messageId).toBe("msg-real");
  });

  it("synthesises one when v1 omits it", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
    expect((out as { messageId: string }).messageId).toBeTypeOf("string");
    expect((out as { messageId: string }).messageId).not.toBe("");
  });

  it("joins consecutive id-less chunks into one message", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const first = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    })[0] as { messageId: string };
    const second = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "b" },
    })[0] as { messageId: string };
    // A fresh id per chunk would render as a string of one-word messages.
    expect(second.messageId).toBe(first.messageId);
  });

  it("keeps thoughts and messages in separate messages", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const message = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    })[0] as { messageId: string };
    const thought = mapConforming(mapper, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "b" },
    })[0] as { messageId: string };
    expect(thought.messageId).not.toBe(message.messageId);
  });

  it("starts a new message when a new turn begins", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const before = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    })[0] as { messageId: string };
    mapper.beginTurn();
    const after = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "b" },
    })[0] as { messageId: string };
    expect(after.messageId).not.toBe(before.messageId);
  });

  it("lets a real id reclaim grouping from a synthesised one", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const synth = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    })[0] as { messageId: string };
    const real = mapConforming(mapper, {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg-real",
      content: { type: "text", text: "b" },
    })[0] as { messageId: string };
    expect(real.messageId).toBe("msg-real");
    expect(real.messageId).not.toBe(synth.messageId);
  });
});

describe("tool calls", () => {
  it("renames the v1 create into the v2 upsert", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "Read file",
      kind: "read",
      status: "pending",
    });
    expect(out).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      title: "Read file",
    });
    expect(out).not.toHaveProperty("sessionUpdate", "tool_call");
  });

  it("passes a v1 update through", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
    });
    expect(out).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
  });

  it("preserves an open-enum status v1 never had", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "cancelled",
    });
    expect((out as { status: string }).status).toBe("cancelled");
  });
});

describe("plans", () => {
  it("gives v1's flat plan the identity v2 requires", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "plan",
      entries: [{ content: "step one", priority: "high", status: "pending" }],
    });
    expect(out).toMatchObject({
      sessionUpdate: "plan_update",
      plan: { type: "items", entries: [{ content: "step one" }] },
    });
    expect((out as { plan: { planId: string } }).plan.planId).toBeTypeOf("string");
  });

  it("keeps one plan identity across revisions", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const first = mapConforming(mapper, { sessionUpdate: "plan", entries: [] })[0] as {
      plan: { planId: string };
    };
    const second = mapConforming(mapper, { sessionUpdate: "plan", entries: [] })[0] as {
      plan: { planId: string };
    };
    // A fresh id per revision would accumulate a new plan in the client every time.
    expect(second.plan.planId).toBe(first.plan.planId);
  });
});

describe("modes become config options", () => {
  const MODE_OPTION = {
    id: "mode",
    name: "Mode",
    description: "Session permission mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Manual" },
      { value: "plan", name: "Plan" },
    ],
  };

  it("re-emits the mode option with the new value", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    mapper.rememberConfigOptions([MODE_OPTION] as never);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    });
    expect(out).toMatchObject({ sessionUpdate: "config_option_update" });
    const options = (out as { configOptions: Array<{ currentValue: string }> }).configOptions;
    expect(options[0]?.currentValue).toBe("plan");
  });

  it("emits nothing when no mode option is known", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    // Half an option — no name, no choices — is worse for a client than no update at all.
    expect(mapper.map({ sessionUpdate: "current_mode_update", currentModeId: "plan" })).toEqual([]);
  });

  it("tracks options arriving by update, not only at session start", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    mapConforming(mapper, {
      sessionUpdate: "config_option_update",
      configOptions: [MODE_OPTION],
    });
    const [out] = mapConforming(mapper, {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    });
    const options = (out as { configOptions: Array<{ currentValue: string }> }).configOptions;
    expect(options[0]?.currentValue).toBe("plan");
  });
});

describe("config option renames", () => {
  it("renames id to configId, which v2 requires", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "model", name: "Model", type: "select", currentValue: "opus", options: [] },
      ],
    });
    const option = (out as { configOptions: Array<Record<string, unknown>> }).configOptions[0];
    expect(option).toHaveProperty("configId", "model");
    expect(option).not.toHaveProperty("id");
  });

  it("renames group to groupId inside a grouped select", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "opus",
          options: [
            { group: "anthropic", name: "Anthropic", options: [{ value: "opus", name: "Opus" }] },
          ],
        },
      ],
    });
    const option = (out as { configOptions: Array<Record<string, unknown>> }).configOptions[0];
    const groups = option?.["options"] as Array<Record<string, unknown>>;
    expect(groups[0]).toHaveProperty("groupId", "anthropic");
    expect(groups[0]).not.toHaveProperty("group");
  });

  it("leaves a flat choice alone", () => {
    const mapper = new SessionUpdateMapper(SESSION);
    const [out] = mapConforming(mapper, {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "opus",
          options: [{ value: "opus", name: "Opus" }],
        },
      ],
    });
    const option = (out as { configOptions: Array<Record<string, unknown>> }).configOptions[0];
    // A flat choice has no nested `options`; inventing a `groupId` on it would be a new
    // required-looking key that means nothing.
    expect((option?.["options"] as Array<Record<string, unknown>>)[0]).toEqual({
      value: "opus",
      name: "Opus",
    });
  });
});

describe("variants the stable baseline does not name", () => {
  // These ride v2's open `SessionUpdate` branch, which accepts any `sessionUpdate` string that
  // is not one of the sixteen. Forwarding them is both legal and required: the schema tells
  // receivers to "preserve the raw payload when storing, replaying, proxying, or forwarding".
  // Dropping them would lose user-visible content — a compaction notice, a subagent's progress.
  it.each(["compaction_update", "compaction_summary_chunk", "plan_removed", "notice"])(
    "forwards %s on the open branch rather than dropping it",
    (variant) => {
      const mapper = new SessionUpdateMapper(SESSION);
      const results = mapper.map({ sessionUpdate: variant, compactionId: "c1", status: "x" });
      expect(results).toHaveLength(1);
      expect(
        validateSessionUpdate(asNotification(results[0])),
        `${variant} reached the wire in a shape the stable schema rejects`,
      ).toBeNull();
    },
  );

  it("rejects a known variant carrying a foreign payload", () => {
    // The open branch has a `not` clause forbidding reuse of the sixteen names. This is the
    // guard that stops a passthrough from quietly emitting a malformed known variant.
    const violation = validateSessionUpdate(
      asNotification({ sessionUpdate: "usage_update", somethingElse: true }),
    );
    expect(violation).not.toBeNull();
  });
});
