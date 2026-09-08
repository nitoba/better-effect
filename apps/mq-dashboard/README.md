# better-effect-mq reference dashboard backend

This is a deliberately small, executable backend slice for the reference
dashboard. It is Hono Layer-first: `DashboardApp` is a `HonoEffect.app`, the
host uses `BunEffect.server`, and the Runtime is composed by the host. It does
not contain a UI, a storage adapter, or a second Runtime bridge.

The dashboard's optional capabilities are Layer-first as well. Compose the
corresponding public `better-effect-mq` token with its dashboard capability
Layer to expose schedules, flows, or distributed controls. Compose the
`*CapabilityDisabled` Layer when an extension is not installed; the base
dashboard remains available and those route families are not registered.

```ts
Layer.merge(
  DashboardScheduleCapabilityDisabled,
  Layer.merge(
    DashboardFlowCapabilityDisabled,
    Layer.merge(DashboardControlCapabilityDisabled, DashboardApp.layer)
  )
)
```

Use `dashboardScheduleCapabilityLayer()`,
`dashboardFlowCapabilityLayer()`, and `dashboardControlCapabilityLayer()` with
the public `JobScheduleStore`, `FlowStore`, and `QueueControls` Layers when
those extensions are installed.

The application also has explicit Layer-first operational security boundaries:

```ts
Layer.merge(
  DashboardJobRedactionPolicyDisabled,
  DashboardMutationPolicyDisabled,
  Layer.merge(
    DashboardAuditSinkDisabled,
    Layer.merge(DashboardRateLimiterDisabled, DashboardApp.layer)
  )
)
```

`DashboardMutationPolicyDisabled` fails closed for every `POST`/`DELETE` route
while leaving viewer/read-only routes available. Hosts should provide their
own `DashboardMutationPolicy` for confirmation/CSRF checks, may provide an
optional `DashboardAuditSink`, and may replace the basic rate limiter with a
host-owned boundary. `DashboardJobRedactionPolicyDisabled` keeps job payloads,
results, failures, and metadata redacted; hosts may provide
`DashboardJobRedactionPolicy` to authorize job identities and explicitly expose
selected fields or metadata keys for a principal. Its job identity includes the
individual `id` alongside `queue`, `name`, and `version`; mutation decisions
receive `target: "mutation"` plus the action and a denial returns `403` before
the store operation runs. Audit delivery is best-effort and never changes the
mutation result.

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

Reference-host mutations require the configured token in the dedicated custom
header as well:

```bash
curl -X POST \
  -H 'authorization: Bearer local-dev-token' \
  -H 'x-dashboard-csrf: local-dev-token' \
  http://127.0.0.1:3000/api/queues/emails/pause
```

The reference limiter uses one process-local mutation bucket (30 mutations per
minute) and does not use job or user identifiers as labels. `/health`,
`/api/capabilities`, and `/api/overview` expose only boolean availability flags
for the job redaction policy, mutation policy, audit sink, and rate limiter.

`/api/health` is the authenticated operational snapshot. It reports aggregate
SSE connection counts (including reconnects and closed connections), observed
event lag, cursor expiry, stream failures, and bounded-buffer drops/coalescing;
when the host shares a `JobHealth` monitor with its EventStore and
`JobEventConsumer`, the response also includes store failures, lease loss,
stalled recovery, consumer handler failures, and retention count/age. These
values are process-local health telemetry and do not replace the durable event
log. It also reports whether the process-local `awaitEvents` wake path is
available, notification failures, and how often SSE fell back to heartbeat
polling; a failed wake never terminates the stream. The snapshot and its
optional metrics sink never include job IDs, worker IDs, payloads, results,
failures, or user identifiers.

The shipped authorization layer is only a safe local example. Production
applications should replace `DashboardAuthorization` with their host's
authentication, role, CSRF, audit, and rate-limit boundary.

## Compose a persistent store

The dashboard does not create a storage adapter or a second Runtime. Provide
the public `JobStore` and (when installed) matching `JobEventStore` Layers,
the host-owned `DashboardAuthorization` Layer, and adapt the event reader with
`dashboardEventFeedLayer()`:

```ts
const DashboardLive = Layer.complete(
  Layer.merge(
    AuthorizationLive,
    Layer.merge(
      JobStoreLive,
      Layer.merge(
        JobEventStoreLive,
        Layer.merge(
          ClockLive,
          Layer.merge(
            DashboardScheduleCapabilityDisabled,
            Layer.merge(
              DashboardFlowCapabilityDisabled,
              Layer.merge(
                DashboardControlCapabilityDisabled,
                Layer.merge(
                  DashboardAuditSinkDisabled,
                  Layer.merge(
                    DashboardMutationPolicyDisabled,
                    Layer.merge(
                      DashboardRateLimiterDisabled,
                      Layer.merge(dashboardEventFeedLayer(), DashboardApp.layer)
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  )
)

const runtime = await Runtime.make(DashboardLive)
```

For a dashboard without durable events, replace both `JobEventStoreLive` and
`dashboardEventFeedLayer()` with `DashboardEventFeedDisabled`. The base
overview/list/detail/action routes remain available; event and SSE routes
report `events_unavailable`. Schedules, flows, and controls follow the same
optional-capability pattern with their `*CapabilityDisabled` Layers.

To install the optional health feed without changing existing dashboard
composition, share the process-local `JobHealth` monitor used by the store and
consumer with a dashboard monitor:

```ts
const jobHealth = JobHealth.make({ metrics })
const dashboardHealth = makeDashboardHealth({
  jobHealth,
  metrics,
  awaitEventsAvailable: true
})
const events = MemoryJobEventStore.make({ health: jobHealth })

Layer.merge(
  dashboardEventFeedLayer({ health: { available: true, ...dashboardHealth } }),
  DashboardApp.layer
)
```

The feed option is optional and existing `dashboardEventFeedLayer()` callers
remain valid; without it, `/api/health` reports `health_unavailable` while SSE
continues to work without process-local counters.

## HTTP contract

Successful responses use the existing `better-effect/hono` JSON policy and are
wrapped as `{ "data": ... }`. Error responses contain only a stable code and a
public message; storage error messages, lease tokens, and arbitrary metadata
are not returned. The default job redaction policy omits payloads, results, and
full failure data; a host policy may explicitly expose those fields for an
authorized identity.

| Method | Path                                | Role     | Purpose                                                    |
| ------ | ----------------------------------- | -------- | ---------------------------------------------------------- |
| GET    | `/health`                           | none     | Liveness check.                                            |
| GET    | `/api/overview`                     | viewer   | Store descriptor, counts, paused queues, and capabilities. |
| GET    | `/api/jobs`                         | viewer   | Server-side list filters and keyset cursor pagination.     |
| GET    | `/api/jobs/:id`                     | viewer   | Sanitized job detail.                                      |
| GET    | `/api/jobs/:id/attempts`            | viewer   | Sanitized attempt ledger.                                  |
| GET    | `/api/events`                       | viewer   | One finite durable event page.                             |
| GET    | `/api/events/stream`                | viewer   | Resumable SSE event tail.                                  |
| GET    | `/api/health`                       | viewer   | Authenticated aggregate SSE and MQ health snapshot.        |
| GET    | `/api/capabilities`                 | viewer   | Installed optional dashboard capabilities.                 |
| GET    | `/api/schedules`                    | viewer   | List sanitized schedules when installed.                   |
| GET    | `/api/schedules/:group/:key`        | viewer   | Get one sanitized schedule.                                |
| POST   | `/api/schedules/:group/:key/pause`  | operator | Pause a schedule.                                          |
| POST   | `/api/schedules/:group/:key/resume` | operator | Resume a schedule.                                         |
| DELETE | `/api/schedules/:group/:key`        | admin    | Remove a schedule.                                         |
| GET    | `/api/flows/:id`                    | viewer   | Get a sanitized flow snapshot when installed.              |
| POST   | `/api/flows/:id/cancel`             | operator | Cancel a flow through `FlowStore`.                         |
| GET    | `/api/controls/:queue`              | viewer   | Get sanitized distributed controls for a queue.            |
| POST   | `/api/jobs/:id/cancel`              | operator | Cancel through `JobStore.cancel`.                          |
| POST   | `/api/jobs/:id/promote`             | operator | Promote through `JobStore.promote`.                        |
| POST   | `/api/jobs/:id/retry`               | operator | Retry with `{ "delayMs": number }` or `{ "at": number }`.  |
| POST   | `/api/jobs/:id/redrive`             | operator | Alias of retry for dashboard terminology.                  |
| POST   | `/api/queues/:queue/pause`          | operator | Pause through `JobAdmin.for(JobStore)`.                    |
| POST   | `/api/queues/:queue/resume`         | operator | Resume through `JobAdmin.for(JobStore)`.                   |
| DELETE | `/api/jobs/:id`                     | admin    | Remove through `JobAdmin.for(JobStore)`.                   |

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
bounded to 300 seconds. When `awaitEvents` returns a store error or rejection,
the dashboard records an aggregate notification failure and emits the next
heartbeat through polling; the SSE connection remains open.

When retention removes a cursor, the stream emits:

```text
event: cursor-expired
data: {"error":"cursor_expired","oldestAvailableCursor":"...","refreshRequired":true}
```

The client should refresh `/api/overview`, choose a new cursor policy, and
reconnect. Request abort/disconnect is linked to the EventStore wait and the
managed stream Scope; no durable subscriber or checkpoint is created.

Browsers may reconnect the same `EventSource` URL after a transient network
failure; the browser sends `Last-Event-ID` and the server resumes from that
durable cursor. The client buffer is bounded to 200 entries: overflow is
reported as dropped events and duplicate cursor updates are coalesced. These
client-side counters are separate from server-side connection and stream
health counters.

If the EventStore extension is not installed, overview/list/detail/actions keep
working and `/api/events`/SSE return `events_unavailable`. The disabled feed is
`DashboardEventFeedDisabled`; Memory composition uses
`dashboardEventFeedLayer()` with the default public `JobEventStore` token.
The same rule applies to schedules, flows, and controls: their capability
booleans appear in `/api/capabilities` and `/api/overview`, and absent
capabilities leave their endpoint families out of the Hono app.

SSE is a live view over the bounded event log, not an archive. A heartbeat has
no durable cursor, and retention can expire a `Last-Event-ID`; clients must
refresh their cursor policy after `cursor-expired`. The dashboard does not
turn a dropped SSE connection into an acknowledgement or checkpoint, so an
external consumer still owns its at-least-once cursor and replay policy.

## React/Vite reference web client

The frontend lives in `apps/mq-dashboard/web` and is generated with the
shadcn Base UI preset. It uses React, Vite, and the Base UI shadcn components
for controls, dialogs, selects, tabs, tables, tooltips, and scrolling regions.
Interactive controls are never implemented as ad-hoc native buttons, inputs,
selects, or dialogs.

Run the Memory backend and the Vite client in separate terminals:

```bash
MQ_DASHBOARD_TOKEN=local-dev-token bun run --cwd apps/mq-dashboard start
MQ_DASHBOARD_TOKEN=local-dev-token bun run --cwd apps/mq-dashboard/web dev
```

Vite proxies `/api` and `/health` to the loopback backend. During local
development it adds the token to the proxy request on the server side; the
client sends same-origin credentials but never embeds a token or other secret
in the bundle. Production hosts must serve the built `web/dist` assets with
their own secure cookie/authentication, CSP, CSRF, and policy boundary.

```bash
bun run --cwd apps/mq-dashboard/web check
```

The web client keeps the event tail bounded to 200 entries, reconnects from
the latest durable cursor, reports cursor expiration, and falls back to the
finite public event endpoint when the live feed is unavailable.
