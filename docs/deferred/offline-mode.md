> **Written for the Python/REST design (superseded 2026-10-06).** The tradeoff analysis still holds; the mechanisms (`inv export`, per-device ledger) need rethinking for the Worker. Still deferred.

# Deferred design: offline mode

**Status:** stub, and deliberately unbuilt. **Do not start this as a patch.**

---

## Why this file exists

`AGENTS.md` Rule A says the database is the only source of truth, with no local
mirror, and tells future contributors not to "improve" that by adding one. This
file is where the argument goes if the decision is ever revisited, so that the
revisit is deliberate rather than incremental.

The owner chose D1-only **after** the tradeoff was spelled out: nothing works
without network, a revoked token or lapsed account means no inventory, and
7-day Time Travel plus manual exports are the only safety net. That was an
informed choice, and the mitigation agreed at the time was the export gate in
`AGENTS.md` §7 — not a mirror.

## What would actually be involved

This is a project, not a flag. In rough dependency order:

1. **A local SQLite mirror** with the same schema — which already exists as the
   test double (`SqliteStore`), so the dialect work is done. That is the easy
   10%.
2. **A pending-write queue.** Every mutation made offline must be durably queued
   locally and replayed on reconnect. The `event_id` idempotency of Rule 2 is
   what makes replay safe, and it is already in place — the single most
   important piece of groundwork, and it was not built for this.
3. **Pull-since-sequence.** Fetch events with `seq > <last seen>`. **`seq` has
   gaps** (`AGENTS.md` §2.3), so this must never treat the numbering as dense or
   infer completeness from it.
4. **Reconciliation of `parts` edits**, which is the genuinely hard part. Stock
   events are append-only and merge trivially; a part *row* edited on two
   machines while both were offline does not. `rev` and `rev_token` give
   detection, not resolution — this needs a real conflict UI, and it is where
   the time would go.
5. **A staleness model in the UI.** Every figure would need to say whether it is
   authoritative or local-and-unsynced. The existing "last known, N days old"
   treatment for prices is the pattern, extended to everything.

## The cheaper things to do first

If the motivation is *"I was on a plane and could not look up a part"*, these
cost far less and may be enough:

* **`inv export --json`** to a file, plus a read-only `--offline` mode that
  answers lookups from it. Read-only sidesteps all of step 4.
* The existing **`inv backup`** SQL dump already contains everything; a tiny
  reader over it is most of the value for almost none of the work.

If the motivation is *"I do not trust the account to still exist in five
years"*, then the answer is not offline mode at all — it is scheduled exports
plus a documented restore path, which is `AGENTS.md` §7 done properly.

## If it is ever built

Start by writing the conflict-resolution UI for step 4, **before** anything
else. Every other piece is mechanical; that one decides whether the feature is
usable, and building it last is how this kind of project ends up abandoned at
90%.
