#!/usr/bin/env python3
"""Builds the small reference files the app searches, from Rebrickable's CSV downloads.

Usage:  python3 tools/build-data.py <folder with the Rebrickable .csv files> [output folder]

Reads parts.csv, colors.csv and part_categories.csv and writes data/parts.json,
data/colors.json and data/categories.json. Re-run it whenever you download a fresh catalogue.
Catalogue data from Rebrickable (https://rebrickable.com/downloads/).
"""
import csv
import json
import os
import re
import sys
from datetime import date


def natural_key(text):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", text)]


def read(folder, name):
    with open(os.path.join(folder, name), newline="", encoding="utf-8") as f:
        yield from csv.DictReader(f)


def dump(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{os.path.basename(path)}: {os.path.getsize(path) / 1024:.0f} KB")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "data")
    os.makedirs(out, exist_ok=True)

    parts = [[r["part_num"], r["name"], int(r["part_cat_id"])] for r in read(src, "parts.csv")]
    parts.sort(key=lambda p: natural_key(p[0]))
    dump(parts, os.path.join(out, "parts.json"))

    colors = [[int(r["id"]), r["name"], r["rgb"], 1 if r["is_trans"] == "True" else 0, int(r.get("num_parts") or 0)] for r in read(src, "colors.csv")]
    dump(colors, os.path.join(out, "colors.json"))

    cats = {r["id"]: r["name"] for r in read(src, "part_categories.csv")}
    dump(cats, os.path.join(out, "categories.json"))

    dump({"built": date.today().isoformat(), "parts": len(parts), "colors": len(colors), "categories": len(cats),
          "source": "https://rebrickable.com/downloads/"}, os.path.join(out, "meta.json"))


if __name__ == "__main__":
    main()
