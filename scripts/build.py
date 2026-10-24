#!/usr/bin/env python3
"""Build the static POISK Explorer from a checksum-pinned CSV (stdlib only)."""

from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import html
from http.client import IncompleteRead
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import build_opener, HTTPRedirectHandler, Request
import uuid


ROOT = Path(__file__).resolve().parents[1]
SEARCH_FIELDS = [
    "unique_record_id",
    "patent_id",
    "antibody_identifier",
    "antibody_type",
    "antibody_discovery_status",
    "discovery_methodology.source_organism",
    "discovery_methodology.specific_platform",
    "target.organism",
    "target.target_type",
    "target.protein_name",
    "target.gene_names",
    "target.uniprot_id",
    "target.binding_affinity.affinity_value",
    "target.binding_affinity.method",
    "epitope.type",
    "audit.verdict",
]
FLAG_FIELDS = ["has_epitope", "has_affinity", "has_vh", "has_vl"]
FACET_FIELDS = [
    "antibody_type",
    "antibody_discovery_status",
    "target.target_type",
    "target.organism",
    "target.binding_affinity.method",
    "discovery_methodology.source_organism",
    "discovery_methodology.specific_platform",
    "epitope.type",
    "audit.verdict",
]
SEQUENCE_FIELDS = ["vh.sequence_from_patent", "vl.sequence_from_patent"]
SEQUENCE_ALGORITHM = "fnv1a64"
# The 20 standard amino acids. A chain containing anything else (X, B, Z, U, O) is still shipped
# verbatim, but strict numbering and alignment tools reject it, so the count is published.
STANDARD_RESIDUES = frozenset("ACDEFGHIKLMNPQRSTVWY")
# web/app.js links a record to Google Patents only for a bare US grant number, because that is
# the only shape release 1.1 contains (measured: 93,193 of 93,193 patent_id cells, 10,010 distinct
# values). A release that adds EP/WO numbers would silently lose its evidence links, so the build
# says so rather than leaving it to be noticed in the browser.
LINKABLE_PATENT = re.compile(r"\d{7,8}")
# Shorter strings are not meaningful chain sequences, so they are not worth a lookup key.
MINIMUM_SEQUENCE_LENGTH = 20
REPRESENTATIONS = ("both", "gzip", "plain")
MISSING_VALUES = {
    "", "null", "none", "nan", "n/a", "na", "n.a.", "not applicable",
    "not specified", "not reported", "not available", "not determined",
    "not provided", "not disclosed", "unknown", "unavailable", "unspecified",
    "not found", "none found", "—", ".", "[]", "{}",
}
# Sorted because set iteration order varies with PYTHONHASHSEED; the manifest must be reproducible.
PLACEHOLDER_TOKENS = sorted(MISSING_VALUES)


class BuildError(ValueError):
    """A malformed configuration or dataset; reported without a traceback by CLI."""


def validate_https(value: str, label: str, *, optional: bool = False) -> None:
    if optional and value == "":
        return
    if not isinstance(value, str):
        raise BuildError(f"{label} must be an HTTPS URL.")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise BuildError(f"{label} must be an HTTPS URL without embedded credentials.")


def checksum_parts(value: str) -> tuple[str, str]:
    if not isinstance(value, str):
        raise BuildError("source.checksum must be md5:<hex> or sha256:<hex>.")
    algorithm, separator, digest = value.lower().partition(":")
    length = {"md5": 32, "sha256": 64}.get(algorithm)
    if not separator or length is None or not re.fullmatch(rf"[0-9a-f]{{{length}}}", digest):
        raise BuildError("source.checksum must be md5:<hex> or sha256:<hex>.")
    return algorithm, digest


def load_config(path: Path) -> dict:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BuildError(f"Cannot read configuration {path}: {exc}") from exc
    if not isinstance(config, dict) or config.get("schemaVersion") != 1:
        raise BuildError("Configuration schemaVersion must be 1.")
    source = config.get("source")
    if not isinstance(source, dict):
        raise BuildError("Configuration requires a source object.")
    validate_https(source.get("url"), "source.url")
    checksum_parts(source.get("checksum"))
    dataset = config.get("dataset")
    keys = ("title", "version", "doi", "recordUrl", "downloadUrl", "citation")
    if not isinstance(dataset, dict) or any(not isinstance(dataset.get(key), str) for key in keys):
        raise BuildError("dataset must supply string title, version, doi, recordUrl, downloadUrl, citation.")
    if not dataset["title"].strip() or not dataset["version"].strip():
        raise BuildError("dataset.title and dataset.version must not be empty.")
    for key in ("recordUrl", "downloadUrl"):
        validate_https(dataset[key], f"dataset.{key}", optional=True)
    if "license" not in dataset or (dataset["license"] is not None and not isinstance(dataset["license"], str)):
        raise BuildError("dataset.license must be a string or null when unreported.")
    size = config.get("chunkSize", 400)
    if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 5000:
        raise BuildError("chunkSize must be an integer between 1 and 5000.")
    config["chunkSize"] = size
    return config


def verify_checksum(path: Path, expected: str) -> str:
    algorithm, wanted = checksum_parts(expected)
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    actual = digest.hexdigest()
    if actual != wanted:
        raise BuildError(f"Checksum mismatch for {path}: expected {algorithm}:{wanted}, got {algorithm}:{actual}.")
    return f"{algorithm}:{actual}"


class HTTPSOnlyRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_https(newurl, "Download redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_source(config: dict, cache_dir: Path) -> tuple[Path, str]:
    """Return the cached CSV and its verified digest, so the caller never rehashes it."""
    source = config["source"]
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha256((source["url"] + "\n" + source["checksum"]).encode()).hexdigest()[:24]
    destination = cache_dir / f"poisk-{cache_key}.csv"
    if destination.is_file():
        try:
            return destination, verify_checksum(destination, source["checksum"])
        except BuildError as exc:
            # A truncated cache entry would otherwise fail every later build; drop it and refetch.
            print(f"Discarding unusable cache entry: {exc}", file=sys.stderr)
            destination.unlink(missing_ok=True)
    descriptor, name = tempfile.mkstemp(prefix="download-", suffix=".csv", dir=cache_dir)
    import os
    os.close(descriptor)
    temporary = Path(name)
    try:
        request = Request(source["url"], headers={"User-Agent": "POISK-Explorer/1.0"})
        with build_opener(HTTPSOnlyRedirect()).open(request, timeout=120) as response:
            validate_https(response.geturl(), "Download response URL")
            with temporary.open("wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
        digest = verify_checksum(temporary, source["checksum"])
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination, digest


def meaningful(value: str) -> bool:
    """Presence flags only; the source text itself is never normalized."""
    normalized = re.sub(r"[\s_-]+", " ", value.strip().casefold()).strip()
    return normalized not in MISSING_VALUES


def canonical_sequence(value: str) -> str:
    """The browser must produce the same key, so canonicalisation stays this one expression."""
    return re.sub(r"[^A-Z]", "", value.upper())


def fnv1a64(text: str) -> str:
    h = 0xcbf29ce484222325
    for b in text.encode("ascii"):
        h = ((h ^ b) * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def write_json_pair(path: Path, value: object, representations: str = "both") -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    if representations != "gzip":
        path.write_bytes(payload)
    if representations == "plain":
        return
    # An empty filename and zero timestamp make gzip reproducible across machines.
    with path.with_suffix(path.suffix + ".gz").open("wb") as handle:
        with gzip.GzipFile(filename="", mode="wb", fileobj=handle, mtime=0, compresslevel=6) as compressed:
            compressed.write(payload)


def asset_links(url: str, representations: str, keys: tuple[str, str] = ("url", "gzipUrl")) -> dict:
    """Advertise only what was published, so the client never requests a missing file."""
    links = {}
    if representations != "gzip":
        links[keys[0]] = url
    if representations != "plain":
        links[keys[1]] = f"{url}.gz"
    return links


def generate_data(source: Path, staging: Path, config: dict, checksum: str, representations: str = "both") -> dict:
    csv.field_size_limit(20 * 1024 * 1024)
    index_rows = []
    chunk = []
    chunk_size = config["chunkSize"]
    # A cached manifest must never load details from a different dataset release.
    # Include chunk size because it changes the mapping from row index to file.
    asset_prefix = f"data/{checksum.replace(':', '-')}-c{chunk_size}"
    asset_root = staging / asset_prefix
    ids = set()
    patents = set()
    facets = {field: Counter() for field in FACET_FIELDS}
    sequence_rows: dict[str, list[int]] = {}
    sequence_text: dict[str, str] = {}
    record_count = 0
    chain_cells = 0
    non_standard_cells = 0
    unlinkable_patents: set[str] = set()
    try:
        with source.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            fields = next(reader, None)
            if not fields:
                raise BuildError("CSV is empty or has no header.")
            if len(fields) != len(set(fields)) or any(not field.strip() for field in fields):
                raise BuildError("CSV header contains duplicate or empty column names.")
            # Facet columns are required too: a missing one used to escape main() as a bare KeyError.
            required = list(dict.fromkeys(SEARCH_FIELDS + SEQUENCE_FIELDS + FACET_FIELDS))
            missing = [field for field in required if field not in fields]
            if missing:
                raise BuildError("Missing required CSV columns: " + ", ".join(missing))
            positions = {field: position for position, field in enumerate(fields)}
            search_positions = [positions[field] for field in SEARCH_FIELDS]
            epitope_positions = [i for i, field in enumerate(fields) if field.startswith("epitope.")]
            sequence_positions = [positions[field] for field in SEQUENCE_FIELDS]
            for row in reader:
                if len(row) != len(fields):
                    raise BuildError(f"CSV row ending at line {reader.line_num} has {len(row)} values; expected {len(fields)}.")
                record_id = row[positions["unique_record_id"]]
                if not record_id.strip():
                    raise BuildError(f"Empty unique_record_id at CSV line {reader.line_num}.")
                if record_id in ids:
                    raise BuildError(f"Duplicate unique_record_id {record_id!r} at CSV line {reader.line_num}.")
                ids.add(record_id)
                patent = row[positions["patent_id"]]
                if meaningful(patent):
                    patents.add(patent)
                    if not LINKABLE_PATENT.fullmatch(patent):
                        unlinkable_patents.add(patent)
                flags = [
                    any(meaningful(row[i]) for i in epitope_positions),
                    meaningful(row[positions["target.binding_affinity.affinity_value"]]),
                ] + [meaningful(row[position]) for position in sequence_positions]
                index_rows.append([row[position] for position in search_positions] + flags)
                record_index = len(index_rows) - 1
                for position in sequence_positions:
                    canonical = canonical_sequence(row[position])
                    if canonical and meaningful(row[position]):
                        chain_cells += 1
                        # The explorer warns FASTA users about these, so the count must come from
                        # the release rather than being written into the page by hand.
                        if set(canonical) - STANDARD_RESIDUES:
                            non_standard_cells += 1
                    if len(canonical) < MINIMUM_SEQUENCE_LENGTH:
                        continue
                    key = fnv1a64(canonical)
                    known = sequence_text.setdefault(key, canonical)
                    if known != canonical:
                        raise BuildError(f"Sequence key collision on {key} at CSV line {reader.line_num}: "
                                         f"{known[:24]}... and {canonical[:24]}...")
                    rows_for_key = sequence_rows.setdefault(key, [])
                    # Rows arrive in ascending order, so one comparison keeps the list sorted and unique.
                    if not rows_for_key or rows_for_key[-1] != record_index:
                        rows_for_key.append(record_index)
                for field, counts in facets.items():
                    counts[row[positions[field]]] += 1
                chunk.append(row)
                record_count += 1
                if len(chunk) == chunk_size:
                    start = record_count - len(chunk)
                    write_json_pair(asset_root / "details" / f"{start // chunk_size}.json", {"start": start, "rows": chunk}, representations)
                    chunk = []
            if not record_count:
                raise BuildError("CSV contains a header but no records.")
    except (csv.Error, UnicodeError) as exc:
        raise BuildError(f"Malformed CSV: {exc}") from exc
    if chunk:
        start = record_count - len(chunk)
        write_json_pair(asset_root / "details" / f"{start // chunk_size}.json", {"start": start, "rows": chunk}, representations)
    index_fields = SEARCH_FIELDS + FLAG_FIELDS
    write_json_pair(asset_root / "search.json", {"fields": index_fields, "rows": index_rows}, representations)
    # Facet values are bulky and immutable per release: a cacheable asset keeps manifest.json tiny.
    write_json_pair(asset_root / "facets.json", {
        "fields": {
            field: [
                {"value": value, "label": value if value else "Not reported", "count": count}
                for value, count in sorted(counts.items(), key=lambda item: (-item[1], item[0].casefold(), item[0]))
            ]
            for field, counts in facets.items()
        },
    }, representations)
    sequence_keys = sorted(sequence_rows)
    write_json_pair(asset_root / "sequences.json", {
        "algorithm": SEQUENCE_ALGORITHM,
        "keys": sequence_keys,
        "rows": [sequence_rows[key] for key in sequence_keys],
    }, representations)
    manifest = {
        "schemaVersion": 1,
        "dataset": config["dataset"],
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "sourceChecksum": checksum,
        "counts": {"records": record_count, "patents": len(patents), "sequences": len(sequence_keys),
                   "chainCells": chain_cells, "nonStandardChainCells": non_standard_cells},
        "fields": fields,
        "index": {**asset_links(f"{asset_prefix}/search.json", representations), "fields": index_fields},
        "details": {**asset_links(f"{asset_prefix}/details/{{chunk}}.json", representations, ("pattern", "gzipPattern")), "chunkSize": chunk_size},
        "facets": asset_links(f"{asset_prefix}/facets.json", representations),
        "sequences": {**asset_links(f"{asset_prefix}/sequences.json", representations), "algorithm": SEQUENCE_ALGORITHM},
        "placeholders": PLACEHOLDER_TOKENS,
    }
    # The manifest is the bootstrap document and cannot point at itself, so it is always published
    # as plain JSON whatever --representations says about the assets it describes.
    if unlinkable_patents:
        sample = ", ".join(sorted(unlinkable_patents)[:5])
        print(f"Note: {len(unlinkable_patents):,} of {len(patents):,} patent ids are not bare 7-8 digit US "
              f"numbers ({sample}...). Those records render the id as plain text with no Google Patents "
              f"link; widen the gate in web/app.js if the new shapes should link.", file=sys.stderr)
    write_json_pair(staging / "data/manifest.json", manifest, "both" if representations == "gzip" else representations)
    return manifest


def write_not_found_page(path: Path, dataset: dict) -> None:
    """GitHub Pages serves this for unknown paths; it is self-contained so it renders at any depth."""
    record_url = dataset.get("recordUrl") or ""
    zenodo = ""
    if record_url:
        zenodo = (f'<a class="button secondary" href="{html.escape(record_url, quote=True)}"'
                  ' target="_blank" rel="noopener noreferrer">Dataset on Zenodo ↗</a>')
    path.write_text(
        '<!doctype html>\n<html lang="en">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        '<meta name="robots" content="noindex">\n'
        '<meta name="theme-color" content="#163c36">\n'
        '<title>Page not found · POISK Explorer</title>\n'
        '<style>\n'
        'body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;'
        'justify-content:center;gap:14px;padding:40px 20px;text-align:center;background:#f7f8f4;color:#1b302d;'
        'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.5}\n'
        '.eyebrow{font-size:10px;font-weight:650;letter-spacing:1.6px;color:#214d42}\n'
        'h1{font-size:39px;line-height:1.12;letter-spacing:-1.8px;font-weight:540;margin:0}\n'
        'p{margin:0;max-width:390px;color:#6c786f;line-height:1.75}\n'
        'nav{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:8px}\n'
        '.button{display:inline-flex;align-items:center;gap:9px;padding:10px 16px;font-size:12px;font-weight:550;'
        'border:1px solid #163c36;border-radius:6px;background:#163c36;color:#f4f7ed;text-decoration:none}\n'
        '.button.secondary{background:#fff;border-color:#dbe2d8;color:#1b302d}\n'
        'a:focus-visible{outline:3px solid #719b80;outline-offset:3px}\n'
        '</style>\n</head>\n<body>\n'
        '<span class="eyebrow">POISK EXPLORER</span>\n'
        '<h1>This page does not exist.</h1>\n'
        '<p>The address you requested is not part of this site. The explorer lives on a single page —'
        ' open it and search for the record you need.</p>\n'
        f'<nav><a class="button" href="./">Open the explorer ↗</a>{zenodo}</nav>\n'
        '</body>\n</html>\n',
        encoding="utf-8",
    )


def build(source: Path, output: Path, config: dict, web_root: Path = ROOT / "web", *,
          checksum: str | None = None, representations: str = "both") -> dict:
    source, output, web_root = source.resolve(), output.absolute(), web_root.resolve()
    if output.is_symlink():
        raise BuildError("Output directory cannot be a symbolic link.")
    output = output.resolve()
    if output == ROOT or ROOT.is_relative_to(output):
        raise BuildError("Output cannot be the project directory or an ancestor of it.")
    if source.is_relative_to(output) or web_root.is_relative_to(output) or output.is_relative_to(web_root):
        raise BuildError("Output must be separate from the source CSV and web source directory.")
    if output.exists() and not output.is_dir():
        raise BuildError("Output path already exists and is not a directory.")
    if not (web_root / "index.html").is_file():
        raise BuildError(f"Missing website entry point: {web_root / 'index.html'}")
    if representations not in REPRESENTATIONS:
        raise BuildError("representations must be one of " + ", ".join(REPRESENTATIONS) + ".")
    # A caller that already hashed the source (download_source does) must not rehash 234 MB.
    checksum = checksum if checksum is not None else verify_checksum(source, config["source"]["checksum"])
    output.parent.mkdir(parents=True, exist_ok=True)
    for stale in output.parent.glob(f".{output.name}-build-*"):
        # A killed build leaves its staging tree behind; nothing else uses this prefix.
        if stale.is_dir() and not stale.is_symlink():
            shutil.rmtree(stale, ignore_errors=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-build-", dir=output.parent))
    backup = output.with_name(f".{output.name}-previous-{uuid.uuid4().hex}")
    moved_previous = False
    try:
        shutil.copytree(web_root, staging, dirs_exist_ok=True)
        # All data files are generated, never copied from a stale web/data directory.
        if (staging / "data").exists():
            shutil.rmtree(staging / "data")
        manifest = generate_data(source, staging, config, checksum, representations)
        write_not_found_page(staging / "404.html", config["dataset"])
        (staging / ".nojekyll").write_text("", encoding="utf-8")
        if output.exists():
            output.rename(backup)
            moved_previous = True
        try:
            staging.rename(output)
        except OSError:
            if moved_previous:
                backup.rename(output)
                moved_previous = False
            raise
        if moved_previous:
            shutil.rmtree(backup)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Use a local CSV, still verified against source.checksum.")
    parser.add_argument("--config", type=Path, default=ROOT / "dataset.config.json", help="Dataset configuration (default: project dataset.config.json).")
    parser.add_argument("--output", type=Path, default=ROOT / "dist", help="Generated website directory (default: project dist).")
    parser.add_argument("--representations", choices=REPRESENTATIONS, default="both", help="Publish both the plain JSON assets and their .gz siblings (default), or only one of them.")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        checksum = None
        source = args.source
        if source is None:
            source, checksum = download_source(config, ROOT / ".cache")
        manifest = build(source, args.output, config, checksum=checksum, representations=args.representations)
    except (BuildError, OSError, URLError, IncompleteRead) as exc:
        # URLError is already an OSError; IncompleteRead is not, and a truncated download hits it.
        print(f"Build failed: {exc}", file=sys.stderr)
        return 1
    print(f"Built {manifest['counts']['records']:,} records from {manifest['counts']['patents']:,} patents in {args.output.resolve()}")
    print(f"Verified source: {manifest['sourceChecksum']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
