# GQ Support

WordPress plugin that adds an in-dashboard chat window for logged-in editors
and administrators to report bugs.

No functionality is implemented yet — this is a scaffold.

## Layout

- `plugin/` — the WordPress plugin. `plugin/gq-support.php` is the
  main plugin file installed into WordPress; it enqueues the built widget
  from `plugin/assets/dist/`.
- `plugin/app/` — the chat widget frontend (React + TanStack Query), built
  with Vite into `plugin/assets/dist/`.
- `worker/` — a Cloudflare Worker backend, provisioned with
  [Alchemy](https://alchemy.run) and written with
  [Effect](https://effect.website). Currently a placeholder with no routes.

## Development

```sh
pnpm install

# build the chat widget bundle consumed by the WordPress plugin
pnpm build:app

# run the Cloudflare worker locally
pnpm dev:worker

# deploy the Cloudflare worker
pnpm deploy:worker
```
