# better-effect-mq dashboard web

Reference React/Vite client for `apps/mq-dashboard`. The UI is generated with
the shadcn Base UI preset and uses the local Base UI wrappers for controls,
dialogs, selects, tabs, tables, tooltips and scroll regions.

## Development

Start the Hono server and the Vite client in separate terminals:

```bash
MQ_DASHBOARD_TOKEN=local-dev-token bun run --cwd apps/mq-dashboard start
MQ_DASHBOARD_TOKEN=local-dev-token bun run --cwd apps/mq-dashboard/web dev
```

The Vite development server proxies `/api` and `/health` to the loopback
dashboard server and injects the token only into the server-side proxy request.
Production deployments should keep authentication,
authorization, CSRF policy, secure cookies and CSP at the host boundary. No
credential is embedded in the client bundle.

The client reads only the dashboard's public JSON/SSE endpoints. It keeps a
bounded 200-event live tail, reconnects from the durable cursor, and requests a
full refresh when the server reports an expired cursor.

## Validation

```bash
bun run --cwd apps/mq-dashboard/web check
```

The package check runs TypeScript, the Vite production build, Oxlint and Oxfmt,
the same linter and formatter used by the rest of the repository.
