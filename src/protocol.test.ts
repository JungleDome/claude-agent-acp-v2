/**
 * The surface gate.
 *
 * `protocol.ts` restates the stable v2 baseline as TypeScript literals. Restating anything is
 * how it drifts, so these tests measure the restatement against the vendored `meta.json` —
 * which is the alpha.3 tag byte-for-byte — rather than against a reviewer's memory.
 *
 * The negative arm matters as much as the positive one: `expect(extras).toEqual([])` is
 * satisfied by a comparison that cannot see anything at all, so each emptiness assertion here
 * is paired with a positive control that drives the same comparison over an input it must
 * report.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";

import {
  ADAPTER_PROTOCOL_VERSION,
  CANCEL_REQUEST_METHOD,
  EXCLUDED_DRAFT_METHODS,
  STABLE_AGENT_METHODS,
  STABLE_CLIENT_METHODS,
} from "./protocol.js";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "v2");

interface SchemaMeta {
  readonly version: number;
  readonly agentMethods: Record<string, string>;
  readonly clientMethods: Record<string, string>;
  readonly protocolMethods: Record<string, string>;
}

const meta = JSON.parse(readFileSync(join(schemaDir, "meta.json"), "utf8")) as SchemaMeta;

/** Set difference, as data, so both arms of every emptiness assertion drive the same code. */
function missingFrom(expected: readonly string[], actual: readonly string[]): string[] {
  return expected.filter((name) => !actual.includes(name)).sort();
}

describe("the vendored schema is the pinned alpha", () => {
  it("matches its own checksum manifest", () => {
    const manifest = readFileSync(join(schemaDir, "SHA256SUMS"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [digest, name] = line.trim().split(/\s+/);
        return { digest, name: name ?? "" };
      });

    expect(manifest).toHaveLength(3);
    for (const { digest, name } of manifest) {
      const actual = createHash("sha256").update(readFileSync(join(schemaDir, name))).digest("hex");
      expect(actual, `${name} does not match SHA256SUMS`).toBe(digest);
    }
  });

  it("is schema version 2", () => {
    expect(meta.version).toBe(2);
  });

  it("agrees with the SDK the adapter actually imports", () => {
    // The pin that matters is not the one in package.json but the one that got installed.
    expect(PROTOCOL_VERSION).toBe(2);
    expect(ADAPTER_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});

describe("the served surface equals the stable baseline", () => {
  it("serves exactly the eleven agent methods meta.json names", () => {
    const expected = Object.values(meta.agentMethods).sort();
    expect([...STABLE_AGENT_METHODS].sort()).toEqual(expected);
    expect(expected).toHaveLength(11);
  });

  it("implements exactly the four client methods meta.json names", () => {
    const expected = Object.values(meta.clientMethods).sort();
    expect([...STABLE_CLIENT_METHODS].sort()).toEqual(expected);
    expect(expected).toHaveLength(4);
  });

  it("names the one protocol method", () => {
    expect(Object.values(meta.protocolMethods)).toEqual([CANCEL_REQUEST_METHOD]);
  });

  it("reports a baseline method that is missing — positive control", () => {
    // Without this arm, the three assertions above would still pass if `missingFrom` were
    // mutated to return []. This drives the same comparison over an input it must report.
    const truncated = STABLE_AGENT_METHODS.filter((m) => m !== "session/prompt");
    expect(missingFrom(Object.values(meta.agentMethods), truncated)).toEqual(["session/prompt"]);
  });
});

describe("the draft superset stays out", () => {
  it("shares no method with the stable baseline", () => {
    const stable = new Set<string>([...STABLE_AGENT_METHODS, ...STABLE_CLIENT_METHODS]);
    const overlap = EXCLUDED_DRAFT_METHODS.filter((name) => stable.has(name));
    expect(overlap).toEqual([]);
  });

  it("names methods that really are absent from meta.json", () => {
    // The point of the exclusion list is that these exist in the SDK's `methods` tree but not
    // in the stable baseline. If one of them were quietly promoted into meta.json by an alpha
    // bump, this fails and the list gets reviewed rather than silently over-excluding.
    const baseline = new Set<string>([
      ...Object.values(meta.agentMethods),
      ...Object.values(meta.clientMethods),
      ...Object.values(meta.protocolMethods),
    ]);
    const wronglyExcluded = EXCLUDED_DRAFT_METHODS.filter((name) => baseline.has(name));
    expect(wronglyExcluded).toEqual([]);
  });

  it("detects a draft method that leaked into the baseline — positive control", () => {
    const baseline = new Set<string>([...Object.values(meta.agentMethods), "session/fork"]);
    const leaked = EXCLUDED_DRAFT_METHODS.filter((name) => baseline.has(name));
    expect(leaked).toEqual(["session/fork"]);
  });
});
