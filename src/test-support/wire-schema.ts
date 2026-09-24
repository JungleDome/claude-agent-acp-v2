/**
 * Conformance validation against the **stable** v2 schema.
 *
 * This module exists because of a trap that is easy to fall into and expensive to leave in:
 * `@agentclientprotocol/sdk/experimental/v2` generates its TypeScript types from
 * `schema/v2/schema.unstable.json` — the **draft superset** — and that is the only v2 schema
 * the npm package ships. So `tsc` will happily accept a `compaction_update`, a `plan_removed`
 * or a `ToolCallUpdate.name`, none of which exist in the stable baseline this adapter claims to
 * speak. The type checker cannot see the difference; only the schema can.
 *
 * Measured, not asserted: the stable `schema.json` defines **16** named `SessionUpdate`
 * variants plus one open branch, where the SDK's generated union has 19 named ones.
 *
 * Validation is **method-directed**, following the schema's own annotations rather than a
 * transcribed mapping: 28 definitions carry `x-method` (the JSON-RPC method) and `x-side` (the
 * peer that handles it). Validating against the root alone would be close to vacuous — the
 * extension branches are empty schemas that anything satisfies — so the definition to check is
 * looked up from those annotations.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { AnySchema, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { Ajv2020 } from "ajv/dist/2020.js";

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schema",
  "v2",
  "schema.json",
);

const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema & {
  $defs: Record<string, Record<string, unknown>>;
};

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(schema, "acp");

/**
 * The definition name handling `method` on `side`, read off the schema's own annotations.
 *
 * Throws rather than returning undefined: a caller asking about a method the stable schema does
 * not annotate has almost certainly mistyped it, and silently validating nothing is the failure
 * mode this whole module exists to prevent.
 */
export function definitionFor(method: string, side: "agent" | "client"): string {
  const match = Object.entries(schema.$defs).find(
    ([name, def]) =>
      def["x-method"] === method &&
      def["x-side"] === side &&
      !name.endsWith("Response"),
  );
  if (match === undefined) {
    throw new Error(
      `no stable-v2 definition carries x-method=${method} x-side=${side}. ` +
        `If this method is part of the draft superset, it is out of scope by design.`,
    );
  }
  return match[0];
}

function compiled(definition: string): ValidateFunction {
  const validator = ajv.getSchema(`acp#/$defs/${definition}`);
  if (validator === undefined) {
    throw new Error(`stable schema has no $defs/${definition}`);
  }
  return validator;
}

/** A validation failure, rendered for a test assertion message. */
export interface SchemaViolation {
  readonly definition: string;
  readonly errors: string[];
}

/**
 * Validate one message against the stable definition its method names.
 *
 * Returns `null` when the message conforms, so a caller can assert on the value rather than on
 * an exception — an emptiness assertion over violations is easier to pair with a positive
 * control than a `expect(() => ...).not.toThrow()`.
 */
export function validateAgainst(
  definition: string,
  message: unknown,
): SchemaViolation | null {
  const validate = compiled(definition);
  if (validate(message)) return null;
  return {
    definition,
    errors: (validate.errors ?? []).map(renderError),
  };
}

/** A `session/update` notification's **params**, as the agent sends them. */
export function validateSessionUpdate(params: unknown): SchemaViolation | null {
  return validateAgainst(definitionFor("session/update", "client"), params);
}

/**
 * The 16 named `SessionUpdate` variants of the stable baseline, read from the schema.
 *
 * Derived, never restated: a hard-coded list is exactly the artefact that rots into the defect
 * it was written to catch.
 */
export function stableUpdateVariants(): string[] {
  const union = schema.$defs["SessionUpdate"] as { anyOf?: Array<Record<string, unknown>> };
  return (union.anyOf ?? [])
    .map((branch) => {
      const properties = branch["properties"] as
        | { sessionUpdate?: { const?: unknown } }
        | undefined;
      return properties?.sessionUpdate?.const;
    })
    .filter((name): name is string => typeof name === "string");
}

function renderError(error: ErrorObject): string {
  return `${error.instancePath || "/"} ${error.message ?? "is invalid"}`;
}
