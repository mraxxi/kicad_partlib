# Setting up the database

One-time for the account, then once per machine.

---

## 1. The wrangler cache problem on this machine (do this first)

`wrangler d1 list` fails here with:

```
✘ [ERROR] A permission error occurred while accessing the file system.
  Affected path: /home/archvan/node_modules/.cache/wrangler
```

**Cause.** wrangler walks up from the working directory looking for the nearest
`node_modules/.cache` to write its cache into. A **root-owned**
`/home/archvan/node_modules` (left by a `sudo npm` install of `9router`) sits
up-tree from this project, so wrangler finds it and cannot write there.

**Fix**, already applied and gitignored — an empty project-local directory stops
it walking up:

```bash
mkdir -p node_modules/.cache
```

`CACHE_DIR=...` does **not** override this; measured. Do not `sudo chown` the
home-directory `node_modules` — it belongs to another package.

---

## 2. Create the database

```bash
wrangler login                      # OAuth; needs the `d1 (write)` scope
wrangler d1 create kicad-partlib
```

Note the `database_id` it prints.

> **Watch the quota.** The free tier allows **10 databases per account**. Check
> what is already there with `wrangler d1 list` before creating more — a
> migration-rehearsal database (§5) costs one of those slots.

### `wrangler.toml`

```toml
name = "kicad-partlib"
compatibility_date = "2026-01-01"
migrations_dir = "migrations"

[[d1_databases]]
binding       = "DB"
database_name = "kicad-partlib"
database_id   = "<the uuid from `wrangler d1 create`>"
```

`migrations_dir` is what makes `wrangler d1 migrations` find this repo's
`migrations/` directory.

---

## 3. Apply the schema

```bash
wrangler d1 migrations list  kicad-partlib      # what is pending
wrangler d1 migrations apply kicad-partlib      # apply it
```

Locally, with no account and no network — this is also how the SQL probes in
`AGENTS.md` §2.3 were run:

```bash
wrangler d1 execute DB --local --file=migrations/0001_initial.sql
wrangler d1 execute DB --local --command="SELECT key, value FROM meta"
```

Re-applying is safe: every statement is idempotent, and
`tests/test_schema.py::test_applying_every_migration_twice_changes_nothing`
keeps it that way.

---

## 4. The API token, scoped as narrowly as possible

The tool talks to D1 over REST, not through wrangler, so it needs its own token.
**Do not reuse the OAuth token wrangler stores** — create a dedicated one.

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**:

| Setting | Value |
|---|---|
| Permissions | **Account · D1 · Edit** — nothing else |
| Account Resources | **Include · (only this account)** |
| Zone Resources | none |
| TTL | set one, and diarise the renewal |

A token scoped this way can still read and write **every D1 database on the
account**; Cloudflare offers no per-database scope. That is a reason to keep the
TTL short, not a reason to shrug.

Then, **outside the repository**:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/kicad_partlib"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/kicad_partlib/secrets.json" <<'JSON'
{
  "version": 1,
  "cf_account_id": "c86ea3b86fead77371a006407b27eaa9",
  "cf_database_id": "<the uuid>",
  "cf_api_token": "<the token>"
}
JSON
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/kicad_partlib/secrets.json"
```

Environment variables override the file, which is how CI and one-off shells work:

```
KICAD_PARTLIB_CF_ACCOUNT_ID
KICAD_PARTLIB_CF_DATABASE_ID
KICAD_PARTLIB_CF_TOKEN
```

CI never gets a token: the whole suite runs against SQLite.

### If the token is rejected
A `401`/`403` must never retry — nothing was written. The tool says which config
path it read and which permission is required. If you rotate the token, only the
file above changes; nothing in the repository refers to it.

---

## 5. A second database for rehearsing migrations

Migrations are the one operation that can damage the only copy of the data, so
rehearse them:

```bash
wrangler d1 create kicad-partlib-staging
wrangler d1 export kicad-partlib --output=/tmp/seed.sql
wrangler d1 execute kicad-partlib-staging --file=/tmp/seed.sql
wrangler d1 migrations apply kicad-partlib-staging    # rehearse here
wrangler d1 migrations apply kicad-partlib            # then production
```

Costs one of the 10 free database slots. Worth it.

---

## 6. Backups, and what Time Travel will not do

```bash
wrangler d1 export kicad-partlib --output=backups/$(date -u +%Y-%m-%dT%H%M%SZ).sql
```

`inv backup` wraps this, records the run in the `backups` table, and `inv status`
reports the age of the newest one.

**Time Travel is not a substitute.** On the free tier it is 7 days, it restores
**in place**, and it is **all-or-nothing for the whole database**. So restoring
after a botched bulk import also discards every stock event recorded since.
The append-only ledger protects stock; it does not protect `parts`.

```bash
wrangler d1 time-travel info    kicad-partlib
wrangler d1 time-travel restore kicad-partlib --timestamp=<iso8601>
```

That is why the tool **refuses a bulk mutating apply without a fresh export**,
with `--skip-export` as a knowing override.

---

## 7. Useful wrangler commands

| Command | Use |
|---|---|
| `wrangler d1 info kicad-partlib` | database size, for `inv status` |
| `wrangler d1 insights kicad-partlib` | which queries are actually costing rows read — the honest way to revisit the read budget |
| `wrangler d1 execute … --local` | run SQL against D1's engine with no account |
| `wrangler d1 export … --no-data` | schema only, for diffing against `migrations/` |

---

## 8. Setting up the second machine

```bash
git clone <this repo> ~/Documents/Kicad/KICAD_PART_LIBRARY
cd ~/Documents/Kicad/KICAD_PART_LIBRARY
mkdir -p node_modules/.cache                      # only if wrangler misbehaves as in §1
python -m venv --system-site-packages .venv
.venv/bin/pip install -r requirements-dev.txt
# write secrets.json as in §4
.venv/bin/python scripts/inv_manager.py health
```

There is **no data to sync** — that is the whole point of the storage choice.
`health` confirms the schema version matches what this checkout expects and
refuses to write if the checkout is older than the database's
`min_code_version`.
