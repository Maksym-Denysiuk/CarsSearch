#!/usr/bin/env python3
"""One-shot migration: the legacy 58-roadster dataset -> Requests/req-0001-roadsters/.

Reads the frozen fixture in tools/fixtures/ rather than storage/, so it stays
re-runnable after storage/ is deleted (the fixture is also what the golden test
in tools/verify.py checks against).

What it changes, and why:

  selling_items          -> offerings
  budget "EUR 31900"     -> price_eur 31900 (int) + price_display "EUR 31900"
  location "Portugal"    -> country "PT" (EU/EEA enum) + location (original string)
  roof_automated_process -> roof_mechanism
  image (url|null)       -> photo {url, source_url, source_kind} | null
  phase2_status (12)     -> search_status (5) + search_status_note carrying the original
  doors const 2          -> doors integer (requests are no longer roadster-only)
  (new)                  -> body_type, group/brand ids, tax, import_tax, offering_search_log

Offerings that cannot satisfy the new schema are DROPPED AND COUNTED in
metadata.migration.drop_reasons, never silently reshaped. average_budget_eur and
average_budget_basis are carried over verbatim: they are research outputs of the
legacy run, and recomputing them from a subset of surviving offerings would
misstate what that run actually found.

Usage:  python tools/migrate_legacy.py            (from the repo root)
"""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parent.parent
FIXTURE = REPO / "tools" / "fixtures" / "legacy_car_data.json"
BRANDS = REPO / "Config" / "brands.json"
REQUEST_ID = "req-0001-roadsters"
OUT_DIR = REPO / "Requests" / REQUEST_ID
MIGRATED_AT = "2026-08-02"

# EU/EEA only -- the same allowlist results.schema.json enforces.
EU_EEA = {
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
    "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
}

# Tokens that appear in the legacy free-text `location` strings, mapped to a
# country. Cities are included because a few legacy rows say only "Olivais,
# Lisboa". Non-EU/EEA countries are listed too so they resolve and are then
# dropped with an accurate reason rather than an "unresolvable" one.
LOCATION_TOKENS = [
    ("portugal", "PT"), ("lisboa", "PT"), ("lisbon", "PT"), ("cascais", "PT"),
    ("oeiras", "PT"), ("olivais", "PT"), ("matosinhos", "PT"), ("porto", "PT"),
    ("germany", "DE"), ("frankfurt", "DE"), ("kronberg", "DE"),
    ("italy", "IT"),
    ("belgium", "BE"), ("brussels", "BE"), ("spa-francorchamps", "BE"),
    ("netherlands", "NL"),
    ("france", "FR"),
    ("spain", "ES"), ("valencia", "ES"),
    ("switzerland", "CH"),
    ("japan", "JP"),
]

# 12 legacy phase-2 states -> the 5 states the platform now models. The legacy
# string is preserved verbatim in search_status_note so nothing is lost.
STATUS_MAP = {
    "completed": "completed",
    "found_prior_to_threshold_rule": "completed",
    "partially_completed_stingray_only": "completed_insufficient_sources",
    "completed_out_of_window_reference_only": "completed_insufficient_sources",
    "completed_non_eu_market": "completed_no_offerings",
    "completed_no_listings": "completed_no_offerings",
    "completed_no_resale_market": "completed_no_offerings",
    "not_yet_available": "pending",
    "not_yet_available_no_resale_market": "pending",
    "skipped_price_threshold": "pending",
    "skipped_price_threshold_sold_out": "pending",
    "skipped_price_threshold_and_not_yet_delivered": "pending",
}

STATUS_NOTES = {
    "found_prior_to_threshold_rule": "Legacy phase2_status 'found_prior_to_threshold_rule': listings were gathered before the legacy run's EUR 100k skip rule existed, and kept rather than discarded.",
    "partially_completed_stingray_only": "Legacy phase2_status 'partially_completed_stingray_only': only one trim was searched.",
    "completed_out_of_window_reference_only": "Legacy phase2_status 'completed_out_of_window_reference_only': listings found are outside the model-year window and kept for reference only.",
    "completed_non_eu_market": "Legacy phase2_status 'completed_non_eu_market': the model sells outside the EU/EEA, so its listings are not storable under the EU/EEA rule.",
    "completed_no_listings": "Legacy phase2_status 'completed_no_listings': searched, nothing found.",
    "completed_no_resale_market": "Legacy phase2_status 'completed_no_resale_market': no resale market exists for this model.",
    "not_yet_available": "Legacy phase2_status 'not_yet_available': the model was not on sale when the legacy run happened.",
    "not_yet_available_no_resale_market": "Legacy phase2_status 'not_yet_available_no_resale_market': not on sale and no resale market.",
    "skipped_price_threshold": "Legacy phase2_status 'skipped_price_threshold': deliberately not searched by the legacy run because it exceeded EUR 100k. That rule does not exist in the new platform, so this model is pending a real search.",
    "skipped_price_threshold_sold_out": "Legacy phase2_status 'skipped_price_threshold_sold_out': over EUR 100k and sold out; not searched by the legacy run.",
    "skipped_price_threshold_and_not_yet_delivered": "Legacy phase2_status 'skipped_price_threshold_and_not_yet_delivered': over EUR 100k and undelivered; not searched by the legacy run.",
}


def load_brand_lookup():
    """manufacturer text -> (group_id, group_name, brand_id, brand_name)."""
    data = json.loads(BRANDS.read_text(encoding="utf-8"))
    lookup = {}
    for group in data["groups"]:
        for brand in group["brands"]:
            keys = [brand["name"]] + list(brand["aliases"])
            for key in keys:
                lookup[key.strip().lower()] = (
                    group["group_id"], group["name"], brand["brand_id"], brand["name"],
                )
    return lookup


def match_brand(manufacturer, lookup):
    """Resolve a legacy manufacturer string against the checklist.

    Legacy strings carry parentheticals ('MG (SAIC)', 'Bentley (Mulliner)'), so
    try the whole string, then the part before the parenthesis, then the part
    inside it. Anything still unmatched is an off-checklist marque (Bugatti,
    Wiesmann, Caterham...) and gets nulls -- an honest 'not on the list'.
    """
    candidates = [manufacturer]
    outside = re.sub(r"\(.*?\)", "", manufacturer).strip()
    if outside and outside != manufacturer:
        candidates.append(outside)
    inside = re.findall(r"\((.*?)\)", manufacturer)
    candidates.extend(i.strip() for i in inside)
    for cand in candidates:
        hit = lookup.get(cand.lower())
        if hit:
            return hit
    return (None, None, None, None)


def resolve_country(location):
    """First country token named in the string wins.

    'Germany, Italy' -> DE and 'France, Belgium, Netherlands, Germany' -> FR:
    the legacy row lists several markets, and the first is the one the price
    was quoted in. Returns None when nothing resolves (e.g. 'Pan-EU (aggregate)').
    """
    low = location.lower()
    best, best_idx = None, len(low) + 1
    for token, code in LOCATION_TOKENS:
        idx = low.find(token)
        if idx != -1 and idx < best_idx:
            best, best_idx = code, idx
    return best


def domain_of(url):
    host = urlsplit(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def convert_offering(item, drops):
    """Legacy selling_item -> new offering, or None (with a counted reason).

    Checks run url -> country -> price so that a listing outside the EU/EEA is
    attributed to the geographic rule (the meaningful one) rather than to the
    foreign currency it happens to be quoted in.
    """
    link = item["link"].strip()
    if not link.lower().startswith(("http://", "https://")):
        drops["url_not_a_url"] += 1
        return None

    country = resolve_country(item["location"])
    if country is None:
        drops["country_unresolvable"] += 1
        return None
    if country not in EU_EEA:
        drops["country_not_eu_eea"] += 1
        return None

    budget = item["budget"].strip()
    # "EUR 44900-53490" is a price RANGE the legacy run read off an aggregate
    # search page -- a summary of several cars, not one listing. There is no
    # single price that is substring-present on a page for it, so it cannot
    # become an offering. Picking the low end would invent a price.
    if re.search(r"\d\s*[-–]\s*\d", budget):
        drops["price_is_range_not_a_listing"] += 1
        return None

    m = re.fullmatch(r"([A-Z]{3})\s*([\d\s,.]+)", budget)
    if not m:
        drops["price_unparseable"] += 1
        return None
    currency, amount = m.group(1), re.sub(r"[^\d]", "", m.group(2))
    if currency != "EUR":
        drops["price_not_eur"] += 1
        return None
    if not amount:
        drops["price_unparseable"] += 1
        return None

    return {
        "url": link,
        "source_domain": domain_of(link),
        "country": country,
        "location": item["location"],
        "price_eur": int(amount),
        "price_display": item["budget"].strip(),
        "found_in_round": None,
        "captured_at": None,
    }


def tbd_tax():
    return {"status": "tbd", "value_eur": None, "basis": ""}


def main():
    legacy = json.loads(FIXTURE.read_text(encoding="utf-8"))
    lookup = load_brand_lookup()
    drops = Counter()
    models, kept = [], 0

    for car in legacy["cars"]:
        group_id, group_name, brand_id, brand_name = match_brand(car["manufacturer"], lookup)

        offerings = []
        for item in car["selling_items"]:
            converted = convert_offering(item, drops)
            if converted is not None:
                offerings.append(converted)
        kept += len(offerings)

        legacy_status = car["phase2_status"]
        search_status = STATUS_MAP[legacy_status]
        note = STATUS_NOTES.get(legacy_status)
        # A model whose legacy status claimed a finished search but whose
        # offerings did not survive the new rules must not keep claiming it.
        if search_status in ("completed", "completed_insufficient_sources") and not offerings:
            search_status = "completed_no_offerings"
            note = ((note + " ") if note else "") + \
                "All of its legacy listings were dropped by the new EU/EEA + parseable-price rules."

        photo = None
        if car.get("image"):
            photo = {
                "url": car["image"],
                # The legacy schema said the image came from an og:image on one
                # of the listing pages, but not WHICH one -- so provenance is
                # recorded as unknown rather than guessed at.
                "source_url": None,
                "source_kind": "legacy-unknown",
            }

        models.append({
            "id": car["id"],
            "name": car["name"],
            "manufacturer": car["manufacturer"],
            "group_id": group_id,
            "group_name": group_name,
            "brand_id": brand_id,
            "brand_name": brand_name,
            "body_type": "roadster",
            "tier": car["tier"],
            "model_variant": car["model_variant"],
            "first_year": None,
            "average_budget_eur": car["average_budget_eur"],
            "average_budget_basis": car["average_budget_basis"],
            "roof_removable": car["roof_removable"],
            "roof_mechanism": car["roof_automated_process"],
            "engine": car["engine"],
            "fuel_or_charge_consumption": car["fuel_or_charge_consumption"],
            "tank_or_battery_size": car["tank_or_battery_size"],
            "doors": car["doors"],
            "tax": tbd_tax(),
            "import_tax": tbd_tax(),
            "photo": photo,
            "search_status": search_status,
            "search_status_note": note,
            "offerings": offerings,
            "offering_search_log": [],
        })

    total_legacy_offerings = sum(len(c["selling_items"]) for c in legacy["cars"])
    results = {
        "schema_version": 1,
        "request_id": REQUEST_ID,
        "generated": MIGRATED_AT,
        "metadata": {
            "currency": "EUR",
            "specs_disclaimer": legacy["metadata"]["specs_disclaimer"],
            "notes": [
                legacy["metadata"]["scope"],
                "Migrated from the legacy single-dataset repo layout (storage/car_data.json). "
                "Prices, listing URLs and averages are the legacy run's own findings, not re-verified here.",
                "average_budget_eur / average_budget_basis are carried over verbatim: they describe what the "
                "legacy run found, so they are not recomputed from the subset of offerings that survived the "
                "new EU/EEA and parseable-price rules.",
            ],
            "migration": {
                "source": "storage/car_data.json @ 74836d4 (frozen at tools/fixtures/legacy_car_data.json)",
                "migrated_at": MIGRATED_AT,
                "models": len(models),
                "offerings_kept": kept,
                "offerings_dropped": total_legacy_offerings - kept,
                "drop_reasons": dict(sorted(drops.items())),
            },
        },
        "models": models,
    }

    # --- progress checklist -------------------------------------------------
    # This request predates Config/brands.json, so its checklist covers only the
    # brands the legacy run actually produced models for. That is the honest
    # record of what was searched; the pipeline's run-start reconciliation will
    # insert every other checklist brand as `pending` and reopen the request,
    # which is the documented behaviour rather than a surprise.
    brand_models = Counter(m["brand_id"] for m in models if m["brand_id"])
    brands_meta = {}
    for m in models:
        if m["brand_id"]:
            brands_meta[m["brand_id"]] = (m["group_id"], m["group_name"], m["brand_name"])

    groups_by_id = {}
    for brand_id, (gid, gname, bname) in brands_meta.items():
        g = groups_by_id.setdefault(gid, {
            "group_id": gid, "group_name": gname, "status": "done", "brands": [],
        })
        g["brands"].append({
            "brand_id": brand_id,
            "brand_name": bname,
            "status": "done",
            "models_found": brand_models[brand_id],
            "completed_at": MIGRATED_AT + "T00:00:00Z",
        })
    groups = []
    for gid in sorted(groups_by_id):
        g = groups_by_id[gid]
        g["brands"].sort(key=lambda b: b["brand_id"])
        groups.append(g)

    brands_total = sum(len(g["brands"]) for g in groups)
    request = {
        "schema_version": 1,
        "request_id": REQUEST_ID,
        "title": "Roadsters — Portugal, 2024+",
        "user_fields": {
            "body_type": "roadster",
            "not_older_than": 2024,
            "special_filter": "Open-top two-seat sports cars; Portugal first, then wider Europe.",
        },
        "system_fields": {
            "date_of_request": MIGRATED_AT,
            "status": "done",
            "search_state": {
                "group_id": None, "group_name": None, "brand_id": None, "brand_name": None,
            },
            "progress": {
                "groups_total": len(groups),
                "groups_done": len(groups),
                "brands_total": brands_total,
                "brands_done": brands_total,
                "brands_failed": 0,
                "models_found": sum(brand_models.values()),
                "groups": groups,
            },
            "results_path": f"Requests/{REQUEST_ID}/results.json",
            "favorites_path": f"Requests/{REQUEST_ID}/favorites.json",
        },
    }

    legacy_favs = json.loads((REPO / "tools" / "fixtures" / "legacy_favorites.json").read_text(encoding="utf-8"))
    favorites = {
        "schema_version": 1,
        "request_id": REQUEST_ID,
        "metadata": {
            "description": "User-curated shortlist for the roadster request, referencing model ids from this request's results.json.",
            "updated": MIGRATED_AT,
            "note": legacy_favs["metadata"].get("note", ""),
        },
        "favorite_ids": legacy_favs.get("favorite_ids", []),
    }

    index = {
        "schema_version": 1,
        "generated": MIGRATED_AT,
        "requests": [{
            "request_id": REQUEST_ID,
            "title": request["title"],
            "request_path": f"Requests/{REQUEST_ID}/request.json",
            "results_path": f"Requests/{REQUEST_ID}/results.json",
            "favorites_path": f"Requests/{REQUEST_ID}/favorites.json",
            "date_of_request": MIGRATED_AT,
            "status": "done",
            "search_state": {"group": None, "brand": None, "models_done": len(models)},
            "counts": {"models": len(models), "offerings": kept},
        }],
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write(OUT_DIR / "results.json", results)
    write(OUT_DIR / "request.json", request)
    write(OUT_DIR / "favorites.json", favorites)
    write(REPO / "Requests" / "index.json", index)

    off_checklist = sorted({m["manufacturer"] for m in models if not m["brand_id"]})
    print(f"models:            {len(models)}")
    print(f"offerings kept:    {kept} of {total_legacy_offerings}")
    print(f"offerings dropped: {total_legacy_offerings - kept} {dict(sorted(drops.items()))}")
    print(f"checklist brands:  {brands_total} in {len(groups)} groups "
          f"({sum(brand_models.values())} models)")
    print(f"off-checklist marques ({len(off_checklist)}): {', '.join(off_checklist)}")


def write(path, doc):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
