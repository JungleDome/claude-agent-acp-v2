# claude-agent-acp-v2

Serves the **Agent Client Protocol v2** (stable baseline) over stdio, backed by the Claude
Agent.

It is not a fork. It depends on [`@agentclientprotocol/claude-agent-acp`][upstream] as a
library and wraps it: that package exports `ClaudeAcpAgent`, whose constructor takes a
seven-method client interface, so a v2 surface can be built on top of the published v1 agent
without carrying a copy of it. Upstream fixes arrive with a version bump instead of a merge
conflict — which matters, because upstream ships roughly every other day.

```
   v2 client  ──stdio, ndjson──▶  this adapter  ──in-process──▶  ClaudeAcpAgent (npm, unmodified)
                                       │                                 │
                                 v2 ⇄ v1 translation            Claude Agent SDK
```

## Status

**Alpha, targeting a draft protocol.** ACP v2 is a prerelease; this package is pinned to an
exact alpha (see [Pinning](#pinning)) rather than a range, because a range would let a routine
`npm install` change the wire protocol.

**There is no ACP v2 client in general release.** The Rust crate `agent-client-protocol` gates
v2 behind an `unstable_protocol_v2` feature that is deliberately excluded from its `unstable`
umbrella, and Zed enables only `unstable`. **This will not work in Zed today.** It is built for
hosts that speak v2 directly.

## Use

```bash
npx -y --package claude-agent-acp-v2 claude-agent-acp-v2
```

Authentication is the wrapped agent's, unchanged — a Claude subscription or API key, exactly as
for the v1 adapter.

As a library:

```ts
import { connectV2 } from "claude-agent-acp-v2";
import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";

connectV2(stream, {
  createAgent: (client, logger) => new ClaudeAcpAgent(client, logger),
});
```

## What it serves

The eleven agent methods of the stable v2 baseline, and nothing else:

```
initialize   auth/login   auth/logout
session/new  session/list  session/resume  session/close  session/delete
session/prompt  session/cancel  session/set_config_option
```

The draft superset — `session/fork`, `providers/*`, `mcp/*`, `nes/*`, `document/*` — is out of
scope by design. v2's migration guide is explicit that negotiating `protocolVersion: 2` implies
none of it.

## What translation actually involves

Most of v2 is a widening of v1 rather than a rewrite. Of the sixteen `sessionUpdate` variants
the wrapped agent emits, twelve share a v2 name and a compatible payload. The interesting parts
are these.

**The prompt-turn inversion.** In v1, `session/prompt` stays pending for the whole turn and its
response carries the `stopReason`. In v2 the response is `{}` and the turn ends with a
`state_update` carrying `idle`. So turn identity is derived here, and a prompt *failure* becomes
an idle update rather than a JSON-RPC error — by the time the wrapped prompt rejects, the
acknowledgement has already been sent. Queued prompts hold the turn open; only the one that
empties the queue reports a stop reason.

**`session/load` is gone.** `session/resume` does both jobs and chooses with a `replayFrom`
cursor: `{"type":"start"}` replays (the wrapped agent's `loadSession`), omitted or `null` does
not (`resumeSession`). An unrecognised cursor is **rejected** with `-32602` rather than guessed
at, as the schema requires — guessing either way corrupts a client's transcript.

**Modes became config options.** v2 removed `session/set_mode` and `current_mode_update`
outright; the same state is a `SessionConfigOption` with `category: "mode"`. The wrapped agent
already publishes one, so a mode change is re-emitted as a `config_option_update`.

**Two renames `tsc` cannot see.** `SessionConfigOption.id` became `configId`, and
`SessionConfigSelectGroup.group` became `groupId`. Both are required fields, so getting them
wrong fails validation outright — see [the schema trap](#the-schema-trap).

**The client filesystem is gone, and it does not matter here.** v2 removed `fs/read_text_file`
and `fs/write_text_file`. Measured against upstream 0.81.1, the wrapped agent never calls them:
`clientCapabilities` is never consulted for `fs`, and the two forwarding methods have no
internal callers, because Claude Code reaches files through its own tools. They are served
locally anyway so a future upstream keeps working, and the bridge counts its calls so that
premise stays observable instead of assumed.

## The schema trap

`@agentclientprotocol/sdk/experimental/v2` generates its TypeScript types from
`schema/v2/schema.unstable.json` — the **draft superset** — and that is the only v2 schema the
npm package ships. `tsc` will therefore happily accept a `compaction_update`, a `plan_removed`,
or a `ToolCallUpdate.name`, none of which exist in the stable baseline.

Measured: the stable schema defines **16** named `SessionUpdate` variants; the SDK's generated
union has **19**.

So this package vendors the stable `schema.json` with a checksum manifest and validates its own
output against it, method-directed through the schema's own `x-method`/`x-side` annotations.
That guard is not decoration — it is what caught both config-option renames above, and it is the
only instrument here that can tell the baseline from the superset.

## Pinning

| | |
|---|---|
| ACP schema | `schema-v2.0.0-alpha.3`, vendored under `schema/v2/` with `SHA256SUMS` |
| `@agentclientprotocol/sdk` | exactly `1.4.0` |
| `@agentclientprotocol/claude-agent-acp` | exactly `0.81.1` |

The SDK pin is `1.4.0` rather than latest on purpose: SDK `1.5.0` ships a *different* v2 schema
(alpha.4/alpha.5). The wrapped agent depends on `1.5.0` and gets its own copy alongside; our v2
code resolves `1.4.0`. The two never meet, because the wrapped agent only ever speaks v1.

Upstream is pinned exactly, not by range, because the adapter reaches past `lib.ts` into the
package's wildcard subpath exports — an unversioned internal surface.

## Development

```bash
npm install
npm run check     # typecheck (two passes) + tests
npm run build
```

The second typecheck pass covers tests and test-support, which the build excludes. Dropping it
leaves those files unchecked with nothing going red.

`docs/mapping/` holds the derivation this implementation was written from, including
`EVIDENCE-v1-shapes.json` — the wrapped agent's real `initialize` and `session/new` responses,
captured by `scripts/probe-v1-shapes.mjs` rather than hand-written, and used directly as test
input.

## Licence

Apache-2.0. `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/sdk` are
Apache-2.0 and are consumed as dependencies; no upstream source is redistributed here.

Not affiliated with, or endorsed by, the Agent Client Protocol project, Zed Industries, or
Anthropic.

[upstream]: https://github.com/agentclientprotocol/claude-agent-acp
