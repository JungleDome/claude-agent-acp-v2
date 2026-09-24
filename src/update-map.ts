/**
 * `session/update` payloads, v1 -> v2.
 *
 * The headline result of deriving this mapping is that it is much smaller than the v1->v2
 * change list suggests. Of the sixteen `sessionUpdate` variants the wrapped agent can emit,
 * **twelve share a v2 name and a byte-identical payload type**, and the four v2 types that do
 * differ (`ToolCallStatus`, `ToolKind`, `ContentBlock`, `PlanUpdateContent`) differ only by v2
 * adding an open fallback member. v2 is a strict *widening* of those shapes, so every v1 value
 * is already a valid v2 value and translating them would be busywork that can only introduce
 * bugs.
 *
 * That leaves exactly four variants that need real work, and each needs it for a different
 * reason:
 *
 * | v1 | v2 | why |
 * |---|---|---|
 * | `*_message_chunk`, `agent_thought_chunk` | same name | `messageId` is **optional** in v1 and **required** in v2 |
 * | `tool_call` | `tool_call_update` | v2 folded creation into update; first unseen id creates |
 * | `plan` | `plan_update` | v2 keys plans by a required `planId` that v1's flat plan lacks |
 * | `current_mode_update` | `config_option_update` | v2 removed modes; they are config options with `category: "mode"` |
 *
 * Everything else is forwarded untouched, including variants this adapter does not recognise:
 * v2's `SessionUpdate` union ends in an open member (`{ sessionUpdate: string; ... }`) and
 * requires unknown variants to be preserved, so dropping one would violate the spec and lose
 * user-visible content.
 */

import type { PlanId, SessionUpdate as V2SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

import { toV2ConfigOptions, type V1ConfigOption } from "./config-options.js";

/** A v1 update, read structurally: only the tag is known, the rest is variant-specific. */
export interface V1Update {
  readonly sessionUpdate: string;
  readonly [key: string]: unknown;
}

/** The three chunk variants whose `messageId` v2 promotes from optional to required. */
const CHUNK_VARIANTS = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"]);

/**
 * Per-session translation state.
 *
 * Stateful because three of the four real mappings need memory: message grouping needs to know
 * which message is open, the plan needs a stable id across updates, and a mode change needs the
 * config option it is a change *to*.
 */
export class SessionUpdateMapper {
  /** The open message per chunk variant, so consecutive chunks join one message. */
  readonly #openMessages = new Map<string, string>();
  /** Monotonic, so a synthesised id is unique within the session without a clock or a PRNG. */
  #synthesised = 0;
  /**
   * The session's config options in their **v1** spelling, as last seen from `session/new`,
   * `session/resume`, or a `config_option_update`.
   *
   * Stored in v1 shape rather than v2 because every writer into this field is a v1 source; the
   * rename to `configId`/`groupId` happens once, on the way out.
   */
  #configOptions: readonly V1ConfigOption[] = [];
  readonly #sessionId: string;

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  /**
   * Record the session's config options.
   *
   * The wrapped agent returns these from `session/new` and `session/resume`. They are kept
   * because a v1 `current_mode_update` carries only the new mode *id*, while a v2
   * `config_option_update` must carry the whole option — including the choices, which only
   * this record has.
   */
  rememberConfigOptions(options: readonly V1ConfigOption[] | null | undefined): void {
    if (options != null) this.#configOptions = options;
  }

  /**
   * Start a new turn.
   *
   * Closes every open message so the first chunk of the next turn begins a new one rather than
   * appending to the last message of the previous turn. Only affects *synthesised* grouping:
   * when the wrapped agent supplies a real `messageId`, that always wins.
   */
  beginTurn(): void {
    this.#openMessages.clear();
  }

  /** The plan id used for v1's flat, identity-less plan. Stable for the session's lifetime. */
  get #defaultPlanId(): PlanId {
    return `plan-${this.#sessionId}` as PlanId;
  }

  /**
   * Translate one v1 update into zero or more v2 updates.
   *
   * Returns an array because the mapping is not always 1:1 — a mode change with no known
   * config option produces nothing rather than an invalid update.
   */
  map(update: V1Update): V2SessionUpdate[] {
    const variant = update.sessionUpdate;

    if (CHUNK_VARIANTS.has(variant)) {
      return [this.#withMessageId(update)];
    }

    switch (variant) {
      case "tool_call":
        // v2 folded creation into update: the first `tool_call_update` naming an unseen
        // `toolCallId` creates the tool call. v1's `ToolCall` is assignable to v2's
        // `ToolCallUpdate` field for field — the only difference is that `title` relaxes from
        // required to optional — so this is a tag rename and nothing more.
        return [{ ...stripTag(update), sessionUpdate: "tool_call_update" } as V2SessionUpdate];

      case "plan":
        return [this.#flatPlanToUpdate(update)];

      case "current_mode_update":
        return this.#modeChangeToConfigOption(update);

      case "available_commands_update":
        return [this.#retagCommandInputs(update)];

      case "config_option_update": {
        // Keep our record current, so a later `current_mode_update` reads the right choices.
        const options = update["configOptions"];
        if (!Array.isArray(options)) return [update as unknown as V2SessionUpdate];
        this.rememberConfigOptions(options as V1ConfigOption[]);
        const v2: Record<string, unknown> = {
          sessionUpdate: "config_option_update",
          configOptions: toV2ConfigOptions(options as V1ConfigOption[]),
        };
        if (update["_meta"] != null) v2["_meta"] = update["_meta"];
        return [v2 as unknown as V2SessionUpdate];
      }

      default:
        // Identical in both versions, or a variant newer than this adapter. Either way v2
        // requires it to survive: its union has an open member and its extensibility rules
        // make dropping an unrecognised variant non-conformant.
        return [update as unknown as V2SessionUpdate];
    }
  }

  /**
   * Guarantee the `messageId` v2 requires.
   *
   * The wrapped agent computes a stable id for most messages (identical at `message_start`, on
   * the consolidated assistant message, and in the persisted transcript), so the common path is
   * a passthrough. The fallback matters anyway: v1's type makes the field optional, so a single
   * chunk without one would produce an update that fails v2's own schema.
   *
   * Consecutive id-less chunks of the same variant join one message rather than becoming a
   * string of one-chunk messages, which is what a reader of the rendered conversation expects.
   */
  #withMessageId(update: V1Update): V2SessionUpdate {
    const variant = update.sessionUpdate;
    const provided = update["messageId"];

    if (typeof provided === "string" && provided !== "") {
      this.#openMessages.set(variant, provided);
      return update as unknown as V2SessionUpdate;
    }

    let messageId = this.#openMessages.get(variant);
    if (messageId === undefined) {
      this.#synthesised += 1;
      messageId = `${this.#sessionId}:synthetic:${variant}:${this.#synthesised}`;
      this.#openMessages.set(variant, messageId);
    }
    return { ...update, messageId } as unknown as V2SessionUpdate;
  }

  /**
   * Command inputs, given the discriminator v2 requires.
   *
   * v1's `AvailableCommandInput` is a single untagged branch, `{ hint? }`. v2 made it a tagged
   * union whose only defined member is `{ type: "text", hint }` — and made `hint` **required**
   * where v1 had it optional. So a v1 command carrying a hint is invalid v2 until it is tagged,
   * and a v1 command with an `input` object but *no* hint cannot be expressed in v2 at all.
   *
   * The latter drops the `input` member rather than emitting a tagged input with no hint: an
   * absent `input` is valid and means "this command takes none", which is a smaller lie than an
   * invalid frame that costs the client the whole command list.
   *
   * This matters more than its size suggests — `available_commands_update` is the first
   * notification the wrapped agent sends after a session opens.
   */
  #retagCommandInputs(update: V1Update): V2SessionUpdate {
    const commands = update["availableCommands"];
    if (!Array.isArray(commands)) return update as unknown as V2SessionUpdate;

    const retagged = commands.map((command) => {
      if (typeof command !== "object" || command === null) return command;
      const record = command as Record<string, unknown>;
      const input = record["input"];

      // `null` and absent are both valid in v2 and both mean "no input".
      if (input == null || typeof input !== "object") return command;

      const inputRecord = input as Record<string, unknown>;
      if (typeof inputRecord["type"] === "string") return command;

      if (typeof inputRecord["hint"] !== "string") {
        const { input: _dropped, ...rest } = record;
        return rest;
      }
      return { ...record, input: { ...inputRecord, type: "text" } };
    });

    return { ...update, availableCommands: retagged } as unknown as V2SessionUpdate;
  }

  /**
   * v1's flat plan, given the identity v2 requires.
   *
   * v1's `plan` carries `entries` and nothing else: successive plans replace one another
   * implicitly. v2 keys plans by `planId` so several can coexist and be updated independently.
   * A v1 agent only ever has the one plan, so a single stable id per session reproduces v1's
   * replace-in-place behaviour exactly — a fresh id per update would instead accumulate a new
   * plan in the client on every revision.
   */
  #flatPlanToUpdate(update: V1Update): V2SessionUpdate {
    const entries = Array.isArray(update["entries"]) ? update["entries"] : [];
    const v2: Record<string, unknown> = {
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: this.#defaultPlanId, entries },
    };
    if (update["_meta"] != null) v2["_meta"] = update["_meta"];
    return v2 as unknown as V2SessionUpdate;
  }

  /**
   * A v1 mode change, re-expressed as the config option v2 made it.
   *
   * v2 removed `session/set_mode`, `modes` and `current_mode_update` outright; the same state
   * lives in a `SessionConfigOption` with `category: "mode"`. The wrapped agent already
   * publishes exactly such an option from `session/new` — it emits both dialects — so this
   * updates that option's `currentValue` rather than inventing a shape.
   *
   * Produces nothing when no mode option is known. That is deliberate: a `config_option_update`
   * naming an option the client has never seen, with no name, description or choices, is worse
   * than silence, and the client's existing option is left untouched rather than corrupted.
   */
  #modeChangeToConfigOption(update: V1Update): V2SessionUpdate[] {
    const currentModeId = update["currentModeId"];
    if (typeof currentModeId !== "string") return [];

    const modeOption = this.#configOptions.find((option) => option["category"] === "mode");
    if (modeOption === undefined) return [];

    const updated: V1ConfigOption = { ...modeOption, currentValue: currentModeId };
    this.#configOptions = this.#configOptions.map((option) =>
      option["category"] === "mode" ? updated : option,
    );

    const v2: Record<string, unknown> = {
      sessionUpdate: "config_option_update",
      configOptions: toV2ConfigOptions([updated]),
    };
    if (update["_meta"] != null) v2["_meta"] = update["_meta"];
    return [v2 as unknown as V2SessionUpdate];
  }
}

/** The payload without its v1 tag, so a new tag can be put on without leaving the old one. */
function stripTag(update: V1Update): Record<string, unknown> {
  const { sessionUpdate: _tag, ...rest } = update;
  return rest;
}
