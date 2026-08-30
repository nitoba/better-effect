# Better Auth Effectful API and Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete issues #97 and #98 by adapting every server-side Better Auth endpoint into a directly yieldable operation and exposing the adapted instance through a normal `better-effect` Service token.

**Architecture:** Derive a typed API from the concrete `rawAuth.api` object and implement it with one cached runtime Proxy. Build `BetterAuth.service(tag, rawAuth)` on the public `Service` and `Layer` APIs, then layer session and Web-standard handler helpers over the same proxy and error-normalization boundary.

**Tech Stack:** TypeScript 5.7+, Better Auth 1.7, better-effect 0.13, better-result 3, Bun tests, tsdown, oxlint, oxfmt.

**Spec:** GitHub issues #97 and #98.

## Global Constraints

- Keep `better-auth`, `better-effect`, and `better-result` as peer dependencies.
- Do not import internals from any peer package.
- Do not add database, framework, client-side, migration, env, or Runtime ownership.
- Preserve plugin endpoints, plugin session fields, error codes, Request, Headers, Response, and raw instance identity.
- Normal, `.asResponse`, and `.withHeaders` calls must have distinct exact types.
- Hide `asResponse`, `returnHeaders`, and `returnStatus` from effectful inputs; raw transport variants remain available through `auth.raw`.
- Use TDD and keep runtime casts inside focused internal boundaries with safety comments.

---

### Task 1: Public operation and effectful endpoint types

**Files:**
- Create: `packages/better-effect-better-auth/src/effect-api.ts`
- Modify: `packages/better-effect-better-auth/src/types.ts`
- Modify: `packages/better-effect-better-auth/src/index.ts`
- Test: `packages/better-effect-better-auth/tests/types/effect-api.types.ts`
- Modify: `packages/better-effect-better-auth/tests/types/tsconfig.json`

**Produces:** `BetterAuthOperation`, `BetterAuthEffectEndpoint`, `BetterAuthEffectApi`, transport-input/result helpers, and namespace aliases.

- [ ] Write type tests for built-in endpoints, `getSession`, plugin endpoints, optional inputs, hidden transport flags, exact outputs, and known error-code propagation.
- [ ] Run current and minimum TypeScript tests and confirm they fail because the API does not exist.
- [ ] Implement the minimal mapped types using the final overload/default return of each Better Auth endpoint.
- [ ] Run both TypeScript versions and declaration build until green.
- [ ] Commit the type contract.

### Task 2: Cached runtime Proxy

**Files:**
- Create: `packages/better-effect-better-auth/src/internal/effect-api.ts`
- Test: `packages/better-effect-better-auth/tests/effect-api.test.ts`

**Consumes:** `fromBetterAuthPromise` and the public effectful API types.

**Produces:** `makeBetterAuthEffectApi(rawApi)`.

- [ ] Write runtime tests for the three transport modes, single invocation, receiver preservation, input immutability, wrapper caching, APIError normalization, unexpected defects, conflicting runtime flags, concurrency, symbols, non-functions, and raw API immutability.
- [ ] Run the focused runtime test and confirm the missing implementation fails.
- [ ] Implement one Proxy and one transport-argument normalizer; set all transport flags explicitly without mutating caller input.
- [ ] Run focused and package tests until green.
- [ ] Commit the Proxy.

### Task 3: BetterAuth Service token and Layer

**Files:**
- Create: `packages/better-effect-better-auth/src/service.ts`
- Test: `packages/better-effect-better-auth/tests/service.test.ts`
- Test: `packages/better-effect-better-auth/tests/types/service.types.ts`

**Produces:** `BetterAuth.service`, `BetterAuthService`, `BetterAuthServiceToken`, and exact `Auth.layer`/`Auth.of` integration.

- [ ] Write type tests for `yield* Auth`, requirements, Layer completeness, `Auth.of`, literal tags, raw/plugin inference, and multiple instances.
- [ ] Write runtime tests for raw identity, immutable Layer, Runtime resolution, structural overrides, top-level freezing, and isolated proxies.
- [ ] Run tests and confirm they fail because the factory is absent.
- [ ] Implement a dynamically declared concrete Service class, structural value, readonly Layer attachment, and frozen top-level service.
- [ ] Run focused type/runtime tests until green.
- [ ] Commit the Service factory.

### Task 4: Session and Web handler helpers

**Files:**
- Create: `packages/better-effect-better-auth/src/session.ts`
- Modify: `packages/better-effect-better-auth/src/service.ts`
- Test: `packages/better-effect-better-auth/tests/session.test.ts`
- Test: `packages/better-effect-better-auth/tests/handler.test.ts`
- Modify: `packages/better-effect-better-auth/tests/types/service.types.ts`

**Produces:** `session.get`, `session.require`, `SessionOf`, `SessionSource`, `SessionReadOptions`, and `auth.handle`.

- [ ] Write tests for Request/Headers forwarding, exact options, null preservation, `Unauthenticated` only for null, failure preservation, Response identity/status/headers/streaming, and concurrent isolation.
- [ ] Run focused tests and confirm the missing helpers fail.
- [ ] Implement session helpers by reusing the effectful `getSession` endpoint and implement `handle` with the shared Promise normalization boundary.
- [ ] Run focused type/runtime tests until green.
- [ ] Commit session and handler behavior.

### Task 5: Package and monorepo verification

**Files:**
- Modify only if required by verified package/declaration failures.

- [ ] Run `bun run check` in `packages/better-effect-better-auth`.
- [ ] Run the root `bun run check`.
- [ ] Inspect emitted declarations and packed package boundaries.
- [ ] Verify the branch diff contains no framework, database, client, migration, or core implementation changes.
- [ ] Open a PR against `main` with `Closes #97` and `Closes #98` and include exact verification evidence.
