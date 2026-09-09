# Skill and application validation

This is a reproducible review/evaluation rubric, not a claim that independent
agents or every package test have already passed. Static documentation checks,
TypeScript checks, behavioral tests, and agent evaluations are different kinds
of evidence. Report each separately.

## Before changing the skill

Pin the repository commit and inspect all package directories/manifests. For
changed APIs, inspect public exports and relevant implementation/type tests.
Read existing skill references so a new page does not leave conflicting old
examples in place. Establish a failing retrieval or application scenario before
editing, then rerun that same scenario on the updated guidance.

Two concrete old transformation examples motivated structural regressions in
this refresh: a two-parameter simple Layer.scoped callback, and a Hono example
redeclaring `const app` at module scope. These can be checked structurally, but
structural checks alone do not prove TypeScript validity or lifecycle behavior.

## Agent evaluation scenarios

For each scenario, give an isolated agent the task, target-version exports, and
the installed skill. Require code or a precise review, not a paraphrase of the
skill. Compare a baseline run with the updated skill using the same scenario.
Mark a pass only when the stated contract is actually met; do not count reading
the expected answer as an independent evaluation.

| Scenario to give the agent | Required outcome |
| --- | --- |
| Build a lazy Service-backed operation accepting an ID | Ordinary parameterized factory returning Effect.fn; return Result; inferred requirement; no eager module-scope execution |
| Compose providers and override one in a test | Layer.complete and explicit compatible override; no casts or merge-order replacement |
| Fix the old scoped cleanup/Hono examples | Correct release overload and one Hono instance scoped to acquisition; yield captured builders; no duplicate const declaration |
| Serve Hono with auth, DB, MQ, and a publisher | One owning Runtime; complete typed graph; non-owning callbacks; one owner per pool; deliberate readiness and shutdown |
| Create Next App Router routes | One shared managed manager or fromCurrent inside an existing execution; await params; real host cleanup; no Edge/HMR claims |
| Validate a native Zod/Valibot/ArkType input | Matching provider facade; normalized Result failure; no hand-rolled Standard Schema when native support exists |
| Persist a schema class containing a Date | Decode once, explicit encode to wire; retain class in domain; do not return it through default strict Web JSON serialization |
| Call a status-discriminated HTTP endpoint | Declared error status handled in successful response union; undeclared status remains error; no fake generic validation |
| Add retry/refresh to a one-shot request | One retry owner, bounded attempts/deadlines, replayability checked, scoped credentials, no unsafe blind POST replay |
| Proxy an SSE/NDJSON stream and cancel halfway | Managed request lifetime, bounded parsing/reconnect, no scope release at headers, upstream cleanup, no exactly-once claim |
| Add a Better Auth plugin endpoint and hook | Concrete type preserved; mode methods rather than flags; hook uses current executor and explicit failure mapping |
| Execute two Kysely writes atomically | Native callback transaction for both; `$call` terminals; typed Err rolls back; no ambient Database replacement assumption |
| Run a job on another storage adapter | Same Queue/Job/Worker API, proper token binding and provider acquisition, codec input/output distinction, at-least-once semantics |
| Add recurring jobs and parent/child work | Matching schedule/flow stores, reconciliation/group policy, Clock, Layer-owned supervisors, durable manifests |
| Commit a domain write and enqueue reliably | Prepare first, validate record, record-first native transaction, token routes, post-commit publisher, deterministic IDs |
| Use MongoDB/SQLite/Redis in deployment | Mongo transactions required; SQLite host/file constraints; Redis persistence/native transaction limits; explicit compatible migrations |
| Add deterministic tests and tracing | Test Layers/standard Services, lifecycle and failure assertions, bounded safe telemetry, no global SDK installation by the library |

## Static skill checks

Check frontmatter name/description, balanced Markdown fences, relative links,
all package names in the routing table, and all optional subpath boundaries
in the focused references. Compare `packages/*/package.json` names/exports
with the skill, rather than preserving a hard-coded inventory forever.
Check that deleted/renamed APIs occur only in explicit migration warnings.
Check that source links point to files known to exist in the reviewed tree.

Review TypeScript examples independently: imports, generator return types,
correct use of Result.await versus yieldable Operations, typed empty/non-empty
Layer requirements, overload argument order, and native resource types.
Fragments must identify their enclosing context; do not label a fragment a
standalone executable example.

## Application checks

From a fully installed checkout, run the repository's canonical checks:

```sh
bun install
bun run check
git diff --check
```

Read each affected package's scripts for its focused type, unit, example,
documentation, and packed-consumer checks. Do not assume every package uses
the same script names. Typecheck standalone examples against the supported
consumer versions, not just path aliases in a monorepo.

Behavioral coverage should include Result.err, defects/rejections, cancellation,
cleanup failure precedence, root/request isolation, lazy provider startup,
managed-stream EOF/early cancel, transaction rollback, retries after partial
side effects, migrations/layout validation, and named store consistency.
Use real dialect/server integration tests where those semantics are the subject;
a memory fixture does not establish durability or distributed behavior.

When Bun, dependencies, servers, or independent agent runners are unavailable,
record the missing validation precisely. Do not rename static checks as a
full test suite or state that CI passed without observing its result.
