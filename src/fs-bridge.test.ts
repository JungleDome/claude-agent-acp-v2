/**
 * The filesystem bridge, and the measurement its policy rests on.
 *
 * The interesting test in this file is the last one. Everything else checks behaviour; that one
 * checks that the *premise* of the behaviour still holds in the resolved upstream package. The
 * policy here — reads degrade to `node:fs`, writes refuse — is justified by the fact that the
 * wrapped agent never calls either method. If an upstream bump reintroduces an internal caller,
 * that justification evaporates, and this suite is what says so.
 */

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createNodeFsBridge, UnnegotiatedWriteError } from "./fs-bridge.js";

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "acp-v2-fs-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("reads degrade to the local filesystem", () => {
  it("returns a whole file", async () => {
    const path = join(workspace, "whole.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    const bridge = createNodeFsBridge();
    await expect(bridge.readTextFile({ path })).resolves.toEqual({
      content: "alpha\nbeta\ngamma",
    });
  });

  it("honours the line and limit window", async () => {
    const path = join(workspace, "window.txt");
    await writeFile(path, "1\n2\n3\n4\n5", "utf8");

    const bridge = createNodeFsBridge();
    // `line` is 1-based. Returning the whole file instead would be read by the caller as the
    // window it asked for.
    await expect(bridge.readTextFile({ path, line: 2, limit: 2 })).resolves.toEqual({
      content: "2\n3",
    });
  });

  it("propagates a missing file rather than inventing empty content", async () => {
    const bridge = createNodeFsBridge();
    await expect(bridge.readTextFile({ path: join(workspace, "absent.txt") })).rejects.toThrow();
  });
});

describe("writes refuse by default", () => {
  it("throws rather than writing without negotiation", async () => {
    const path = join(workspace, "refused.txt");
    const bridge = createNodeFsBridge();

    // A node:fs write is the one path here that could mutate a user's files without a
    // session/request_permission round trip. Refusing is recoverable; a silent write is not.
    await expect(bridge.writeTextFile({ path, content: "nope" })).rejects.toBeInstanceOf(
      UnnegotiatedWriteError,
    );
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("writes when an operator opts in", async () => {
    const path = join(workspace, "allowed", "nested.txt");
    const bridge = createNodeFsBridge({ allowUnnegotiatedDiskWrites: true });

    await expect(bridge.writeTextFile({ path, content: "yes" })).resolves.toEqual({});
    // Parent directories are created, as a v1 client would have done.
    await expect(readFile(path, "utf8")).resolves.toBe("yes");
  });

  it("reports its own write policy, so the capability report cannot drift", () => {
    expect(createNodeFsBridge().writesEnabled).toBe(false);
    expect(createNodeFsBridge({ allowUnnegotiatedDiskWrites: true }).writesEnabled).toBe(true);
  });
});

describe("use is observable", () => {
  it("counts calls and notifies once", async () => {
    const path = join(workspace, "counted.txt");
    await writeFile(path, "x", "utf8");
    const observer = vi.fn();
    const bridge = createNodeFsBridge({ observer });

    expect(bridge.servedCalls).toBe(0);
    await bridge.readTextFile({ path });
    await bridge.readTextFile({ path });

    expect(bridge.servedCalls).toBe(2);
    // Once, not once per file: a changed upstream should be one log line, not a flood.
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith("readTextFile", path);
  });

  it("counts a refused write too", async () => {
    const bridge = createNodeFsBridge();
    await bridge.writeTextFile({ path: join(workspace, "x"), content: "y" }).catch(() => undefined);
    // The attempt is the signal worth having, whether or not it was served.
    expect(bridge.servedCalls).toBe(1);
  });
});

describe("the premise: the wrapped agent never calls these", () => {
  it("finds exactly one call site each, both inside the pass-through methods", async () => {
    // This is a measurement of the *resolved* package, not of a version string. An npm bump
    // that reintroduces an internal caller turns this red before it turns production silent —
    // at which point the read-degrades/write-refuses policy has to be revisited, because its
    // whole justification is that neither path is reachable.
    const require = createRequire(import.meta.url);
    // Resolved through the wildcard subpath rather than the package entry: the entry has no
    // `require` condition, and what is wanted here is the package *location*, not its module.
    const manifest = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
    const distDir = join(manifest, "..", "dist");
    const files = (await readdir(distDir)).filter((name) => name.endsWith(".js"));
    expect(files.length).toBeGreaterThan(5);

    const callSites: Record<string, string[]> = { readTextFile: [], writeTextFile: [] };
    for (const name of files) {
      const source = await readFile(join(distDir, name), "utf8");
      for (const method of ["readTextFile", "writeTextFile"] as const) {
        // `this.client.<method>(` is the agent asking its client to do the work. Anything
        // beyond the single known pass-through is a new internal caller.
        const matches = source.match(new RegExp(`this\\.client\\.${method}\\(`, "g")) ?? [];
        for (const _ of matches) callSites[method]?.push(name);
      }
    }

    expect(callSites["readTextFile"]).toEqual(["acp-agent.js"]);
    expect(callSites["writeTextFile"]).toEqual(["acp-agent.js"]);
  });

  it("would notice an extra call site — positive control", () => {
    // Without this, the assertions above would pass just as happily against a regex that
    // matches nothing at all.
    const source = "a(); this.client.readTextFile(p); b(); this.client.readTextFile(q);";
    const matches = source.match(/this\.client\.readTextFile\(/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});
