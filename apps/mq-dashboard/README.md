# better-effect-mq reference dashboard backend

This is a deliberately small, executable backend slice for the reference
dashboard. It is Hono Layer-first: `DashboardApp` is a `HonoEffect.app`, the
host uses `BunEffect.server`, and the Runtime is composed by the host. It does
not contain a UI, a storage adapter, or a second Runtime bridge.

## Run the Memory example

The host is loopback-only by default and requires an explicit token to answer
requests:

```bash
MQ_DASHBOARD_TOKEN=local-dev-token bun run --cwd apps/mq-dashboard start
```

Use `MQ_DASHBOARD_HOST` only when the host boundary supplies a token. The
server rejects non-loopback binding without `MQ_DASHBOARD_TOKEN`.

```bash
curl -H 'authorization: Bearer local-dev-token' \
  http://127.0.0.1:3000/api/overview
```

The shipped authorization layer is only a safe local example. Production
applications should replace `DashboardAuthorization` with their host's
authentication, role, CSRF, audit, and rate-limit boundary.

## HTTP contract

Successful responses use the existing `better-effect/hono` JSON policy and are
wrapped as `{ "data": ... }`. Error responses contain only a stable code and a
public message; storage error messages, payloads, results, full failure data,
lease tokens, and arbitrary metadata are not returned.

| Method | Path                        | Role     | Purpose                                                        |
| ------ | --------------------------- | -------- | -------------------------------------------------------------- |
| GET    | `/health`                   | none     | Liveness check.                                                |
| GET    | `/api/overview`             | viewer   | Store descriptor, counts, paused queues, and event capability. |
| GET    | `/api/jobs`                 | viewer   | Server-side list filters and keyset cursor pagination.         |
| GET    | `/api/jobs/:id`             | viewer   | Sanitized job detail.                                          |
| GET    | `/api/jobs/:id/attempts`    | viewer   | Sanitized attempt ledger.                                      |
| GET    | `/api/events`               | viewer   | One finite durable event page.                                 |
| GET    | `/api/events/stream`        | viewer   | Resumable SSE event tail.                                      |
| POST   | `/api/jobs/:id/cancel`      | operator | Cancel through `JobStore.cancel`.                              |
| POST   | `/api/jobs/:id/promote`     | operator | Promote through `JobStore.promote`.                            |
| POST   | `/api/jobs/:id/retry`       | operator | Retry with `{ "delayMs": number }` or `{ "at": number }`.      |
| POST   | `/api/jobs/:id/redrive`     | operator | Alias of retry for dashboard terminology.                      |
| POST   | `/api/queues/:queue/pause`  | operator | Pause through `JobAdmin.for(JobStore)`.                        |
| POST   | `/api/queues/:queue/resume` | operator | Resume through `JobAdmin.for(JobStore)`.                       |
| DELETE | `/api/jobs/:id`             | admin    | Remove through `JobAdmin.for(JobStore)`.                       |

`/api/jobs` accepts `queue`, `name`, `version`, repeated or comma-separated
`state`, repeated `metadata=key:value`, `orderBy`, `order`, and `limit` (maximum
100). Its `nextCursor` is an opaque base64url value; send it back unchanged as
`cursor`.

`/api/events` accepts repeated or comma-separated `queue`, `jobId`, repeated or
comma-separated `type`, `limit` (maximum 100), and `after`. Event filters are
applied in the server/store reader; event responses expose only the public
durable event fields and bounded safe attributes.

## SSE behavior

`/api/events/stream` reads `Last-Event-ID` first, then the optional `after`
query parameter. It uses `JobEvents.page` for finite reads and the EventStore's
public wake API as a hint with a bounded heartbeat fallback. Durable job events
use `event: job-event` and their cursor as the SSE `id`. Heartbeats use
`event: heartbeat` and no durable cursor. The `heartbeatMs` query parameter is
bounded to 300 seconds.

When retention removes a cursor, the stream emits:

```text
event: cursor-expired
data: {"error":"cursor_expired","oldestAvailableCursor":"...","refreshRequired":true}
```

The client should refresh `/api/overview`, choose a new cursor policy, and
reconnect. Request abort/disconnect is linked to the EventStore wait and the
managed stream Scope; no durable subscriber or checkpoint is created.

If the EventStore extension is not installed, overview/list/detail/actions keep
working and `/api/events`/SSE return `events_unavailable`. The disabled feed is
`DashboardEventFeedDisabled`; Memory composition uses
`dashboardEventFeedLayer()` with the default public `JobEventStore` token.
