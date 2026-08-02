# CarsSearch — multi-request car search platform (viewer + data)

## What this repo is

The **data and website half** of a two-repo platform. A user creates a *search
request* (body type, minimum model year, free-text filter); an automated service
in `TelegramBasics` ("TG-Platform") works through the brand checklist, researches
models, finds real for-sale offerings in Portugal/the EU, and commits results
back here. This repo is a static GitHub Pages site with **no build step** — it
holds the request files, the results, and the viewer that renders them.

This repo never runs the search. It holds what the search produces.

## Layout

```
CarsSearch/
├── Config/brands.json                 # immutable brand checklist (26 groups, 136 brands)
├── Requests/
│   ├── index.json                     # MANIFEST -- GH Pages has no directory listing
│   └── req-0001-roadsters/
│       ├── request.json               # single source of truth for progress
│       ├── results.json               # the models + their offerings
│       └── favorites.json             # committed favorites snapshot
├── docs/                              # the site (GitHub Pages serves from here)
│   ├── index.html  app.css  app.js    # split for readability; still zero build step
│   ├── assets/body-types.svg  logo.png
│   └── *.schema.json                  # one schema per JSON shape above
├── tools/
│   ├── verify.py                      # schemas + cross-file invariants + golden test
│   ├── migrate_legacy.py              # one-shot legacy -> req-0001 migration
│   └── fixtures/legacy_*.json         # frozen legacy dataset, for the golden test only
└── phase1-*.md  phase2-*.md           # narrative trail of the original roadster research
```

## Invariants — do not break these

1. **`Config/brands.json` is read-only to the pipeline.** It is the checklist
   every request derives its own progress board from. Nothing writes to it: no
   progress fields, no timestamps, no "EU presence" writeback. Because it is
   never written, it can never conflict on push.
2. **`request.json` is the single source of truth for progress.** It owns both
   *State* (`search_state` — which group/brand is being searched right now) and
   *Status* (`status` + the per-brand `progress` checklist). `Requests/index.json`
   is a **derived mirror**, regenerated wholesale, never hand-edited — that is
   what keeps it merge-conflict-proof.
3. **`search_state` is stored structured**, not as a `"[Group; Brand]"` string.
   The display string is derived in the UI; resume needs the ids.
4. **Never fabricate a listing, price or URL.** Every offering URL must be a page
   the browser actually opened, every `price_eur` must appear in that page's
   text, and `country` must be in the EU/EEA enum. An explicit "none found"
   always beats an invented one — that is why `search_status` has
   `completed_no_offerings` and `completed_insufficient_sources` values.
5. **One request loads at a time.** The viewer never unions two requests'
   results; picking a request means loading exactly that request's `results.json`.
6. **Schemas are enforced, not decorative.** Every JSON shape has a
   `*.schema.json` with `additionalProperties: false`. Run `tools/verify.py`
   after touching any of them.
7. **`docs/assets/body-types.svg` and the `body_type` enum are the same thing.**
   Each shape's `data-body-type` is an enum value; `verify.py` fails if they
   diverge. Keep the file valid XML (no `--` inside comments) — it is served as
   `image/svg+xml`, so a parse error breaks it everywhere except `innerHTML`.

## Verifying

```bash
python tools/verify.py
```

Validates every JSON against its schema, checks that `index.json` agrees with
each `request.json`, that progress counters match their own checklist, that no
model claims a brand or group absent from `Config/brands.json`, that the SVG and
the enum match, and runs the migration golden test (58 models, MX-5 average still
33350, every offering traceable to the legacy dataset, kept + dropped
reconstructing the original count).

`jsonschema` is the only dependency: `python -m pip install jsonschema`.

## Serving the site

`fetch()` is used throughout, so `file://` will not work. Serve the **repo root**
(not `docs/`) — the viewer resolves manifest paths as `../Requests/...`:

```bash
python -m http.server 8000
```

then open `http://localhost:8000/docs/`.

## The viewer

- **Request picker** (top left) lists every request from the manifest with its
  status and, mid-run, the group/brand being searched. Deep-linkable via
  `#req=<request_id>`.
- **New Request** (the gold button) collects body type / model-year floor /
  special filter and downloads a schema-valid `request.json`. The page is static
  with no backend, so it cannot write to the repo — commit the downloaded file to
  `Requests/<request_id>/request.json`, or hand it to the bot's `/NewRequest`.
- **Photo popup** — model names with a photo are buttons; clicking opens the
  image and its provenance.
- **Favorites are per request.** localStorage key `carResearchFavorites:<request_id>`,
  seeded from the committed `favorites.json`. "Export favorites.json" downloads
  the current selection in the committed shape; commit it back to persist it for
  other browsers. `carResearchColumns.v2` is the column-selection key — bumped
  from v1 because the column ids changed with this schema.

## Tier assignment rules

`tier` is a closed enum, assigned by **objective rule**, never by feel:

| Tier | Rule |
|---|---|
| `mainstream` | `average_budget_eur` < €40,000 |
| `premium` | €40,000 ≤ `average_budget_eur` < €100,000 |
| `exotic` | €100,000 ≤ `average_budget_eur` < €500,000 |
| `ultra-exotic` | `average_budget_eur` ≥ €500,000, **or** a bespoke/very-limited-run car that sold out at or shortly after reveal |
| `not yet available` | `average_budget_eur` is `null` — no confirmed production price. Use this even if rumoured figures exist; don't tier off a rumour. |
| `unconfirmed` | Real-world trims straddle two bands badly enough that one average misleads, or the tier genuinely can't be determined. **Always prefer `unconfirmed` over inventing a compound label.** |

1. **Derive, don't hand-pick** — never assign a tier that contradicts the number.
2. **No compound labels** (`premium/exotic`); use `unconfirmed` and explain the
   spread in `model_variant`.
3. **No research-provenance notes in `tier`** — that describes the process, not
   the car.
4. **Re-derive on every price change.**

## Data quality

- Prices and listing URLs are traceable to a source page, per offering.
- Spec fields (`engine`, `fuel_or_charge_consumption`, `tank_or_battery_size`)
  are good-faith approximations unless stated otherwise — flagged in
  `results.json`'s `metadata.specs_disclaimer`.
- `tax` / `import_tax` are typed from the start
  (`{"status":"tbd","value_eur":null,"basis":""}`) so "TBD" never has to migrate
  from string to number later. Portuguese ISV, VAT and import duty are not yet
  computed.

## History — where req-0001 came from

The repo began as a single hard-coded dataset: 58 roadsters in
`storage/car_data.json`, rendered by one 903-line page whose "Category" section
had exactly one radio button. That dataset is now `req-0001-roadsters`, migrated
by `tools/migrate_legacy.py`; `storage/` and `docs/car_data.schema.json` were
deleted in the same commit, because two authoritative copies of the same data is
exactly the invariant this layout exists to protect. Git history is the rollback.

The migration kept 52 of 67 legacy listings. The 15 dropped are counted by reason
in `results.json`'s `metadata.migration.drop_reasons` — mostly price *ranges*
scraped off aggregate search pages ("EUR 44900-53490"), which are not single
listings and have no price that is substring-present on any page. Models whose
legacy status claimed a finished search but whose listings did not survive were
demoted to `completed_no_offerings` rather than left claiming completeness.

`phase1-*.md` and `phase2-*.md` are the narrative record of that original
research and are kept as-is; they describe a method (search-snippet extraction)
that the new pipeline deliberately replaces with direct page parsing.
