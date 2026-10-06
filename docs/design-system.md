# Design system

The UI borrows the look of the [lcsc.com](https://www.lcsc.com/) storefront, because the parts and the orders come from
LCSC and the app should feel like a continuation of that page. All of it lives in `src/web/style.css`; this note says what
each piece means so new screens use it the same way.

## Where the values come from

lcsc.com's stylesheets export a named colour map on their components (read 2026-10-06): `primary #1166dd`,
`major #1c1f23`, `secondary #666`, `lighter #babbbc`, `accent #005caf`, `error #eb4526`, `success #3eb350`,
`warning #ff8a00`, `price #ff7134`, `datasheet #ff5562`, plus `#033b96` for the top system bar and `#ecf2fe` for a hovered
menu item. Those are used unchanged. LCSC's logo and icons are not used.

Derived here, because LCSC does not need them:

* a **dark theme**;
* an `-ink` (text) and `-tint` (ground) per status: LCSC's green, orange and price orange are 2.4 to 2.7:1 on white, too
  faint for small text, so they are used only as marks (meter fills, stripes) and badges use the `-ink`/`-tint` pair
  (at least 4.5:1 in both themes, checked by script);
* `price-ink` / `price-fill` for money as text and for the buy button;
* Roboto Mono (`--font-mono`) for codes, available but not yet applied everywhere.

## Roles

| Token | Means |
|---|---|
| `--primary`, `--primary-fill` | You can open or commit this: links, the active tab, the primary button, the focus ring |
| `--price-ink`, `--price-fill`, `--price-tint` | Money: unit price, landed cost, Best pick, stock value; buy actions (`button.buy`, `a.button.buy`) |
| `--success-*`, `--warning-*`, `--error-*` | Good / caution / bad states, as `-tint` ground with `-ink` text |
| `--page`, `--surface`, `--surface-sunken` | Grey page, white panels and tables, grey table header |
| `--line`, `--line-strong` | Hairlines; input borders (below 3:1, as on LCSC; the focus ring carries the contrast) |
| `--primary-deep` | The system bar only |

The names the stylesheet was first written with (`--bg`, `--fg`, `--muted`, `--accent`, `--ok`, `--warn`, `--bad`,
`--chip`) are mapped onto these, so older rules keep working. Use the new names in new rules.

## Badges

| List | Class |
|---|---|
| Condition | `cond-new`, `cond-tested_ok` (success), `cond-untested` (warning), `cond-faulty` (error) |
| Stock status | `st-ok`, `st-reorder`, `st-out` |
| Need status | `need-buy` (price), `need-ordered` (primary), `st-ok` for Received, `need-covered` (outlined), `need-cancelled` (struck) |

The words are always shown; colour never stands alone. Values keep the owner's sheet spelling.

## Layout

The header is a 32 px system bar plus a 48 px tab bar (`--nav-h` is their sum, used by the Parts workspace height); on a
phone the system bar is hidden. Controls are 32 px tall with 4 px corners; the Parts search is 40 px with a 2 px blue border;
panels and the table viewport have 8 px corners.
