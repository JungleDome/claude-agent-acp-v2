/**
 * Session config options, v1 <-> v2.
 *
 * Two field renames, and they are easy to miss because everything around them is identical:
 *
 * | v1 | v2 | where |
 * |---|---|---|
 * | `SessionConfigOption.id` | `configId` | every config option, everywhere |
 * | `SessionConfigSelectGroup.group` | `groupId` | inside a grouped `select` option |
 *
 * Both are **required** fields in v2, so getting this wrong does not degrade gracefully — the
 * option fails schema validation outright. Neither rename is visible to `tsc`, because the SDK
 * types this adapter compiles against are generated from the draft superset rather than from
 * the stable baseline.
 *
 * These objects appear in four places, which is why the rewriter lives in its own module rather
 * than inside the update mapper: the `session/new` response, the `session/resume` response, the
 * `session/set_config_option` response, and the `config_option_update` notification. A rewrite
 * applied in three of the four is a bug that only shows up on the fourth.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2";

/** A v1 config option, read structurally — only the renamed keys are known. */
export interface V1ConfigOption {
  readonly id?: unknown;
  readonly [key: string]: unknown;
}

/**
 * One v1 config option in v2 spelling.
 *
 * Unknown keys are carried through untouched: both versions allow implementation-specific
 * members, and v2's option union ends in an open branch for exactly that reason.
 */
export function toV2ConfigOption(option: V1ConfigOption): SessionConfigOption {
  const { id, options, ...rest } = option as {
    id?: unknown;
    options?: unknown;
    [key: string]: unknown;
  };

  const v2: Record<string, unknown> = { ...rest };
  if (id !== undefined) v2["configId"] = id;
  if (options !== undefined) v2["options"] = rewriteSelectOptions(options);

  return v2 as unknown as SessionConfigOption;
}

/** The same, for a list. Returns a new array; the input is never mutated. */
export function toV2ConfigOptions(
  options: readonly V1ConfigOption[] | null | undefined,
): SessionConfigOption[] {
  if (options == null) return [];
  return options.map(toV2ConfigOption);
}

/**
 * A `select` option's choices, which may be flat or grouped.
 *
 * v1's `SessionConfigSelectOptions` is either `SessionConfigSelectOption[]` (flat, with
 * `value`/`name` — identical in both versions) or `SessionConfigSelectGroup[]` (each with the
 * `group` key v2 renamed). The two are told apart structurally rather than by a discriminator,
 * because neither version carries one: a group is the branch that has nested `options`.
 */
function rewriteSelectOptions(options: unknown): unknown {
  if (!Array.isArray(options)) return options;

  return options.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const record = entry as Record<string, unknown>;

    // A flat choice has no nested `options`; only a group does. Renaming `group` on a flat
    // choice would invent a key, and missing it on a group drops a required one.
    if (!Array.isArray(record["options"])) return entry;

    const { group, ...rest } = record;
    const v2Group: Record<string, unknown> = { ...rest };
    if (group !== undefined) v2Group["groupId"] = group;
    return v2Group;
  });
}

/**
 * A v2 `session/set_config_option` request, as the wrapped v1 agent expects it.
 *
 * The rename above does **not** apply here, and assuming it did is the trap: v1 spells the key
 * `id` on a `SessionConfigOption` but `configId` on a `SetSessionConfigOptionRequest`. Only the
 * option *definition* was renamed in v2; the request carried `configId` in both versions.
 *
 * What does differ is the value. v2 tags it — `{ type: "id" | "boolean", value }` — while v1
 * discriminates structurally: `{ type: "boolean", value: boolean }` or a bare
 * `{ value: SessionConfigValueId }` with no `type` at all. Forwarding v2's `type: "id"` would
 * hand v1 a discriminator it does not know.
 */
export function toV1ConfigOptionRequest(params: {
  readonly sessionId: string;
  readonly configId: string;
  readonly type?: string;
  readonly value: unknown;
  readonly _meta?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const v1: Record<string, unknown> = {
    sessionId: params.sessionId,
    configId: params.configId,
    value: params.value,
  };
  // v1 has exactly one tagged form. Everything else is the untagged select form, including a
  // `type` from a future v2 variant this adapter does not recognise — dropping the tag is
  // right there too, because v1 would reject a discriminator it has no branch for.
  if (params.type === "boolean") v1["type"] = "boolean";
  if (params._meta != null) v1["_meta"] = params._meta;
  return v1;
}
