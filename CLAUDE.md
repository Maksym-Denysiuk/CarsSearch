# Car-research- : Roadster Buying Research (Portugal)

## What this project is

Research into buying a roadster (2024+ model year) in Portugal. The buyer prefers open-top two-seat sports cars, budget open for now, and wants an exhaustive world-wide list before narrowing down to real, buyable cars. Work is organized into three sequential phases; a phase is only started once the prior phase's stated exit condition is met.

## Project structure

```
Car-research-/
├── CLAUDE.md                            # this file
├── phase1-roadster-guide.md             # Phase 1, first pass (baseline ~24 models)
├── phase1-extended-roadster-list.md     # Phase 1, deep-research convergence pass + addendum
├── phase2-portugal-europe-listings.md   # Phase 2, human-readable real-listing writeup
├── storage/
│   ├── car_data.json                    # Authoritative structured dataset (Phases 1-2 combined)
│   └── favorites.json                   # Committed snapshot of the user's favorite car ids
└── docs/
    ├── car_data.schema.json             # JSON Schema (2020-12) for storage/car_data.json
    ├── favorites.schema.json            # JSON Schema (2020-12) for storage/favorites.json
    └── index.html                       # Simple static viewer for storage/car_data.json
```

`storage/car_data.json` is the **authoritative, up-to-date source** — it's kept in sync with the latest findings from both phases. The `.md` files are the narrative research trail (useful for methodology and reasoning) and may lag behind the JSON on the newest finds; when they disagree, trust the JSON.

`docs/car_data.schema.json` documents and validates the structure of `storage/car_data.json`. `docs/index.html` is a dependency-free viewer (fetch + filter/sort/group table) — since it uses `fetch()`, opening it via `file://` will fail in most browsers; serve the repo root instead, e.g. `python3 -m http.server 8000` then visit `http://localhost:8000/docs/`. Whenever a JSON's shape changes, update its schema alongside it.

### Favorites

The viewer lets you star cars and switch to a "Favorites" tab that shows only starred models. Because `docs/index.html` is a static page with no backend, it can't silently write back into the repo (embedding a GitHub write-token in public client-side JS would be a real security hole — anyone visiting the page could steal it). So favoriting works in two layers:

1. **Instant, per-browser**: clicking a star updates `localStorage` immediately — no reload needed, persists across visits in that browser.
2. **Committed snapshot**: `storage/favorites.json` (validated by `docs/favorites.schema.json`) is what the page seeds its initial favorites from, and what's checked into the repo. The "Export favorites.json" button downloads the current selection in that exact shape — download it and commit it to `storage/favorites.json` (yourself, or hand the file to Claude Code) whenever you want your picks to persist for other visitors/devices.

`favorite_ids` in both the export and `storage/favorites.json` are `car.id` values from `storage/car_data.json` — no duplicated car data.

## The three phases

### Phase 1 — Model discovery ("what roadsters exist")

**Goal:** build the most extensive possible list of world-known roadster / open-top two-seat sports car models, 2024–2026 model years, buyable by a Portugal-based buyer (any budget).

**How to run it:** iterative web search across categories (mainstream, premium, GT-convertible, exotic/hypercar, EV, Asian-market, boutique/kit-car, ultra-exotic bespoke/coachbuilt). Each round must exclude already-known models and only report genuinely new ones. **Exit condition: 3 consecutive search rounds return zero new models.**

**Known limitation, stated plainly:** the ultra-exotic bespoke/coachbuilt tier (Bugatti, Pagani, Bentley Mulliner, Rolls-Royce Coachbuild, Aspark, Ferrari special series, Hennessey, etc.) is a genuinely open-ended long tail — new sold-out limited editions surface from this tier on a near-weekly cadence in real time, so a literal 3-in-a-row-clean result was not achievable there in this run. Mainstream/premium/GT/mid-exotic tiers did reach clean convergence. This is documented in the addendum section of `phase1-extended-roadster-list.md` rather than glossed over.

**Output:** every model gets an entry in `storage/car_data.json` with: `name`, `manufacturer`, `tier`, `model_variant`, `average_budget_eur`, `average_budget_basis`, `roof_removable` (can the roof be taken off / opened), `roof_automated_process` (is that an automated/powered mechanism or manual), `engine`, `fuel_or_charge_consumption`, `tank_or_battery_size`, `doors`.

### Phase 2 — Real listings ("where to actually buy one")

**Goal:** for each model from Phase 1, find real for-sale listings — Portugal first, then wider Europe if nothing local turns up.

**Rule: skip any car whose `average_budget_eur` exceeds €100,000.** No listing search is performed for those — they're marked `phase2_status: "skipped_price_threshold"` with an empty `selling_items` array. (Exception: a batch of over-€100k listings gathered *before* this rule was introduced was kept rather than discarded — marked `phase2_status: "found_prior_to_threshold_rule"` — see the note at the top of `phase2-portugal-europe-listings.md`.)

**How to run it:** for each in-scope (≤€100k) model, search Portugal classifieds/dealers (Standvirtual, OLX.pt, AutoScout24.pt, Portuguese authorized dealers) first. If nothing found, widen to Europe (AutoScout24 pan-EU, mobile.de, manufacturer certified pre-owned programs, Dyler, JamesEdition, Classic Trader, auction houses). Never fabricate a listing — an explicit "no listing found" is always preferable to an invented one.

**Output:** each in-scope car's `selling_items` array in `storage/car_data.json` is populated with `{link, location, budget}` objects, one per real listing found.

**Exit condition:** goal is considered reached once Phase 1 and Phase 2 are both complete (per their own exit conditions above) — that is the current state of this repo.

### Phase 3 — Purchase decision (not started, out of scope for this run)

Explicitly skipped per instruction. Intended future scope: define the buyer's real (non-open) budget, narrow the shortlist accordingly, contact sellers/dealers for the surviving candidates, arrange viewings/inspections, negotiate, and make the final purchase decision. No files exist for this phase yet.

## Tier assignment rules

`tier` used to be free text, and it drifted badly: 24 distinct strings across 58 cars, many of them compound labels ("premium/exotic"), research-provenance notes bolted onto the value ("exotic (>100k) - NEW find, convergence pass"), or scope flags mixed in ("mainstream (2+2 city convertible, flagged)"). That made grouping/filtering by tier nearly useless. `tier` is now a closed enum (enforced in `docs/car_data.schema.json`) with exactly six values, assigned by **objective rule**, not by feel:

| Tier | Rule |
|---|---|
| `mainstream` | `average_budget_eur` < €40,000 |
| `premium` | €40,000 ≤ `average_budget_eur` < €100,000 |
| `exotic` | €100,000 ≤ `average_budget_eur` < €500,000 |
| `ultra-exotic` | `average_budget_eur` ≥ €500,000, **or** the model is a bespoke/very-limited-run car that sold out before or shortly after reveal (regardless of its exact price) |
| `not yet available` | `average_budget_eur` is `null` — no confirmed production price exists yet. Use this even if rumored/estimated figures exist in `average_budget_basis`; don't tier off a rumor. |
| `unconfirmed` | A model's real-world trims straddle two of the bands above badly enough that one average is misleading (e.g. a base trim is `premium` and a flagship trim is `exotic`) — or the tier genuinely can't be determined confidently for any other reason. **Always prefer `unconfirmed` over inventing a compound label or guessing.** |

Rules for applying this:

1. **Derive, don't hand-pick.** `tier` is a function of `average_budget_eur` (plus the sold-out/bespoke and trim-spread exceptions above) — never assign a tier that contradicts the number.
2. **No compound labels.** Never join two tiers with `/` (e.g. `premium/exotic`). If a car genuinely spans two bands, use `unconfirmed` and explain the spread in `model_variant` (see the KTM X-Bow and Chevrolet Corvette entries in `storage/car_data.json` for the pattern).
3. **No research-provenance notes in `tier`.** Things like "NEW find, convergence pass" describe the research process, not the car — leave them out entirely (they're not needed elsewhere either).
4. **Scope/status flags belong in `model_variant`, not `tier`.** Notes like "2+2 city convertible, flagged" or "also 4-seat, flagged" are about the car's fit for this dataset's scope — append them to `model_variant` as a plain sentence, not as a `tier` suffix.
5. **Re-derive on every price update.** Whenever `average_budget_eur` changes (new listings, corrected estimate), recompute `tier` from the table above — don't let it go stale.

## Data quality notes

- **Pricing/listing data** (`average_budget_eur`, `selling_items`) comes from live web searches performed this session and is traceable to a source URL per entry.
- **Technical spec fields** (`engine`, `fuel_or_charge_consumption`, `tank_or_battery_size`) are populated from established manufacturer specifications and general automotive knowledge rather than individually re-verified per model — treated as good-faith approximations, flagged as such in `storage/car_data.json`'s `metadata.specs_disclaimer`.
- `doors` is 2 for every entry (all roadsters/GT convertibles in scope are 2-door).
- Prices exclude Portuguese ISV registration tax, VAT (where not already embedded in a Portugal-market asking price), and import/customs duty — those are intentionally left as empty `tax`/`import_tax` concepts, to be filled in Phase 3.

## Re-running a phase

- **Phase 1 continuation:** search for new roadster models not already present in `storage/car_data.json` (check by `name`/`manufacturer`). Stop once 3 consecutive rounds add nothing new. Append new entries to the `cars` array.
- **Phase 2 continuation:** for any car with `phase2_status` other than `"completed"` and `average_budget_eur <= 100000`, run the Portugal-first-then-Europe listing search and populate `selling_items`.
- Always update the corresponding `.md` narrative file alongside `storage/car_data.json` so the two stay consistent.
