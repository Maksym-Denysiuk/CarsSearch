#!/usr/bin/env python3
"""Verifies every JSON artifact in the repo against its schema, plus the
cross-file invariants the platform depends on and the migration golden test.

This is the mechanical guard behind `additionalProperties: false` — a typo in a
field name fails here rather than silently rendering as a blank column.

Usage:  python tools/verify.py            (from the repo root)
Exit code 0 = all checks pass; 1 = at least one failure (all are reported).
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from jsonschema import Draft202012Validator

REPO = Path(__file__).resolve().parent.parent
DOCS = REPO / "docs"

failures: list[str] = []
checks = 0


def check(condition, message):
    global checks
    checks += 1
    if not condition:
        failures.append(message)
    return bool(condition)


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def validate(instance, schema_name, label):
    schema = load(DOCS / schema_name)
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
    for err in errors[:10]:
        location = "/".join(str(p) for p in err.absolute_path) or "(root)"
        failures.append(f"{label}: {location}: {err.message}")
    global checks
    checks += 1
    return not errors


def main():
    # 1. Every schema is itself a well-formed 2020-12 schema.
    schema_files = sorted(DOCS.glob("*.schema.json"))
    check(schema_files, "docs/: no *.schema.json files found")
    for path in schema_files:
        try:
            Draft202012Validator.check_schema(load(path))
            checks_ok = True
        except Exception as exc:  # noqa: BLE001 - report, don't abort the run
            checks_ok = False
            failures.append(f"{path.name}: not a valid schema: {exc}")
        check(checks_ok, f"{path.name}: schema self-check failed")

    # 2. The body_type enum is duplicated across two schema files (JSON Schema
    #    cannot $ref across files without a resolver). Assert they cannot drift.
    req_enum = load(DOCS / "request.schema.json")["$defs"]["body_type"]["enum"]
    res_enum = load(DOCS / "results.schema.json")["$defs"]["body_type"]["enum"]
    check(req_enum == res_enum,
          f"body_type enum drift: request.schema.json {req_enum} != results.schema.json {res_enum}")

    # 2b. The body-type chart IS the enum's documentation, so a shape without an
    #     enum value (or an enum value without a shape) is a real defect.
    svg_path = DOCS / "assets" / "body-types.svg"
    if check(svg_path.exists(), "docs/assets/body-types.svg is missing"):
        svg = svg_path.read_text(encoding="utf-8")
        try:
            ET.fromstring(svg)  # must stay valid XML: it is served as image/svg+xml
            parsed = True
        except ET.ParseError as exc:
            parsed = False
            failures.append(f"body-types.svg: not valid XML: {exc}")
        check(parsed, "body-types.svg: XML parse failed")
        shapes = set(re.findall(r'data-body-type="([^"]+)"', svg))
        missing_shapes = set(req_enum) - shapes
        extra_shapes = shapes - set(req_enum)
        check(not missing_shapes, f"body-types.svg: no shape for body types {sorted(missing_shapes)}")
        check(not extra_shapes, f"body-types.svg: shapes with no matching enum value {sorted(extra_shapes)}")

    # 3. The brand checklist.
    brands = load(REPO / "Config" / "brands.json")
    validate(brands, "brands.schema.json", "Config/brands.json")
    brand_ids = [b["brand_id"] for g in brands["groups"] for b in g["brands"]]
    group_ids = [g["group_id"] for g in brands["groups"]]
    check(len(brand_ids) == len(set(brand_ids)), "Config/brands.json: duplicate brand_id")
    check(len(group_ids) == len(set(group_ids)), "Config/brands.json: duplicate group_id")
    known_brands = set(brand_ids)
    known_groups = {g["group_id"]: g for g in brands["groups"]}

    # 4. The requests manifest, and every request it points at.
    index = load(REPO / "Requests" / "index.json")
    validate(index, "requests_index.schema.json", "Requests/index.json")

    seen_request_ids = set()
    for row in index["requests"]:
        rid = row["request_id"]
        check(rid not in seen_request_ids, f"Requests/index.json: duplicate request_id {rid}")
        seen_request_ids.add(rid)

        request_path = REPO / row["request_path"]
        results_path = REPO / row["results_path"]
        favorites_path = REPO / row["favorites_path"]
        for p in (request_path, results_path, favorites_path):
            if not check(p.exists(), f"{rid}: missing file {p.relative_to(REPO)}"):
                break
        else:
            request = load(request_path)
            results = load(results_path)
            favorites = load(favorites_path)
            validate(request, "request.schema.json", f"{rid}/request.json")
            validate(results, "results.schema.json", f"{rid}/results.json")
            validate(favorites, "favorites.schema.json", f"{rid}/favorites.json")

            # ids agree across all four files
            check(request["request_id"] == rid, f"{rid}: request.json request_id mismatch")
            check(results["request_id"] == rid, f"{rid}: results.json request_id mismatch")
            check(favorites["request_id"] == rid, f"{rid}: favorites.json request_id mismatch")

            sf = request["system_fields"]
            check(sf["results_path"] == row["results_path"],
                  f"{rid}: results_path disagrees between request.json and index.json")
            check(sf["favorites_path"] == row["favorites_path"],
                  f"{rid}: favorites_path disagrees between request.json and index.json")

            # index.json is a derived mirror — its row must match the source of truth
            check(row["status"] == sf["status"],
                  f"{rid}: index status {row['status']!r} != request.json status {sf['status']!r}")
            check(row["search_state"]["group"] == sf["search_state"]["group_name"],
                  f"{rid}: index search_state.group is stale")
            check(row["search_state"]["brand"] == sf["search_state"]["brand_name"],
                  f"{rid}: index search_state.brand is stale")
            check(row["counts"]["models"] == len(results["models"]),
                  f"{rid}: index counts.models {row['counts']['models']} != {len(results['models'])} models")
            offerings_total = sum(len(m["offerings"]) for m in results["models"])
            check(row["counts"]["offerings"] == offerings_total,
                  f"{rid}: index counts.offerings {row['counts']['offerings']} != {offerings_total}")

            # model ids unique; favorites reference real models
            model_ids = [m["id"] for m in results["models"]]
            check(len(model_ids) == len(set(model_ids)), f"{rid}: duplicate model id in results.json")
            unknown_favs = set(favorites["favorite_ids"]) - set(model_ids)
            check(not unknown_favs, f"{rid}: favorites reference unknown model ids {sorted(unknown_favs)}")

            # every brand/group a model claims must exist on the checklist
            for m in results["models"]:
                if m["brand_id"] is not None:
                    check(m["brand_id"] in known_brands,
                          f"{rid}/{m['id']}: brand_id {m['brand_id']!r} is not in Config/brands.json")
                if m["group_id"] is not None:
                    check(m["group_id"] in known_groups,
                          f"{rid}/{m['id']}: group_id {m['group_id']!r} is not in Config/brands.json")
                # a brand_id without a group_id (or vice versa) is a half-resolved row
                check((m["brand_id"] is None) == (m["group_id"] is None),
                      f"{rid}/{m['id']}: brand_id and group_id must both be set or both be null")

            # progress counters must agree with the checklist they mirror
            progress = sf["progress"]
            groups = progress["groups"]
            check(progress["groups_total"] == len(groups),
                  f"{rid}: progress.groups_total != number of group entries")
            brands_listed = sum(len(g["brands"]) for g in groups)
            check(progress["brands_total"] == brands_listed,
                  f"{rid}: progress.brands_total != number of brand entries")
            check(progress["brands_done"] == sum(
                      1 for g in groups for b in g["brands"] if b["status"] == "done"),
                  f"{rid}: progress.brands_done is stale")
            check(progress["brands_failed"] == sum(
                      1 for g in groups for b in g["brands"] if b["status"] == "failed"),
                  f"{rid}: progress.brands_failed is stale")
            check(progress["models_found"] == sum(
                      b["models_found"] for g in groups for b in g["brands"]),
                  f"{rid}: progress.models_found != sum of per-brand models_found")
            for g in groups:
                check(g["group_id"] in known_groups,
                      f"{rid}: progress group {g['group_id']!r} is not in Config/brands.json")
                allowed = {b["brand_id"] for b in known_groups.get(g["group_id"], {"brands": []})["brands"]}
                for b in g["brands"]:
                    check(b["brand_id"] in allowed,
                          f"{rid}: progress brand {b['brand_id']!r} is not in group {g['group_id']}")
                terminal = all(b["status"] in ("done", "failed") for b in g["brands"])
                if g["status"] == "done":
                    check(terminal, f"{rid}: group {g['group_id']} is 'done' with non-terminal brands")
            if sf["status"] == "done":
                check(all(g["status"] == "done" for g in groups),
                      f"{rid}: request is 'done' with non-done groups")

    # 5. Migration golden test — the legacy dataset must survive intact.
    golden(seen_request_ids)

    print(f"{checks} checks run")
    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all checks passed")
    return 0


def golden(seen_request_ids):
    """req-0001-roadsters must still be the legacy 58-car dataset.

    Guards the migration against silent loss: every legacy model present, the
    MX-5 average unchanged, every surviving offering traceable to a legacy row,
    and the kept/dropped accounting adding back up to the original total.
    """
    fixture_path = REPO / "tools" / "fixtures" / "legacy_car_data.json"
    results_path = REPO / "Requests" / "req-0001-roadsters" / "results.json"
    if not check(fixture_path.exists(), "golden: tools/fixtures/legacy_car_data.json is missing"):
        return
    if not check("req-0001-roadsters" in seen_request_ids,
                 "golden: req-0001-roadsters is not listed in Requests/index.json"):
        return

    legacy = load(fixture_path)
    results = load(results_path)
    legacy_cars = {c["id"]: c for c in legacy["cars"]}
    models = {m["id"]: m for m in results["models"]}

    check(len(models) == 58, f"golden: expected 58 models, got {len(models)}")
    missing = set(legacy_cars) - set(models)
    check(not missing, f"golden: models lost in migration: {sorted(missing)}")
    invented = set(models) - set(legacy_cars)
    check(not invented, f"golden: models that were not in the legacy dataset: {sorted(invented)}")

    mx5 = models.get("mazda-mx5")
    if check(mx5 is not None, "golden: mazda-mx5 is missing"):
        check(mx5["average_budget_eur"] == 33350,
              f"golden: MX-5 average_budget_eur is {mx5['average_budget_eur']}, expected 33350")
        check(len(mx5["offerings"]) == 4,
              f"golden: MX-5 has {len(mx5['offerings'])} offerings, expected 4")

    # No offering may exist that the legacy dataset did not contain.
    legacy_urls = {i["link"].strip() for c in legacy["cars"] for i in c["selling_items"]}
    kept = 0
    for m in results["models"]:
        for o in m["offerings"]:
            kept += 1
            check(o["url"] in legacy_urls,
                  f"golden: {m['id']} offering url not present in the legacy dataset: {o['url']}")
            check(str(o["price_eur"]) in o["price_display"].replace(",", "").replace(" ", ""),
                  f"golden: {m['id']} price_eur {o['price_eur']} is not present in price_display "
                  f"{o['price_display']!r}")

    # Kept + dropped must reconstruct the original count exactly.
    legacy_total = sum(len(c["selling_items"]) for c in legacy["cars"])
    migration = results["metadata"].get("migration")
    if check(migration is not None, "golden: results.json metadata.migration block is missing"):
        check(migration["offerings_kept"] == kept,
              f"golden: metadata says {migration['offerings_kept']} kept, file contains {kept}")
        check(migration["offerings_kept"] + migration["offerings_dropped"] == legacy_total,
              f"golden: kept {migration['offerings_kept']} + dropped {migration['offerings_dropped']} "
              f"!= {legacy_total} legacy offerings")
        check(sum(migration["drop_reasons"].values()) == migration["offerings_dropped"],
              "golden: drop_reasons do not sum to offerings_dropped")
        check(migration["models"] == len(models), "golden: metadata.migration.models is stale")


if __name__ == "__main__":
    sys.exit(main())
