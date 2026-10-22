#!/usr/bin/env python3
"""Re-pin, preview, or audit the dataset release in dataset.config.json (stdlib only)."""

from __future__ import annotations

import argparse
import copy
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import quote
from urllib.request import build_opener, Request


ROOT = Path(__file__).resolve().parents[1]
# The builder owns what a valid configuration is; load it by path so this tool enforces the
# same rules instead of a second copy that can drift away from them.
SPEC = importlib.util.spec_from_file_location("poisk_build", Path(__file__).resolve().with_name("build.py"))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)

ZENODO_API = "https://zenodo.org/api/records/{record}"
ZENODO_DOWNLOAD = "https://zenodo.org/records/{record}/files/{key}?download=1"
# The shape dataset.config.json already uses; matching it keeps a re-pin a small diff.
COMMITTED_DOWNLOAD = re.compile(r"https://zenodo\.org/records/\d+/files/[^?/]+\?download=1")
DEFAULT_FILE_KEY = "poisk_dataset.csv"
# Outside the repository by default, so a draft pin can never be mistaken for the committed one.
DEFAULT_PREVIEW = Path(tempfile.gettempdir()) / "poisk-preview.config.json"
RECORD_IN_URL = re.compile(r"/records?/(\d+)")
RECORD_IN_DOI = re.compile(r"zenodo\.(\d+)", re.IGNORECASE)
# Zenodo reports a license identifier, never a display label. Only identifiers whose terms we
# can name are accepted, so a re-pin cannot invent a license for the dataset. The identifier
# verified against record 19883049 is "cc-by-4.0"; the rest of the table is the same CC family.
LICENSE_LABELS = {
    "cc-by-4.0": "CC BY 4.0",
    "cc-by-sa-4.0": "CC BY-SA 4.0",
    "cc-by-nc-4.0": "CC BY-NC 4.0",
    "cc-by-nd-4.0": "CC BY-ND 4.0",
    "cc-by-nc-sa-4.0": "CC BY-NC-SA 4.0",
    "cc-by-nc-nd-4.0": "CC BY-NC-ND 4.0",
    "cc0-1.0": "CC0 1.0",
}


class ReleaseError(ValueError):
    """A release pin that cannot be produced or trusted; reported without a traceback by CLI."""


def record_id(value: object) -> str | None:
    """The Zenodo record id inside a record URL, a file URL, or a zenodo DOI; None if absent."""
    if not isinstance(value, str):
        return None
    for pattern in (RECORD_IN_URL, RECORD_IN_DOI):
        match = pattern.search(value)
        if match:
            return match.group(1)
    return None


def license_label(metadata: dict) -> str:
    value = metadata.get("license")
    identifier = value.get("id") if isinstance(value, dict) else value
    if not isinstance(identifier, str) or not identifier.strip():
        raise ReleaseError("Zenodo record reports no metadata.license.id; set dataset.license by hand after reading the record page.")
    label = LICENSE_LABELS.get(identifier.strip().lower())
    if label is None:
        raise ReleaseError(f"Unknown Zenodo license id {identifier!r}; add its label to LICENSE_LABELS after confirming the terms.")
    return label


def publication_year(metadata: dict) -> str:
    match = re.match(r"(\d{4})", str(metadata.get("publication_date") or ""))
    if not match:
        raise ReleaseError("Zenodo record reports no usable metadata.publication_date.")
    return match.group(1)


def abbreviate(name: str) -> str:
    """'Tupikina, Daria' -> 'Tupikina, D.'; a name without a comma is kept verbatim."""
    family, separator, given = name.strip().partition(",")
    if not separator or not given.strip():
        return name.strip()
    words = [word for word in re.split(r"[\s.]+", given.strip()) if word]
    initials = " ".join("-".join(f"{part[0].upper()}." for part in word.split("-") if part) for word in words)
    return f"{family.strip()}, {initials}"


def citation_authors(creators: object) -> str:
    if not isinstance(creators, list) or not creators:
        raise ReleaseError("Zenodo record reports no metadata.creators.")
    names = []
    for creator in creators:
        name = creator.get("name") if isinstance(creator, dict) else None
        if not isinstance(name, str) or not name.strip():
            raise ReleaseError("A Zenodo creator entry has no name.")
        names.append(abbreviate(name))
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + ", & " + names[-1]


def build_citation(creators: object, year: str, title: str, version: str, doi: str) -> str:
    """The published citation wording; dataset.citation must stay byte-identical in shape."""
    return f"{citation_authors(creators)} ({year}). {title} (Version {version}) [Data set]. Zenodo. https://doi.org/{doi}"


def draft_citation(citation: str, published_version: str, version: str) -> str:
    """Offline restamp for a preview: keep the wording, drop the DOI a draft does not have."""
    text = citation.replace(f"(Version {published_version})", f"(Version {version})")
    return re.sub(r"\s*https://doi\.org/\S+\s*$", "", text).rstrip()


def config_problems(config: dict) -> list[str]:
    """Release-pin consistency checks that build.py's load_config does not cover."""
    problems: list[str] = []
    source = config.get("source") if isinstance(config.get("source"), dict) else {}
    dataset = config.get("dataset") if isinstance(config.get("dataset"), dict) else {}
    try:
        builder.checksum_parts(source.get("checksum"))
    except builder.BuildError as exc:
        problems.append(str(exc))
    stated = {
        "source.url": source.get("url"),
        "dataset.recordUrl": dataset.get("recordUrl"),
        "dataset.downloadUrl": dataset.get("downloadUrl"),
        "dataset.doi": dataset.get("doi"),
    }
    # A draft leaves the publication links empty on purpose, so only the stated ones must agree.
    found = {label: record_id(value) for label, value in stated.items() if isinstance(value, str) and value.strip()}
    unreadable = sorted(label for label, identifier in found.items() if identifier is None)
    if unreadable:
        problems.append("No Zenodo record id in " + ", ".join(unreadable) + ".")
    identifiers = {identifier for identifier in found.values() if identifier is not None}
    if len(identifiers) > 1:
        disagreeing = ", ".join(f"{label}={found[label]}" for label in sorted(found) if found[label])
        problems.append(f"Zenodo record ids disagree: {disagreeing}.")
    if not found:
        problems.append("source.url must point at a Zenodo record.")
    version, doi = dataset.get("version") or "", dataset.get("doi") or ""
    citation = dataset.get("citation") or ""
    if version and version not in citation:
        problems.append(f"dataset.version {version!r} does not appear in dataset.citation.")
    if doi:
        if doi not in citation:
            problems.append(f"dataset.doi {doi!r} does not appear in dataset.citation.")
        if not isinstance(dataset.get("license"), str) or not dataset["license"].strip():
            problems.append("dataset.license must name the published license whenever dataset.doi is set.")
    return problems


def markup_problems(config: dict, markup: Path) -> list[str]:
    """
    web/index.html hard-codes the Zenodo record so the links and the <noscript> block still work
    when the manifest fetch fails. Those are the only dataset URLs the build copies verbatim, so a
    re-point that misses them leaves the page advertising the previous release.
    """
    try:
        text = markup.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"Cannot read {markup}: {exc}"]
    dataset = config.get("dataset") if isinstance(config.get("dataset"), dict) else {}
    expected = record_id(dataset.get("doi")) or record_id((config.get("source") or {}).get("url"))
    if expected is None:
        return []
    problems = []
    stale = sorted({found for found in re.findall(r"zenodo\.org/records/(\d+)", text) if found != expected})
    if stale:
        problems.append(f"{markup.name} links Zenodo record(s) {', '.join(stale)} but the pin is {expected}.")
    wanted = file_key_of(dataset.get("downloadUrl")) or file_key_of((config.get("source") or {}).get("url"))
    if wanted:
        others = sorted({found for found in re.findall(r"/files/([^/?#\"']+)", text) if found != wanted})
        if others:
            problems.append(f"{markup.name} links dataset file(s) {', '.join(others)} but the pin is {wanted}.")
    return problems


def retarget_markup(text: str, old_url: str, new_url: str) -> str:
    """
    Point the hard-coded fallback links at the newly pinned release. Only the record id and the
    file name move; the surrounding markup is left alone. Returns the text unchanged when there is
    nothing to retarget, so a caller can compare and skip the write.
    """
    old_id, new_id = record_id(old_url), record_id(new_url)
    if old_id and new_id and old_id != new_id:
        text = text.replace(f"zenodo.org/records/{old_id}", f"zenodo.org/records/{new_id}")
    old_file, new_file = file_key_of(old_url), file_key_of(new_url)
    if old_file and new_file and old_file != new_file:
        text = text.replace(f"/files/{old_file}", f"/files/{new_file}")
    return text


def file_key_of(url: object) -> str | None:
    match = re.search(r"/files/([^/?#]+)", str(url or ""))
    return match.group(1) if match else None


def serialize(config: dict) -> str:
    return json.dumps(config, indent=2, ensure_ascii=False) + "\n"


def validate_config(config: dict) -> None:
    """Nothing is written until the builder accepts the configuration and the checks pass."""
    with tempfile.TemporaryDirectory() as directory:
        candidate = Path(directory) / "dataset.config.json"
        candidate.write_text(serialize(config), encoding="utf-8")
        builder.load_config(candidate)
    problems = config_problems(config)
    if problems:
        raise ReleaseError("Generated configuration is inconsistent:\n  - " + "\n  - ".join(problems))


def write_atomically(path: Path, text: str) -> None:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        if path.exists():
            temporary.chmod(path.stat().st_mode & 0o7777)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def file_md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_record(identifier: str, timeout: int) -> dict:
    url = ZENODO_API.format(record=identifier)
    builder.validate_https(url, "Zenodo API URL")
    request = Request(url, headers={"User-Agent": "POISK-Explorer/1.0", "Accept": "application/json"})
    try:
        with build_opener(builder.HTTPSOnlyRedirect()).open(request, timeout=timeout) as response:
            builder.validate_https(response.geturl(), "Zenodo API response URL")
            payload = response.read()
    except OSError as exc:
        raise ReleaseError(f"Cannot reach the Zenodo API for record {identifier}: {exc}") from exc
    try:
        record = json.loads(payload.decode("utf-8"))
    except (UnicodeError, ValueError) as exc:
        raise ReleaseError(f"Zenodo API response for record {identifier} is not JSON: {exc}") from exc
    if not isinstance(record, dict):
        raise ReleaseError(f"Zenodo API response for record {identifier} is not a record object.")
    return record


def find_file(record: dict, file_key: str) -> dict:
    files = record.get("files")
    if not isinstance(files, list) or not files:
        raise ReleaseError("Zenodo record reports no files.")
    for entry in files:
        if isinstance(entry, dict) and entry.get("key") == file_key:
            return entry
    available = ", ".join(sorted(str(entry.get("key")) for entry in files if isinstance(entry, dict)))
    raise ReleaseError(f"Zenodo record has no file named {file_key}; it offers: {available or 'nothing readable'}.")


def source_url(identifier: str, entry: dict, committed: object) -> str:
    if isinstance(committed, str) and COMMITTED_DOWNLOAD.fullmatch(committed):
        return ZENODO_DOWNLOAD.format(record=identifier, key=quote(str(entry.get("key"))))
    link = (entry.get("links") or {}).get("self")
    builder.validate_https(link, "Zenodo file links.self")
    return link


def config_from_record(config: dict, record: dict, identifier: str, file_key: str) -> dict:
    metadata = record.get("metadata")
    if not isinstance(metadata, dict):
        raise ReleaseError(f"Zenodo record {identifier} has no metadata object.")
    entry = find_file(record, file_key)
    doi = str(record.get("doi") or metadata.get("doi") or "")
    if not re.fullmatch(r"10\.\d{4,9}/\S+", doi):
        raise ReleaseError(f"Zenodo record {identifier} reports no usable DOI.")
    if record_id(doi) != identifier:
        raise ReleaseError(f"DOI {doi} does not belong to Zenodo record {identifier}.")
    links = record.get("links") if isinstance(record.get("links"), dict) else {}
    record_url = links.get("self_html") or f"https://zenodo.org/records/{identifier}"
    builder.validate_https(record_url, "Zenodo links.self_html")
    if record_id(record_url) != identifier:
        raise ReleaseError(f"Record page {record_url} does not belong to Zenodo record {identifier}.")
    version = str(metadata.get("version") or "").strip()
    if not version:
        raise ReleaseError(f"Zenodo record {identifier} reports no metadata.version.")
    builder.checksum_parts(entry.get("checksum"))
    download = source_url(identifier, entry, config.get("source", {}).get("url"))
    updated = copy.deepcopy(config)
    updated["source"].update(url=download, checksum=str(entry["checksum"]).lower())
    # dataset.title is not part of a re-pin, so the citation reuses it and the two cannot disagree.
    updated["dataset"].update(
        version=version,
        doi=doi,
        recordUrl=record_url,
        downloadUrl=download,
        license=license_label(metadata),
        citation=build_citation(metadata.get("creators"), publication_year(metadata),
                                updated["dataset"]["title"], version, doi),
    )
    validate_config(updated)
    return updated


def run_check(config_path: Path) -> int:
    try:
        config = builder.load_config(config_path)
    except builder.BuildError as exc:
        # Report a builder rejection in the same shape as every other problem, not as a crash.
        config, problems = None, [f"build.py rejects the configuration: {exc}"]
    else:
        problems = config_problems(config) + markup_problems(config, ROOT / "web/index.html")
    if problems:
        print(f"Release pin in {config_path} is inconsistent:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    dataset = config["dataset"]
    identifier = record_id(dataset["doi"]) or record_id(config["source"]["url"])
    print(f"Release pin is consistent: Zenodo record {identifier}, version {dataset['version']}, license {dataset['license'] or 'unreported'}.")
    print(f"Pinned source: {config['source']['checksum']}")
    return 0


def run_preview(config_path: Path, source: Path | None, output: Path | None, version: str | None) -> int:
    if source is None:
        raise ReleaseError("--preview needs --source <path to the revised CSV>.")
    source = Path(os.path.abspath(source.expanduser()))
    if not source.is_file():
        raise ReleaseError(f"--source is not a file: {source}")
    destination = Path(os.path.abspath((output or DEFAULT_PREVIEW).expanduser()))
    if destination.is_relative_to(ROOT):
        raise ReleaseError(f"A preview configuration must live outside {ROOT}; pass --output {DEFAULT_PREVIEW} or another path.")
    config = builder.load_config(config_path)
    published = config["dataset"]["version"]
    label = (version or f"{published}-draft").strip()
    if not label:
        raise ReleaseError("--version must not be empty.")
    digest = file_md5(source)
    draft = copy.deepcopy(config)
    draft["source"]["checksum"] = f"md5:{digest}"
    # Blank publication links and drop the DOI from the citation: a draft of an unpublished
    # CSV must not be able to present itself as the published release.
    draft["dataset"].update(
        version=label,
        doi="",
        recordUrl="",
        downloadUrl="",
        citation=draft_citation(config["dataset"]["citation"], published, label),
    )
    validate_config(draft)
    destination.parent.mkdir(parents=True, exist_ok=True)
    write_atomically(destination, serialize(draft))
    print(f"Wrote preview configuration {destination}")
    print(f"  source.checksum md5:{digest}")
    print(f"  dataset.version {label}; doi, recordUrl and downloadUrl blanked")
    print(f"Build it with: python3 scripts/build.py --source {source} --config {destination} --output dist")
    return 0


def run_repin(config_path: Path, identifier: str, file_key: str, timeout: int, confirmed: bool) -> int:
    identifier = identifier.strip()
    if not re.fullmatch(r"\d+", identifier):
        raise ReleaseError("--zenodo-record must be a numeric Zenodo record id.")
    config = builder.load_config(config_path)
    record = fetch_record(identifier, timeout)
    updated = config_from_record(config, record, identifier, file_key)
    published_title = str((record.get("metadata") or {}).get("title") or "").strip()
    if published_title and published_title != updated["dataset"]["title"]:
        print(f"Note: Zenodo titles this record {published_title!r}; dataset.title is left as committed.", file=sys.stderr)
    before, after = config_path.read_text(encoding="utf-8"), serialize(updated)
    if before == after:
        print(f"{config_path} already pins Zenodo record {identifier}; nothing to change.")
        return 0
    sys.stdout.writelines(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=f"{config_path} (committed)", tofile=f"{config_path} (Zenodo record {identifier})"))
    if not confirmed:
        print("\nNothing written. Re-run with --yes to apply the diff above.")
        return 0
    markup_path = ROOT / "web/index.html"
    markup_before = markup_path.read_text(encoding="utf-8")
    markup_after = retarget_markup(markup_before, config["dataset"]["downloadUrl"] or config["source"]["url"],
                                   updated["dataset"]["downloadUrl"] or updated["source"]["url"])
    write_atomically(config_path, after)
    if markup_after != markup_before:
        write_atomically(markup_path, markup_after)
        print(f"Retargeted the hard-coded fallback links in {markup_path.relative_to(ROOT)}.")
    # The markup carries the only copies of these URLs that survive a failed manifest fetch, so a
    # re-pin that cannot fix them must say so rather than leaving --check to fail in CI.
    remaining = markup_problems(updated, markup_path)
    for problem in remaining:
        print(f"Warning: {problem}", file=sys.stderr)
    print(f"\nRe-pinned {config_path} to Zenodo record {identifier}.")
    print("Next: python3 scripts/release.py --check && python3 -m unittest discover -s tests -p 'test_*.py'")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--zenodo-record", metavar="ID", help="Re-pin the configuration to a published Zenodo record id.")
    mode.add_argument("--preview", action="store_true", help="Write a draft configuration for a local CSV, outside the repository.")
    mode.add_argument("--check", action="store_true", help="Audit the committed configuration offline; non-zero exit on any inconsistency.")
    parser.add_argument("--config", type=Path, default=ROOT / "dataset.config.json", help="Dataset configuration (default: project dataset.config.json).")
    parser.add_argument("--source", type=Path, help="Local CSV whose md5 --preview pins.")
    parser.add_argument("--output", type=Path, help=f"Where --preview writes (default: {DEFAULT_PREVIEW}).")
    parser.add_argument("--version", help="Draft version label for --preview (default: <version>-draft).")
    parser.add_argument("--file-key", default=DEFAULT_FILE_KEY, help=f"Zenodo file to pin (default: {DEFAULT_FILE_KEY}).")
    parser.add_argument("--yes", action="store_true", help="Write the re-pinned configuration instead of only printing its diff.")
    parser.add_argument("--timeout", type=int, default=30, help="Zenodo API timeout in seconds (default: 30).")
    args = parser.parse_args()
    try:
        if args.check:
            return run_check(args.config)
        if args.preview:
            return run_preview(args.config, args.source, args.output, args.version)
        return run_repin(args.config, args.zenodo_record, args.file_key, args.timeout, args.yes)
    except (ReleaseError, builder.BuildError, OSError) as exc:
        print(f"Release failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
