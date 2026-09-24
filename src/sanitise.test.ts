/**
 * The cardinality guards, checked against the schema that motivates them.
 *
 * Each test that claims a payload is now valid says so by running it through the vendored
 * stable schema, and each is paired with the unsanitised form to prove the constraint is real
 * rather than imagined.
 */

import { describe, expect, it, vi } from "vitest";

import { ensurePermissionOptions, sanitiseElicitationRequest } from "./sanitise.js";
import { validateAgainst } from "./test-support/wire-schema.js";

describe("permission options", () => {
  it("leaves a non-empty list alone", () => {
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
    expect(ensurePermissionOptions(options)).toBe(options);
  });

  it("supplies a rejecting option rather than none", () => {
    const filled = ensurePermissionOptions([]) as Array<Record<string, unknown>>;
    expect(filled).toHaveLength(1);
    // The synthesised option can only decline. Manufacturing an *allow* would be this adapter
    // inventing consent a user never gave.
    expect(filled[0]?.["kind"]).toBe("reject_once");
  });

  it("makes an otherwise-invalid request valid", () => {
    const base = { sessionId: "s1", title: "Do a thing", options: [] as unknown[] };
    expect(validateAgainst("RequestPermissionRequest", base)).not.toBeNull();
    expect(
      validateAgainst("RequestPermissionRequest", {
        ...base,
        options: ensurePermissionOptions([]),
      }),
    ).toBeNull();
  });
});

describe("elicitation schemas", () => {
  it("returns the input unchanged when nothing needs rewriting", () => {
    const params = {
      sessionId: "s1",
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: { colour: { type: "string", enum: ["red", "blue"] } },
      },
    };
    // Identity, not deep equality: the common path should allocate nothing.
    expect(sanitiseElicitationRequest(params)).toBe(params);
  });

  it("drops an empty enum, turning a select into free text", () => {
    const onRewrite = vi.fn();
    const sanitised = sanitiseElicitationRequest(
      {
        message: "Pick one",
        requestedSchema: {
          type: "object",
          properties: { colour: { type: "string", enum: [] } },
        },
      },
      onRewrite,
    );
    const colour = (
      (sanitised["requestedSchema"] as Record<string, unknown>)["properties"] as Record<
        string,
        Record<string, unknown>
      >
    )["colour"];
    expect(colour).not.toHaveProperty("enum");
    expect(colour?.["type"]).toBe("string");
    expect(onRewrite).toHaveBeenCalledOnce();
  });

  it("drops an empty oneOf", () => {
    const sanitised = sanitiseElicitationRequest({
      message: "m",
      requestedSchema: { type: "object", properties: { x: { type: "string", oneOf: [] } } },
    });
    const x = (
      (sanitised["requestedSchema"] as Record<string, unknown>)["properties"] as Record<
        string,
        Record<string, unknown>
      >
    )["x"];
    expect(x).not.toHaveProperty("oneOf");
  });

  it("degrades a multi-select with no choices to free text", () => {
    const onRewrite = vi.fn();
    const sanitised = sanitiseElicitationRequest(
      {
        message: "m",
        requestedSchema: {
          type: "object",
          properties: { tags: { type: "array", items: { enum: [] } } },
        },
      },
      onRewrite,
    );
    const tags = (
      (sanitised["requestedSchema"] as Record<string, unknown>)["properties"] as Record<
        string,
        Record<string, unknown>
      >
    )["tags"];
    // `items` is required on a multi-select, so it cannot be dropped in place — the property
    // becomes a plain string so the question stays answerable.
    expect(tags).not.toHaveProperty("items");
    expect(tags?.["type"]).toBe("string");
    expect(onRewrite).toHaveBeenCalledOnce();
  });

  it("leaves a populated multi-select alone", () => {
    const params = {
      message: "m",
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { enum: ["a"] } } },
      },
    };
    expect(sanitiseElicitationRequest(params)).toBe(params);
  });

  it("does not mutate the caller's object", () => {
    const params = {
      message: "m",
      requestedSchema: { type: "object", properties: { x: { type: "string", enum: [] } } },
    };
    const before = JSON.stringify(params);
    sanitiseElicitationRequest(params);
    expect(JSON.stringify(params)).toBe(before);
  });

  it("tolerates a request with no schema at all", () => {
    const params = { message: "just tell me" };
    expect(sanitiseElicitationRequest(params)).toBe(params);
  });

  it("tolerates a malformed schema rather than throwing", () => {
    for (const requestedSchema of [null, "nonsense", 42, []]) {
      const params = { message: "m", requestedSchema };
      expect(() => sanitiseElicitationRequest(params)).not.toThrow();
    }
  });
});

describe("the constraint is real", () => {
  it("rejects an empty enum on a string property — positive control", () => {
    // If this ever passes, the sanitiser above is dead weight and should be deleted rather
    // than left as decoration.
    expect(validateAgainst("StringPropertySchema", { type: "string", enum: [] })).not.toBeNull();
    expect(validateAgainst("StringPropertySchema", { type: "string", enum: ["a"] })).toBeNull();
  });
});
