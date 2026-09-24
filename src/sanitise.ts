/**
 * Cardinality constraints v2 added, applied to payloads v1 never checked.
 *
 * The stable v2 schema carries four `minItems: 1` constraints that v1 does not have:
 *
 * | definition | field |
 * |---|---|
 * | `RequestPermissionRequest` | `options` |
 * | `StringPropertySchema` | `enum`, `oneOf` |
 * | `StringMultiSelectItems` | `enum` |
 * | `TitledMultiSelectItems` | `anyOf` |
 *
 * Every one of them is reachable from content this adapter does not author. An elicitation's
 * `requestedSchema` originates in an **MCP server** and reaches the wire through an unvalidated
 * passthrough, so `enum: []` is legal v1 and illegal v2 — and the frame is rejected at the
 * moment a user was about to be asked a question.
 *
 * The rule applied throughout: **degrade the question, never refuse it.** An empty `enum` on a
 * string becomes free text rather than a dropped prompt; a permission request with no options
 * gains a *reject*, never an allow. Losing a dropdown is a worse question; losing the frame is
 * no question at all, and a tool call wedged behind it.
 */

/** A permission option that is always safe to add: it can only decline. */
const SYNTHETIC_REJECT = Object.freeze({
  optionId: "reject",
  name: "Reject",
  kind: "reject_once",
});

/**
 * Guarantee the one option v2 requires on a permission request.
 *
 * Unreachable with the wrapped agent as it stands — its smallest builder returns an allow and a
 * reject — so this is a guard rather than a fix. If it ever fires, the appended option must be
 * the rejecting one: a synthesised *allow* would let this adapter manufacture consent a user
 * never gave.
 */
export function ensurePermissionOptions(options: readonly unknown[]): readonly unknown[] {
  return options.length > 0 ? options : [SYNTHETIC_REJECT];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/**
 * One elicitation property, with any empty choice list removed.
 *
 * Dropping an empty `enum` turns a select into free text. That is a real loss of structure and
 * it is still the better outcome: the alternative is a schema-invalid frame, which asks the
 * user nothing at all and leaves the MCP tool call waiting.
 *
 * A multi-select is the awkward case, because `items` is required — degrading it to a plain
 * string is what keeps the property answerable.
 */
function sanitiseProperty(
  property: unknown,
  onRewrite: (what: string) => void,
): unknown {
  if (!isRecord(property)) return property;

  const out: Record<string, unknown> = { ...property };

  for (const key of ["enum", "oneOf"]) {
    if (isEmptyArray(out[key])) {
      delete out[key];
      onRewrite(`dropped empty ${key}`);
    }
  }

  const items = out["items"];
  if (isRecord(items)) {
    const sanitisedItems: Record<string, unknown> = { ...items };
    let emptied = false;
    for (const key of ["enum", "anyOf"]) {
      if (isEmptyArray(sanitisedItems[key])) {
        delete sanitisedItems[key];
        emptied = true;
      }
    }
    if (emptied) {
      // `items` is required on a multi-select, so it cannot simply be dropped. Degrading the
      // whole property to a string keeps the question answerable.
      delete out["items"];
      out["type"] = "string";
      onRewrite("degraded an empty multi-select to free text");
    } else {
      out["items"] = sanitisedItems;
    }
  }

  return out;
}

/**
 * An `elicitation/create` request, with cardinality violations removed.
 *
 * Returns the input unchanged when nothing needed rewriting, so the common path allocates
 * nothing and a caller can tell "sanitised" from "untouched" by identity.
 */
export function sanitiseElicitationRequest(
  params: Record<string, unknown>,
  onRewrite: (what: string) => void = () => {},
): Record<string, unknown> {
  const schema = params["requestedSchema"];
  if (!isRecord(schema)) return params;

  const properties = schema["properties"];
  if (!isRecord(properties)) return params;

  let changed = false;
  const sanitisedProperties: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    const sanitised = sanitiseProperty(property, (what) => {
      changed = true;
      onRewrite(`${what} on elicitation property "${name}"`);
    });
    sanitisedProperties[name] = sanitised;
  }

  if (!changed) return params;
  return {
    ...params,
    requestedSchema: { ...schema, properties: sanitisedProperties },
  };
}
