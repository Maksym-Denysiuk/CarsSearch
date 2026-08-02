#!/usr/bin/env python3
"""Regenerates Requests/index.json from the individual request.json files,
and creates empty results.json/favorites.json stubs for any request that's
missing them -- e.g. one added by hand or via GitHub's web upload, which has
no way to also create the sibling files or update the manifest.

Never overwrites an existing results.json or favorites.json -- only fills in
what's missing, so a request a pipeline has already populated is left
untouched. Requests/index.json itself is always rebuilt wholesale, per its
own schema's description: "DERIVED: never hand-edited, always regenerated
wholesale from the individual request.json files."

Usage:  python tools/sync_requests.py        (from the repo root)
Run tools/verify.py afterward to confirm the result is schema-valid.
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
REQUESTS_DIR = REPO / "Requests"
TODAY = date.today().isoformat()


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def ensure_stub_results(path: Path, request_id: str) -> bool:
    if path.exists():
        return False
    write(
        path,
        {
            "schema_version": 1,
            "request_id": request_id,
            "generated": TODAY,
            "metadata": {
                "currency": "EUR",
                "specs_disclaimer": (
                    "No models researched yet -- this request is pending its first search pass."
                ),
            },
            "models": [],
        },
    )
    return True


def ensure_stub_favorites(path: Path, request_id: str, title: str) -> bool:
    if path.exists():
        return False
    write(
        path,
        {
            "schema_version": 1,
            "request_id": request_id,
            "metadata": {
                "description": (
                    f"User-curated shortlist for '{title}', referencing model ids "
                    "from this request's results.json."
                ),
                "updated": TODAY,
                "note": (
                    "This file is the persisted/committed snapshot. The live viewer "
                    "(docs/index.html) keeps favorites in the browser's localStorage "
                    "as you click, and offers an 'Export favorites.json' button to "
                    "produce an updated version of this file to commit back into the repo."
                ),
            },
            "favorite_ids": [],
        },
    )
    return True


def to_index_row(request: dict) -> dict:
    sf = request["system_fields"]
    results = load(REPO / sf["results_path"])
    models = results["models"]
    return {
        "request_id": request["request_id"],
        "title": request["title"],
        "request_path": f"Requests/{request['request_id']}/request.json",
        "results_path": sf["results_path"],
        "favorites_path": sf["favorites_path"],
        "date_of_request": sf["date_of_request"],
        "status": sf["status"],
        "search_state": {
            "group": sf["search_state"]["group_name"],
            "brand": sf["search_state"]["brand_name"],
            "models_done": len(models),
        },
        "counts": {
            "models": len(models),
            "offerings": sum(len(m["offerings"]) for m in models),
        },
    }


def main() -> int:
    if not REQUESTS_DIR.exists():
        print("Requests/ does not exist -- nothing to sync")
        return 0

    created = []
    rows = []
    for child in sorted(REQUESTS_DIR.iterdir()):
        request_path = child / "request.json"
        if not request_path.exists():
            continue
        request = load(request_path)
        request_id = request["request_id"]
        sf = request["system_fields"]

        if ensure_stub_results(REPO / sf["results_path"], request_id):
            created.append(sf["results_path"])
        if ensure_stub_favorites(REPO / sf["favorites_path"], request_id, request["title"]):
            created.append(sf["favorites_path"])

        rows.append(to_index_row(request))

    write(REQUESTS_DIR / "index.json", {"schema_version": 1, "generated": TODAY, "requests": rows})

    print(f"Requests/index.json regenerated: {len(rows)} request(s)")
    if created:
        print("New stub files created:")
        for p in created:
            print(f"  - {p}")
    else:
        print("No new stub files needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
