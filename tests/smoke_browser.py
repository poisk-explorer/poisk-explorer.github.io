#!/usr/bin/env python3
"""Browser smoke test for a built POISK Explorer site. NOT part of CI: it needs a browser.

It drives a real Chromium against a real build and checks the things no unit test can see --
that the worker, the generated assets and the markup agree once they are all on a page together.
Keep it out of .github/workflows: the CI runners have neither a browser nor the 234 MB source CSV.

Requires playwright and its Chromium (not a project dependency; installed per machine):
    python3 -m pip install playwright && python3 -m playwright install chromium

Run it against a site you are already serving -- this script never starts a server:

    python3 scripts/build.py --source <poisk_dataset.csv> --output /tmp/poisk-site
    python3 -m http.server 8777 --directory /tmp/poisk-site &
    python3 tests/smoke_browser.py http://localhost:8777/ --dist /tmp/poisk-site
    kill %1          # the server is yours to stop; this script never starts one

--dist must point at the SAME build the URL serves: the exact-chain step reads a real VH sequence
out of its detail chunks and computes, from its sequences.json, how many records the page must
find. It defaults to ./dist. Add --json <path> for a machine-readable report, --headed to watch,
and --slow-factor to raise every wait on a slow machine or a remote host.

Exit status is 0 only when every step passed.
"""

import argparse
import bisect
import contextlib
import gzip
import json
import re
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# The page debounces typing by 180 ms (app.js) and the worker answers in tens of milliseconds on
# localhost, so every wait below is a generous multiple of the work it waits for.
READY_MS = 180_000
SETTLE_MS = 20_000
COUNTS_MS = 30_000
DOWNLOAD_MS = 300_000
DESKTOP = {"width": 1440, "height": 1000}
MOBILE = {"width": 390, "height": 844}
# The smallest type the page is allowed to render. 10px is a deliberate floor, not an aspiration:
# anything carrying a dataset value or labelling a control was raised to 11px, and what remains at
# 10px is branding and navigation chrome (.eyebrow, .version, .overview-*, .site-footer, .examples,
# .count-pill, .note-icon, .search-note, .download-source). Raise this to 11 only together with
# those rules in web/styles.css.
MINIMUM_FONT_PX = 10
COUNT = re.compile(r"([\d,]+)")
# Every element that renders text of its own, grouped by selector and computed size. A box 1px or
# smaller in either direction is the visually-hidden .sr-only recipe, not text anyone reads.
# Pseudo-element content is not covered: ::before/::after are not reachable in one pass.
TINY_TEXT_JS = """(floor) => {
  const found = new Map();
  for (const node of document.querySelectorAll('body *')) {
    if (node.offsetParent === null) continue;
    if (![...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())) continue;
    const box = node.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    const px = parseFloat(getComputedStyle(node).fontSize);
    if (px >= floor) continue;
    const key = px + 'px ' + node.tagName.toLowerCase()
      + (node.className ? '.' + String(node.className).trim().split(' ').join('.') : '');
    found.set(key, (found.get(key) || 0) + 1);
  }
  return [...found].map(([selector, count]) => count > 1 ? `${selector} x${count}` : selector);
}"""
# The page's own scroll width, and the elements responsible for any of it that is off screen. An
# element inside a scroll container is NOT responsible: the container clips it. An absolutely
# positioned one escapes every clipper between it and its containing block, which is how a
# visually-hidden <span> in a 660px table dragged the whole 390px page sideways.
OVERFLOW_JS = """() => {
  const name = node => node.tagName.toLowerCase() + (node.id ? '#' + node.id : '')
    + (node.className ? '.' + String(node.className).trim().split(' ')[0] : '');
  const clipper = node => {
    const position = getComputedStyle(node).position;
    const escapes = position === 'absolute' || position === 'fixed';
    const boundary = escapes ? node.offsetParent : null;
    let inside = !escapes;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (!inside) {
        if (parent !== boundary) continue;
        inside = true;
      }
      if (getComputedStyle(parent).overflowX !== 'visible') return name(parent);
    }
    return null;
  };
  return {content: document.documentElement.scrollWidth, viewport: window.innerWidth,
    responsible: [...document.querySelectorAll('body *')]
      .filter(node => node.getBoundingClientRect().right > window.innerWidth + 1 && !clipper(node))
      .map(node => name(node) + '@' + Math.round(node.getBoundingClientRect().right))
      .slice(0, 6)};
}"""
# One facet's rendered option rows, by field: the live counts are written over them in place.
FACET_OPTIONS_JS = """(field) => [...document.querySelectorAll(
    '[data-facet-action="value"][data-facet-field="' + CSS.escape(field) + '"]')]
  .map(node => ({value: node.dataset.facetValue,
                 count: Number(node.lastElementChild.textContent.replace(/,/g, '')),
                 checked: node.getAttribute('aria-checked') === 'true'}))"""
# Whether the rendered counts of one facet are (or, negated, are no longer) a given tally. The
# counts arrive after the rows do, so they are waited for rather than read.
COUNTS_JS = """(expected) => {{
  const nodes = [...document.querySelectorAll(
    '[data-facet-action="value"][data-facet-field="' + CSS.escape(expected.field) + '"]')];
  const agrees = node => Number(node.lastElementChild.textContent.replace(/,/g, ''))
    === expected.counts[node.dataset.facetValue];
  return nodes.length > 0 && {negate}nodes.every(agrees);
}}"""
COUNTS_MATCH_JS = COUNTS_JS.format(negate="")
COUNTS_CHANGED_JS = COUNTS_JS.format(negate="!")


class StepFailure(AssertionError):
    """A check inside a step that did not hold; the step is recorded as a failure."""


@dataclass
class Step:
    name: str
    ok: bool | None = None
    detail: str = ""
    seconds: float = 0.0

    def require(self, condition, detail=""):
        """Record `detail` either way, and fail the step when `condition` is false."""
        self.note(detail)
        if not condition:
            raise StepFailure(detail)

    def note(self, detail):
        if detail:
            self.detail = str(detail).replace("\n", " ")


@dataclass
class Report:
    steps: list[Step] = field(default_factory=list)
    console: list[str] = field(default_factory=list)
    page_errors: list[str] = field(default_factory=list)
    failed_requests: list[str] = field(default_factory=list)

    @contextlib.contextmanager
    def step(self, name):
        record = Step(name)
        self.steps.append(record)
        started = time.time()
        try:
            yield record
            record.ok = True if record.ok is None else record.ok
        except Exception as error:
            record.ok = False
            if not isinstance(error, StepFailure) or not record.detail:
                record.note(f"{type(error).__name__}: {error}")
        finally:
            record.seconds = time.time() - started

    @property
    def failures(self):
        return [step for step in self.steps if not step.ok]

    def write(self, stream):
        """One line per step, then every failure again in full -- the detail is the measurement."""
        width = max(len(step.name) for step in self.steps) if self.steps else 4
        for step in self.steps:
            short = step.detail if len(step.detail) <= 120 else step.detail[:117] + "..."
            stream.write(f"{'PASS' if step.ok else 'FAIL'}  {step.name:<{width}}  "
                         f"{step.seconds:5.1f}s  {short}\n")
        stream.write(f"\n{len(self.steps) - len(self.failures)} passed, {len(self.failures)} failed\n")
        for step in self.failures:
            stream.write(f"\nFAILED  {step.name}\n        {step.detail}\n")


def fnv1a64(text: str) -> str:
    """CONTRACT.md section 4. The same function build.py and web/data-utils.js implement."""
    digest = 0xCBF29CE484222325
    for byte in text.encode("ascii"):
        digest = ((digest ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{digest:016x}"


def canonical(sequence: str) -> str:
    return re.sub(r"[^A-Z]", "", sequence.upper())


def read_asset(dist: Path, *candidates) -> dict:
    """The first of `candidates` that this build published, plain or gzipped."""
    for candidate in candidates:
        path = dist / candidate if candidate else None
        if path and path.is_file():
            opener = gzip.open if path.suffix == ".gz" else open
            with opener(path, "rt", encoding="utf-8") as handle:
                return json.load(handle)
    raise SystemExit(f"{dist} does not contain any of {[name for name in candidates if name]}; "
                     f"is it the build the URL serves? Pass --dist.")


def pick_chain(dist: Path, manifest: dict):
    """A real VH sequence from the build, with the record count its own sequences.json promises.

    Taken from the first detail chunk and preferred by fewest records, so the page fetches one
    chunk to render the match. Hashing it here is what proves build.py and the browser agree:
    the page can only find this many records if its fnv1a64 produced the same key.
    """
    sequences = read_asset(dist, manifest["sequences"].get("url"), manifest["sequences"].get("gzipUrl"))
    if sequences.get("algorithm") != "fnv1a64":
        raise SystemExit(f"sequences.json declares algorithm {sequences.get('algorithm')!r}, not fnv1a64.")
    position = manifest["fields"].index("vh.sequence_from_patent")
    pattern = manifest["details"].get("pattern") or manifest["details"].get("gzipPattern")
    chunk = read_asset(dist, pattern.replace("{chunk}", "0"))
    best = None
    for row in chunk["rows"]:
        sequence = canonical(row[position])
        if len(sequence) < 20:
            continue
        key = fnv1a64(sequence)
        at = bisect.bisect_left(sequences["keys"], key)
        if at >= len(sequences["keys"]) or sequences["keys"][at] != key:
            continue
        records = len(sequences["rows"][at])
        if best is None or records < best[2]:
            best = (sequence, key, records)
    if best is None:
        raise SystemExit("No indexed VH sequence in the first detail chunk; cannot test exact-chain search.")
    return best


def results_count(page) -> int:
    match = COUNT.search(page.inner_text("#results-count"))
    return int(match.group(1).replace(",", "")) if match else 0


def wait_ready(page, scale):
    page.wait_for_function(
        "() => document.querySelector('#results-count') "
        "&& !/Loading/.test(document.querySelector('#results-count').textContent)",
        timeout=READY_MS * scale)


def settle(page, scale, url_predicate=None):
    """Wait for the search the last interaction started: its URL edit, then its spinner."""
    if url_predicate:
        page.wait_for_function(url_predicate, timeout=SETTLE_MS * scale)
    page.wait_for_function("() => document.querySelector('#results').getAttribute('aria-busy') === 'false'",
                           timeout=SETTLE_MS * scale)


def search_for(page, text, scale, field_value=None):
    if field_value is not None:
        page.select_option("#search-field", field_value)
        # 'all' is the default and is left out of the URL entirely.
        settle(page, scale, "() => (new URLSearchParams(location.search).get('field') || 'all') === "
                            f"{json.dumps(field_value)}")
    page.fill("#search-input", text)
    # replaceState runs at the end of runSearch, so the q parameter is the signal that the rows
    # on screen answer this query rather than the previous keystroke. An empty query drops it.
    expected = json.dumps(text) if text else "null"
    settle(page, scale, f"() => new URLSearchParams(location.search).get('q') === {expected}")


def reset_filters(page, scale):
    """Clear every selection, if there is one: the Reset button is disabled when there is not."""
    if page.locator("#reset-filters").is_enabled():
        page.click("#reset-filters")
        settle(page, scale)


def facet_options(page, field):
    """Every option rendered in one facet, in rendered order, with its live count."""
    return page.evaluate(FACET_OPTIONS_JS, field)


def run(url, dist, options):
    from playwright.sync_api import sync_playwright

    scale = options.slow_factor
    report = Report()
    manifest = read_asset(dist, "data/manifest.json")
    facets = read_asset(dist, manifest["facets"].get("url"), manifest["facets"].get("gzipUrl"))
    chain, chain_key, chain_records = pick_chain(dist, manifest)
    downloads = Path(tempfile.mkdtemp(prefix="poisk-smoke-"))
    try:
        with sync_playwright() as driver:
            browser = driver.chromium.launch(headless=not options.headed)
            # Clipboard access is needed to paste a FASTA record the way a person would; an <input>
            # strips the line breaks out of a pasted value, which is the whole point of that step.
            context = browser.new_context(viewport=DESKTOP, permissions=["clipboard-read", "clipboard-write"])
            page = context.new_page()
            page.on("console", lambda message: report.console.append(f"{message.type}: {message.text}"[:300])
                    if message.type in ("error", "warning") else None)
            page.on("pageerror", lambda error: report.page_errors.append(str(error)[:300]))
            page.on("requestfailed", lambda request: report.failed_requests.append(f"{request.url} {request.failure}"[:300]))

            with report.step("loads and reports a record count") as check:
                started = time.time()
                page.goto(url, wait_until="load")
                wait_ready(page, scale)
                total = results_count(page)
                check.require(total > 0, f"{total:,} records in {time.time() - started:.1f}s to interactive")

            with report.step("hero counts come from the manifest") as check:
                shown = (page.inner_text("#record-count"), page.inner_text("#patent-count"))
                expected = (f"{manifest['counts']['records']:,}", f"{manifest['counts']['patents']:,}")
                check.require(shown == expected, f"{shown} vs manifest {expected}")

            with report.step("distinct-sequence count is published") as check:
                summary = page.inner_text("#sequence-summary")
                check.require(f"{manifest['counts']['sequences']:,}" in summary, summary)

            with report.step("first page renders 25 rows") as check:
                rows = page.locator("#result-rows tr").count()
                check.require(rows == 25, f"{rows} rows")

            hyphenated = squashed = 0
            with report.step("PD1 and PD-1 find the same records") as check:
                search_for(page, "PD-1", scale)
                hyphenated = results_count(page)
                search_for(page, "PD1", scale)
                squashed = results_count(page)
                check.require(hyphenated == squashed and hyphenated > 0,
                              f"PD-1 {hyphenated:,} vs PD1 {squashed:,}")

            with report.step("a scoped field search narrows the same query") as check:
                search_for(page, "PD1", scale, field_value="target.gene_names")
                scoped = results_count(page)
                check.require(0 < scoped <= squashed, f"gene names only: {scoped:,} of {squashed:,}")
                search_for(page, "", scale, field_value="all")

            panel, facet, published, chosen = page.locator(".facet").first, None, {}, []
            with report.step("the filter panel offers the first published facet") as check:
                # The summary carries its field before the option list is drawn (drawn on open).
                facet = panel.locator("[data-selected-field]").get_attribute(
                    "data-selected-field", timeout=SETTLE_MS * scale)
                published = {item["value"]: item["count"] for item in facets["fields"].get(facet, [])}
                check.require(bool(published),
                              f"{facet}, {len(published)} values in facets.json")

            with report.step("a facet accumulates two values") as check:
                panel.locator("summary").click()
                # The option list is drawn by the <details> toggle handler, one task later.
                panel.locator('[data-facet-action="value"]').first.wait_for(timeout=SETTLE_MS * scale)
                rendered = facet_options(page, facet)
                check.require(len(rendered) >= 2, f"{facet}: {len(rendered)} of "
                                                  f"{len(published)} published options rendered")
                chosen = rendered[:2]
                for option in chosen:
                    panel.locator(f'[data-facet-action="value"][data-facet-value={json.dumps(option["value"])}]').click()
                    settle(page, scale, "() => new URLSearchParams(location.search)"
                                        f".getAll({json.dumps(facet)}).includes({json.dumps(option['value'])})")
                selected = parse_qs(urlsplit(page.url).query).get(facet, [])
                ticked = [option["value"] for option in facet_options(page, facet) if option["checked"]]
                check.require(selected == [option["value"] for option in chosen] == ticked,
                              f"{facet} = {selected} as repeated parameters ({results_count(page):,} records)")

            with report.step("two values are ORed, not ANDed") as check:
                # Every row holds exactly one value per facet field, so two selected values must
                # return the sum of their counts. An AND would return nothing at all.
                check.require(len(chosen) == 2, "needs the two values the previous step selected")
                counts = [option["count"] for option in chosen]
                both = results_count(page)
                check.require(both == sum(counts),
                              f"{both:,} with both selected, {' + '.join(f'{count:,}' for count in counts)} "
                              f"= {sum(counts):,} separately")

            with report.step("an unconstrained facet shows the published totals") as check:
                reset_filters(page, scale)
                # The counts are tallied in the worker after the rows render, so they are waited
                # for rather than read out of whatever was on screen when the search finished.
                page.wait_for_function(COUNTS_MATCH_JS, arg={"field": facet, "counts": published},
                                       timeout=COUNTS_MS * scale)
                check.note(f"{len(facet_options(page, facet))} rendered {facet} counts match facets.json")

            with report.step("facet counts follow the query") as check:
                page.fill("#search-input", "EGFR")
                page.wait_for_function(COUNTS_CHANGED_JS, arg={"field": facet, "counts": published},
                                       timeout=COUNTS_MS * scale)
                after = {option["value"]: option["count"] for option in facet_options(page, facet)}
                grew = [value for value, count in after.items() if count > published.get(value, count)]
                shrank = [value for value, count in after.items() if count < published.get(value, count)]
                check.require(not grew and shrank,
                              f"{len(shrank)} of {len(after)} {facet} counts fell for 'EGFR' "
                              f"({results_count(page):,} records), {len(grew)} rose")

            with report.step("exact chain lookup finds its records") as check:
                search_for(page, "", scale, field_value="sequence")
                search_for(page, chain, scale)
                found = results_count(page)
                check.require(found == chain_records,
                              f"{found:,} records for key {chain_key} ({len(chain)} residues), "
                              f"sequences.json says {chain_records:,}")

            with report.step("the lookup states what it compared") as check:
                hint = page.inner_text("#sequence-hint")
                check.require("exact" in hint.lower() and not page.locator("#sequence-hint").is_hidden(), hint)

            with report.step("the lookup pauses sort and filters") as check:
                disabled = page.evaluate("""() => ({
                  sort: [...document.querySelectorAll('th[data-sort] button')].every(node => node.disabled),
                  facets: document.querySelector('#facets').inert === true})""")
                check.require(disabled["sort"] and disabled["facets"], json.dumps(disabled))

            with report.step("a short paste is reported as not compared") as check:
                search_for(page, chain[:12], scale)
                check.require(results_count(page) == 0 and "not compared" in page.inner_text("#empty-detail"),
                              page.inner_text("#empty-detail")[:140])

            # The site's own FASTA output must find itself. An <input> deletes the line breaks from
            # a pasted value before any listener runs, so the description line used to be welded
            # onto the chain and the lookup reported the release's own sequence as absent. Only a
            # real keyboard paste exercises this: fill() assigns .value and fires no paste event.
            with report.step("the site's own FASTA record finds itself") as check:
                entry = ">000000|VH|L612|5419904|Ganglioside GM3\n" + "\n".join(
                    chain[at:at + 60] for at in range(0, len(chain), 60))
                page.evaluate("text => navigator.clipboard.writeText(text)", entry)
                page.fill("#search-input", "")
                page.click("#search-input")
                page.keyboard.press("Control+V")
                page.wait_for_timeout(SETTLE_MS // 10)
                page.wait_for_function("count => {"
                                       "  const node = document.querySelector('#results-count');"
                                       "  return node && !/Loading|…/.test(node.textContent);"
                                       "}", arg=chain_records, timeout=COUNTS_MS)
                found = results_count(page)
                left = page.input_value("#search-input")
                check.require(found == chain_records and left == chain,
                              f"{found:,} records (sequences.json says {chain_records:,}); "
                              f"the box kept {len(left)} characters, the chain is {len(chain)}")

            with report.step("a FASTA record with its line breaks already gone says so") as check:
                search_for(page, f">000000|VH|L612 {chain}", scale)
                detail = page.inner_text("#empty-detail")
                check.require(results_count(page) == 0 and "description line" in detail, detail[:160])

            with report.step("FASTA export downloads the matching chains") as check:
                search_for(page, chain, scale)
                page.click("#export-results")
                page.wait_for_selector("#export-dialog[open]")
                page.locator('#export-dialog input[value="fasta"]').check()
                with page.expect_download(timeout=DOWNLOAD_MS * scale) as download:
                    page.click("#start-export")
                saved = downloads / download.value.suggested_filename
                download.value.save_as(saved)
                text = saved.read_text(encoding="utf-8")
                entries = text.count(">")
                check.require(saved.suffix == ".fasta" and text.startswith(">") and chain in text.replace("\n", ""),
                              f"{saved.name}, {saved.stat().st_size:,} bytes, {entries} entries")
                page.keyboard.press("Escape")

            with report.step("metadata export downloads a CSV with a header") as check:
                page.click("#export-results")
                page.wait_for_selector("#export-dialog[open]")
                page.locator('#export-dialog input[value="metadata"]').check()
                with page.expect_download(timeout=DOWNLOAD_MS * scale) as download:
                    page.click("#start-export")
                saved = downloads / download.value.suggested_filename
                download.value.save_as(saved)
                first = saved.read_text(encoding="utf-8").splitlines()[0]
                check.require(saved.suffix == ".csv" and "unique_record_id" in first,
                              f"{saved.name}, {saved.stat().st_size:,} bytes, header {first[:60]}")
                page.keyboard.press("Escape")

            with report.step("a record opens, shares and reopens from its URL") as check:
                search_for(page, "", scale, field_value="all")
                page.locator("#result-rows tr").first.click()
                page.wait_for_selector("#record-dialog[open]", timeout=SETTLE_MS * scale)
                page.wait_for_function("() => !/Loading/.test(document.querySelector('#record-title').textContent)",
                                       timeout=SETTLE_MS * scale)
                title = page.inner_text("#record-title")[:60]
                record_url = page.url
                page.goto(record_url, wait_until="load")
                page.wait_for_selector("#record-dialog[open]", timeout=READY_MS * scale)
                page.wait_for_function("() => !/Loading/.test(document.querySelector('#record-title').textContent)",
                                       timeout=SETTLE_MS * scale)
                check.require(page.inner_text("#record-title")[:60] == title,
                              f"{title} | {urlsplit(record_url).query[:80]}")

            with report.step("Back closes a record it opened") as check:
                page.go_back()
                page.wait_for_function("() => !document.querySelector('#record-dialog').open",
                                       timeout=SETTLE_MS * scale)
                check.require(not page.locator("#record-dialog[open]").count(),
                              f"record parameter: {parse_qs(urlsplit(page.url).query).get('record')}")

            with report.step("the results table is keyboard reachable") as check:
                reachable = page.evaluate("""() => {
                  const container = document.querySelector('#table-container');
                  const rows = document.querySelectorAll('#result-rows [tabindex="0"], #result-rows button, #result-rows a');
                  return {container: container.tabIndex, label: container.getAttribute('aria-label'), inRow: rows.length};
                }""")
                check.require(reachable["container"] >= 0 and reachable["inRow"] > 0, json.dumps(reachable))

            for name, viewport in (("desktop", DESKTOP), ("mobile", MOBILE)):
                page.set_viewport_size(viewport)
                page.wait_for_timeout(400)
                with report.step(f"{name}: no text under {MINIMUM_FONT_PX}px") as check:
                    tiny = page.evaluate(TINY_TEXT_JS, MINIMUM_FONT_PX)
                    check.require(not tiny, f"{len(tiny)} rules render smaller: {'; '.join(tiny)}" if tiny
                                            else f"every rendered text node is {MINIMUM_FONT_PX}px or larger")
                with report.step(f"{name}: no horizontal page overflow") as check:
                    overflow = page.evaluate(OVERFLOW_JS)
                    check.require(overflow["content"] <= overflow["viewport"] + 1,
                                  f"{overflow['content']}px content vs {overflow['viewport']}px viewport"
                                  + (f", from {overflow['responsible']}" if overflow["responsible"] else ""))

            with report.step("mobile: the filter panel toggles") as check:
                hidden = not page.locator("#filters-panel").is_visible()
                page.click("#toggle-filters")
                page.wait_for_timeout(400)
                check.require(hidden and page.locator("#filters-panel").is_visible(),
                              f"hidden first: {hidden}")

            with report.step("no page errors and no failed requests") as check:
                errors = [line for line in report.console if line.startswith("error")]
                check.require(not report.page_errors and not report.failed_requests and not errors,
                              f"{len(report.page_errors)} page errors, {len(report.failed_requests)} failed "
                              f"requests, {len(errors)} console errors, {len(report.console) - len(errors)} warnings"
                              + (f" | {report.page_errors + report.failed_requests + errors}" if
                                 report.page_errors or report.failed_requests or errors else ""))

            browser.close()
    finally:
        shutil.rmtree(downloads, ignore_errors=True)
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", help="Base URL of a served build, e.g. http://localhost:8777/")
    parser.add_argument("--dist", type=Path, default=Path(__file__).resolve().parents[1] / "dist",
                        help="The build the URL serves; its assets supply the expected values (default: ./dist).")
    parser.add_argument("--json", type=Path, help="Also write the report as JSON to this path.")
    parser.add_argument("--headed", action="store_true", help="Show the browser window.")
    parser.add_argument("--slow-factor", type=int, default=1, metavar="N",
                        help="Multiply every timeout by N, for a slow machine or a remote host (default: 1).")
    options = parser.parse_args(argv)
    if not options.dist.is_dir():
        print(f"--dist {options.dist} is not a directory.", file=sys.stderr)
        return 2
    report = run(options.url.rstrip("/") + "/", options.dist, options)
    report.write(sys.stdout)
    if options.json:
        options.json.write_text(json.dumps({
            "url": options.url, "dist": str(options.dist),
            "steps": [vars(step) for step in report.steps],
            "console": report.console, "pageErrors": report.page_errors,
            "failedRequests": report.failed_requests,
        }, indent=1), encoding="utf-8")
    return 1 if report.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
