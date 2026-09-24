/**
 * The permission path.
 *
 * Two things make this worth its own suite rather than a corner of `app.test.ts`. First, `title`
 * is required in v2 and optional-at-best in v1, so the ladder that produces it is the difference
 * between a labelled dialog and an anonymous one at the moment a user is asked to approve
 * something. Second, v2 opened two unions that v1 had closed, and both openings reach a wrapped
 * decoder that throws rather than degrades.
 */

import { describe, expect, it, vi } from "vitest";

import {
  normalisePermissionOutcome,
  permissionDescription,
  permissionTitle,
  type Logger,
  type V1RequestPermissionRequest,
} from "./client-shim.js";
import { validateAgainst } from "./test-support/wire-schema.js";

const quiet: Logger = { log: () => {}, error: () => {}, warn: () => {} };

function request(overrides: Partial<V1RequestPermissionRequest> = {}): V1RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: { toolCallId: "tc-1" },
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
    ...overrides,
  };
}

describe("the title ladder", () => {
  it("prefers the presentation title the wrapped agent already computed", () => {
    // The agent builds `_meta.permission.title` for its own clients, including special cases
    // ("Ready to code?" for ExitPlanMode). Re-deriving from the tool call would lose those.
    const params = request({
      toolCall: { toolCallId: "tc-1", title: "Edit file", name: "Edit" },
      _meta: { permission: { version: 1, title: "Ready to code?" } },
    });
    expect(permissionTitle(params)).toBe("Ready to code?");
  });

  it("falls back to the tool call's own title", () => {
    expect(permissionTitle(request({ toolCall: { toolCallId: "t", title: "Edit file" } }))).toBe(
      "Edit file",
    );
  });

  it("then to a question naming the tool", () => {
    expect(permissionTitle(request({ toolCall: { toolCallId: "t", name: "Bash" } }))).toBe(
      "Use Bash?",
    );
  });

  it("never yields an empty title", () => {
    // v2 makes `title` required; a client that only renders non-empty strings would otherwise
    // show an unlabelled approval dialog.
    expect(permissionTitle(request({ toolCall: {} }))).toBe("Permission required");
    expect(permissionTitle(request({ toolCall: { title: "   ", name: "" } }))).toBe(
      "Permission required",
    );
  });

  it("ignores a malformed meta block instead of throwing", () => {
    expect(permissionTitle(request({ _meta: { permission: "nonsense" } }))).toBe(
      "Permission required",
    );
  });
});

describe("the description", () => {
  it("is promoted when the wrapped agent supplied one", () => {
    const params = request({
      _meta: { permission: { version: 1, title: "t", description: "Reason: policy" } },
    });
    expect(permissionDescription(params)).toBe("Reason: policy");
  });

  it("is omitted rather than invented", () => {
    // v2 reads an absent description as "there is no separate description". Synthesising one
    // would be this adapter asserting why the agent wants permission.
    expect(permissionDescription(request())).toBeUndefined();
    expect(permissionDescription(request({ toolCall: { description: "from the tool call" } })))
      .toBeUndefined();
  });
});

describe("normalising the client's answer", () => {
  const offered = new Set(["allow-once", "reject"]);

  it("passes an offered selection through untouched", () => {
    const answer = { outcome: { outcome: "selected", optionId: "allow-once" } };
    expect(normalisePermissionOutcome(answer, offered, quiet)).toBe(answer);
  });

  it("passes a cancellation through", () => {
    const answer = { outcome: { outcome: "cancelled" } };
    expect(normalisePermissionOutcome(answer, offered, quiet)).toBe(answer);
  });

  it("degrades an option that was never offered", () => {
    const logger = { ...quiet, error: vi.fn() };
    // The wrapped agent's decoder throws "Permission option was not offered", which fails the
    // whole tool call with an error the user cannot act on. Cancelling is something it handles.
    expect(
      normalisePermissionOutcome(
        { outcome: { outcome: "selected", optionId: "invented" } },
        offered,
        logger,
      ),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("degrades an outcome v2 allows and v1 does not", () => {
    // RequestPermissionOutcome is an open union in v2 and closed in v1.
    expect(
      normalisePermissionOutcome({ outcome: { outcome: "_vendor_deferred" } }, offered, quiet),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("degrades a missing or malformed answer", () => {
    expect(normalisePermissionOutcome(null, offered, quiet)).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(normalisePermissionOutcome({}, offered, quiet)).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("never turns an unrecognised answer into an approval", () => {
    // The one direction that must not happen: "I do not understand this" becoming "approved".
    for (const answer of [
      null,
      {},
      { outcome: { outcome: "_weird" } },
      { outcome: { outcome: "selected", optionId: "not-offered" } },
      { outcome: { outcome: "selected" } },
    ]) {
      const result = normalisePermissionOutcome(answer, offered, quiet) as {
        outcome: { outcome: string };
      };
      expect(result.outcome.outcome).not.toBe("selected");
    }
  });
});

describe("the request we build conforms to the stable schema", () => {
  it("validates with a title and a tool-call subject", () => {
    const params = request({
      toolCall: { toolCallId: "tc-1", title: "Edit file" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const built = {
      sessionId: params.sessionId,
      title: permissionTitle(params),
      subject: { type: "tool_call", toolCall: params.toolCall },
      options: params.options,
    };
    expect(validateAgainst("RequestPermissionRequest", built)).toBeNull();
  });

  it("rejects a request with no title — positive control", () => {
    // v1's shape exactly: a bare toolCall and options, no title. This is what forwarding
    // unchanged would have produced.
    expect(
      validateAgainst("RequestPermissionRequest", {
        sessionId: "s1",
        toolCall: { toolCallId: "tc-1" },
        options: [{ optionId: "a", name: "A", kind: "allow_once" }],
      }),
    ).not.toBeNull();
  });
});
