# Setup: D1, wrangler and deploy

## 1. wrangler cache on this machine
A root-owned `/home/archvan/node_modules` (from a `sudo npm` install of
`9router`) sits up-tree; wrangler walks up looking for `node_modules/.cache` and
fails with a permission error. The project-local `node_modules/` (created by
`npm install`, gitignored) stops the walk. `CACHE_DIR` does not override this.
Do not `sudo chown` the home-directory one — it belongs to another package.

## 2. Databases (already created — reuse, do not recreate)
| Name | id | Use |
|---|---|---|
| `kicad-partlib` | `4f78a0b2-72b6-4b09-ab45-0272a0e08b9d` | production |
| `kicad-partlib-staging` | `5ba4e898-3277-4331-8ad7-827bac9ef522` | rehearsing migrations / staging deploys |

Free tier allows 10 databases per account; the owner already uses several.

## 3. Migrations
```bash
npx wrangler d1 migrations list  DB --remote --env staging
npx wrangler d1 migrations apply DB --remote --env staging   # rehearse here first
npx wrangler d1 migrations apply DB --remote                 # then production
```
`0001_initial.sql` is already applied on both (empty). `0002_worker_schema.sql`
drops those tables and builds the Worker schema; it is destructive and is safe
only because both databases hold no rows — **re-check
`SELECT COUNT(*) FROM parts` immediately before applying.**

## 4. Cloudflare Access
Put the Worker behind Access (Zero Trust → Access → Applications, self-hosted,
policy: your email). Copy the team domain (`<team>.cloudflareaccess.com`) and the
application **AUD tag** into `wrangler.jsonc` `vars` (`ACCESS_TEAM_DOMAIN`,
`ACCESS_AUD`) for each environment. Until both are set the deployed Worker refuses
every request — by design. For a CLI later, create an Access **service token**.

## 5. Deploy
```bash
npx wrangler deploy --env staging
npx wrangler deploy
```

## 6. Backups and Time Travel
```bash
npx wrangler d1 export kicad-partlib --remote --output=backups/$(date -u +%Y-%m-%dT%H%M%SZ).sql
npx wrangler d1 time-travel info kicad-partlib
```
Time Travel on free is 7 days, restores **in place, for the whole database** — so
restoring after a bad bulk change also discards every stock move since. Export
before any bulk apply.

## 7. Second machine
`git clone`, `npm install`, `npx wrangler login`. There is no data to sync.
