# Hono example

This is a development-only example. Install Hono in the application, then
mount Better Auth's public Web handler directly:

```ts
app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
```

The protected route runs a normal `better-effect` Program with the `Auth`
Service. `better-effect-better-auth` does not publish a Hono subpath, does not
add Hono to its runtime dependencies, and does not replace Better Auth's
handler.

Run it from this package with:

```bash
bun examples/hono/app.ts
```
