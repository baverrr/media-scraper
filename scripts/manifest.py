#!/usr/bin/env python3
"""Add the version in build.yaml to a Jellyfin plugin repository manifest.json.

Usage: scripts/manifest.py <build.yaml> <manifest.json> <plugin.zip> <source-url>

Used by scripts/publish-repo.sh (local repository) and by CI (GitHub Pages repository).
build.yaml only uses "key: value" and folded "key: >" blocks, so it's parsed without PyYAML.
"""
import datetime
import hashlib
import json
import os
import re
import sys

build_yaml, manifest_path, zip_path, source_url = sys.argv[1:5]

meta, key = {}, None
for line in open(build_yaml, encoding="utf-8"):
    m = re.match(r'^([A-Za-z]+):\s*(.*)$', line.rstrip("\n"))
    if m:
        key, value = m.groups()
        meta[key] = "" if value == ">" else value.strip('"')
    elif key and line.startswith("  ") and not line.lstrip().startswith("- "):
        meta[key] = (meta[key] + " " + line.strip()).strip()

manifest = json.load(open(manifest_path, encoding="utf-8")) if os.path.exists(manifest_path) else []
entry = next((p for p in manifest if p["guid"] == meta["guid"]), None)
if entry is None:
    entry = {"versions": []}
    manifest.append(entry)

entry.update({
    "guid": meta["guid"],
    "name": meta["name"],
    "overview": meta["overview"],
    "description": meta["description"],
    "owner": meta["owner"],
    "category": meta["category"],
})
entry["versions"] = [v for v in entry["versions"] if v["version"] != meta["version"]]
entry["versions"].insert(0, {
    "version": meta["version"],
    "changelog": meta["changelog"],
    "targetAbi": meta["targetAbi"],
    "sourceUrl": source_url,
    "checksum": hashlib.md5(open(zip_path, "rb").read()).hexdigest(),
    "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
})

os.makedirs(os.path.dirname(os.path.abspath(manifest_path)), exist_ok=True)
tmp = manifest_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
os.replace(tmp, manifest_path)
print(f"Published {meta['name']} {meta['version']} -> {source_url}")
