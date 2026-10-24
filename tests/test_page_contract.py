"""Cross-file consistency checks for the page contract: markup, app.js, search-core.js, build.py.

The dataset's field names are duplicated across independent lists that nothing tied together --
scripts/build.py's SEARCH_FIELDS / FLAG_FIELDS / FACET_FIELDS, web/search-core.js's
TEXT_SEARCH_FIELDS, and web/app.js's FACETS / PRESENCE / searchableFields / sortableFields /
TABLE_FIELDS -- plus the element ids and data-* attributes web/index.html and web/app.js share.
web/app.js is the majority of the browser code and is imported by no other test, so a renamed
field used to ship green while a whole column degraded to "Not reported" (the removal of
has_sequence left an <input data-presence="has_sequence"> that filtered nothing).

These checks parse the three web files as text and import build.py the way tests/test_build.py
does: stdlib only, no node and no browser, so they run in CI with the rest of the Python suite.
They assert agreement between files, never the contents of one list -- tests/test_build.py owns
the column literals. Every failure message names BOTH places that disagree.
"""

import importlib.util
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("poisk_build", ROOT / "scripts/build.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)

WEB = ROOT / "web"
APP = "web/app.js"
CORE = "web/search-core.js"
MARKUP = "web/index.html"
STYLES = "web/styles.css"
BUILD = "scripts/build.py"
APP_SOURCE = (WEB / "app.js").read_text(encoding="utf-8")
CORE_SOURCE = (WEB / "search-core.js").read_text(encoding="utf-8")
HTML_SOURCE = (WEB / "index.html").read_text(encoding="utf-8")
STYLES_SOURCE = (WEB / "styles.css").read_text(encoding="utf-8")

INDEX_FIELDS = builder.SEARCH_FIELDS + builder.FLAG_FIELDS
# Both $() and $$() in app.js, and getElementById, in single, double or template quotes. The id
# is the leading selector of a possibly compound selector ("#loading-state strong").
QUERIED_ID = re.compile(r"""\$\(\s*['"`]#([A-Za-z0-9_-]+)|getElementById\(\s*['"`]([A-Za-z0-9_-]+)""")
STRING = re.compile(r"'([^'\\\n]*)'")
LABELLED_PAIR = re.compile(r"\[\s*'([^']+)'\s*,\s*'([^']*)'\s*\]")
OBJECT_KEY = re.compile(r"([A-Za-z_$][\w$]*)\s*:")
BRACKETS = {"[": "]", "{": "}", "(": ")"}
# Attributes whose value is a space-separated list of ids the browser must be able to resolve.
ID_REFERENCES = ("aria-labelledby", "aria-controls", "aria-describedby", "list")
# The audit verdict vocabulary is written out three times with nothing tying the copies together:
# the branches of auditBadge, the badge rules in the stylesheet, and the guide paragraph that
# explains the words to a reader. Release 1.1 replaced CONTRADICTED and NOT_FOUND with REVIEW, and
# the prose kept naming the retired pair -- no test read it, so the wrong explanation shipped green.
# Nothing here pins the vocabulary itself: it is read out of auditBadge, and the other two must agree.
AUDIT_BADGE = "function auditBadge(verdict) {"
EVIDENCE_HEADING = "<h3>Read the evidence</h3>"
VERDICT_COMPARISON = re.compile(r"normalized\s*[!=]==\s*'([A-Z_]+)'")
BADGE_CLASS_ADDED = re.compile(r"classList\.add\('([a-z-]+)'\)")
BADGE_RULE = re.compile(r"\.audit-badge\.([a-z-]+)\{")
# Both sides are read with their comments stripped. Parking a branch or a rule behind a comment
# is the ordinary way to disable one, and a disabled badge is exactly what these tests exist to
# catch: a class with no rule renders in the base green, so an unreviewed record would read as a
# confirmed one. (A rule re-scoped under a parent selector or into an at-rule would still slip
# past BADGE_RULE; that needs a selector walk, and nothing in this stylesheet nests badge rules.)
JS_COMMENT = re.compile(r"//[^\n]*|/\*.*?\*/", re.S)
CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
# A verdict is an all-caps word; the guide's ordinary prose around it is not.
SHOUTED_WORD = re.compile(r"\b[A-Z][A-Z_]{2,}\b")


def skip_string(text: str, start: int) -> int:
    """The index just past the string literal opening at `start`."""
    quote, cursor = text[start], start + 1
    while cursor < len(text):
        if text[cursor] == "\\":
            cursor += 2
            continue
        if text[cursor] == quote:
            return cursor + 1
        cursor += 1
    raise AssertionError(f"Unterminated {quote} string literal at offset {start}.")


def bracket_block(text: str, declaration: str, where: str) -> str:
    """The source inside the bracket that `declaration` ends with, up to its match.

    Strings and comments are skipped so an apostrophe or a bracket inside either cannot throw
    the scan off. A literal `declaration` keeps the failure readable when the constant is
    renamed: the test names the file and the text it looked for.
    """
    position = text.find(declaration)
    if position < 0:
        raise AssertionError(f"{where} no longer contains `{declaration}`; update this test with it.")
    position += len(declaration) - 1
    depth, cursor = 0, position
    while cursor < len(text):
        character = text[cursor]
        if character in "\"'`":
            cursor = skip_string(text, cursor)
            continue
        if text.startswith("//", cursor):
            end = text.find("\n", cursor)
            cursor = len(text) if end < 0 else end + 1
            continue
        if text.startswith("/*", cursor):
            end = text.find("*/", cursor)
            cursor = len(text) if end < 0 else end + 2
            continue
        if character in BRACKETS:
            depth += 1
        elif character in BRACKETS.values():
            depth -= 1
            if depth == 0:
                return text[position + 1:cursor]
        cursor += 1
    raise AssertionError(f"{where}: `{declaration}` is never closed.")


def const_string(text: str, name: str, where: str) -> str:
    match = re.search(rf"const {re.escape(name)} = '([^']*)'", text)
    if match is None:
        raise AssertionError(f"{where} no longer declares `const {name} = '...'`; update this test with it.")
    return match.group(1)


def paragraph_after(text: str, heading: str, where: str) -> str:
    """The <p> that follows `heading`. A literal heading keeps the failure readable if it moves."""
    start = text.find(heading)
    if start < 0:
        raise AssertionError(f"{where} no longer contains `{heading}`; update this test with it.")
    start += len(heading)
    end = text.find("</p>", start)
    if end < 0:
        raise AssertionError(f"{where}: the paragraph after `{heading}` is never closed.")
    return text[start:end]


def resolve_list(block: str, constants: dict[str, object], where: str) -> list[str]:
    """A flat JS array of string literals, `...SPREADS` and bare const references, resolved."""
    values: list[str] = []
    for element in (part.strip() for part in block.split(",")):
        if not element:
            continue
        literal = STRING.fullmatch(element)
        if literal:
            values.append(literal.group(1))
            continue
        name = element[3:].strip() if element.startswith("...") else element
        if name not in constants:
            raise AssertionError(f"{where}: cannot resolve `{element}`; this test only knows {sorted(constants)}.")
        resolved = constants[name]
        values.extend(resolved if element.startswith("...") else [resolved])
    return values


class Markup(HTMLParser):
    """Tags, attributes, ids and select options as a browser sees them -- comments excluded."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags: list[tuple[str, dict[str, str]]] = []
        self.ids: list[str] = []
        self.options: dict[str, list[str]] = {}
        self.select = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        self.tags.append((tag, attributes))
        if "id" in attributes:
            self.ids.append(attributes["id"])
        if tag == "select":
            self.select = attributes.get("id", "")
            self.options.setdefault(self.select, [])
        elif tag == "option" and self.select is not None:
            self.options[self.select].append(attributes.get("value", ""))

    def handle_endtag(self, tag):
        if tag == "select":
            self.select = None

    def attribute_values(self, attribute: str, tag: str | None = None) -> list[str]:
        """Every non-empty value of `attribute`, optionally only on `tag`, in document order."""
        return [values[attribute] for name, values in self.tags
                if values.get(attribute) and tag in (None, name)]


class PageContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = Markup()
        cls.html.feed(HTML_SOURCE)
        cls.html.close()
        cls.queried_ids = {first or second for first, second in QUERIED_ID.findall(APP_SOURCE)}
        cls.text_search_fields = STRING.findall(
            bracket_block(CORE_SOURCE, "export const TEXT_SEARCH_FIELDS = Object.freeze([", CORE))
        cls.facets = [field for field, _ in
                      LABELLED_PAIR.findall(bracket_block(APP_SOURCE, "const FACETS = [", APP))]
        presence = bracket_block(APP_SOURCE, "const PRESENCE = {", APP)
        cls.presence = OBJECT_KEY.findall(STRING.sub("''", presence))
        cls.sequence_field = const_string(APP_SOURCE, "SEQUENCE_FIELD", APP)
        cls.sortable_fields = STRING.findall(bracket_block(APP_SOURCE, "const sortableFields = [", APP))
        cls.table_fields = STRING.findall(bracket_block(APP_SOURCE, "const TABLE_FIELDS = [", APP))
        cls.searchable_fields = resolve_list(
            bracket_block(APP_SOURCE, "const searchableFields = [", APP),
            {"TEXT_SEARCH_FIELDS": cls.text_search_fields, "SEQUENCE_FIELD": cls.sequence_field},
            f"{APP} searchableFields")
        badge = JS_COMMENT.sub(" ", bracket_block(APP_SOURCE, AUDIT_BADGE, APP))
        # CONFIRMED is compared with !== and styled by the base rule, so it is a verdict without
        # a class of its own; the fallback class is added without being compared against a word.
        cls.badge_verdicts = VERDICT_COMPARISON.findall(badge)
        cls.badge_classes = BADGE_CLASS_ADDED.findall(badge)
        cls.evidence_verdicts = SHOUTED_WORD.findall(
            paragraph_after(HTML_SOURCE, EVIDENCE_HEADING, MARKUP))

    def assertSubset(self, values, allowed, subject, holder):
        """`subject` must be covered by `holder`; the message names both sides and the gap."""
        unknown = [value for value in dict.fromkeys(values) if value not in allowed]
        self.assertEqual(unknown, [], f"{subject} is not in {holder}: {unknown}. "
                                      f"{holder} holds {sorted(allowed)}.")

    def assertSameSet(self, left, right, left_name, right_name):
        missing = sorted(set(right) - set(left))
        extra = sorted(set(left) - set(right))
        self.assertEqual((missing, extra), ([], []),
                         f"{left_name} and {right_name} disagree. "
                         f"In {right_name} only: {missing}. In {left_name} only: {extra}.")

    def test_every_id_app_js_queries_exists_in_the_markup(self):
        present = set(self.html.ids)
        self.assertTrue(self.queried_ids, f"No `$('#id')` calls were found in {APP}; the test regex is stale.")
        missing = sorted(self.queried_ids - present)
        self.assertEqual(missing, [], f"{APP} queries ids that {MARKUP} does not define: {missing}. "
                                      f"Either add the element or drop the query.")

    def test_ids_are_unique_in_the_markup(self):
        seen, duplicated = set(), []
        for identifier in self.html.ids:
            if identifier in seen:
                duplicated.append(identifier)
            seen.add(identifier)
        queried = sorted(set(duplicated) & self.queried_ids)
        self.assertEqual(duplicated, [], f"{MARKUP} defines the same id twice: {sorted(set(duplicated))}. "
                                         f"querySelector returns only the first, and {APP} queries "
                                         f"{queried or 'none'} of them.")

    def test_local_assets_referenced_by_the_markup_exist(self):
        references = self.html.attribute_values("href") + self.html.attribute_values("src")
        local = [value for value in references if value.startswith("./")]
        self.assertTrue(local, f"{MARKUP} references no local assets; the test is reading the wrong file.")
        for reference in local:
            with self.subTest(reference=reference):
                path = reference.split("?")[0].split("#")[0]
                target = (WEB / path).resolve()
                self.assertTrue(target.is_dir() if path.endswith("/") else target.is_file(),
                                f"{MARKUP} references {reference}, which is not in {WEB}/. "
                                f"build.py copies web/ verbatim, so the built site would 404.")

    def test_fragment_and_aria_references_resolve_to_an_id(self):
        present = set(self.html.ids)
        referenced: list[tuple[str, str]] = []
        for attribute in ID_REFERENCES:
            for value in self.html.attribute_values(attribute):
                referenced += [(attribute, token) for token in value.split()]
        referenced += [("for", value) for value in self.html.attribute_values("for", "label")]
        referenced += [("href", value[1:]) for value in self.html.attribute_values("href")
                       if value.startswith("#") and len(value) > 1]
        unresolved = sorted({f'{attribute}="{token}"' for attribute, token in referenced
                             if token not in present})
        self.assertEqual(unresolved, [], f"{MARKUP} points at ids it does not define: {unresolved}. "
                                         f"An unresolved aria reference is dropped by the accessibility "
                                         f"tree and an unresolved fragment link goes nowhere.")

    def test_sortable_columns_are_sortable_and_indexed(self):
        columns = self.html.attribute_values("data-sort", "th")
        self.assertTrue(columns, f"{MARKUP} has no th[data-sort]; the results table lost its sort controls.")
        self.assertSubset(columns, self.sortable_fields,
                          f'{MARKUP} th[data-sort]', f"{APP} sortableFields")
        self.assertSubset(columns, INDEX_FIELDS,
                          f'{MARKUP} th[data-sort]', f"{BUILD} SEARCH_FIELDS + FLAG_FIELDS")
        # 'source' is the unsorted dataset order, not a column.
        self.assertSubset([field for field in self.sortable_fields if field != "source"], INDEX_FIELDS,
                          f"{APP} sortableFields", f"{BUILD} SEARCH_FIELDS + FLAG_FIELDS")

    def test_presence_checkboxes_match_the_build_flag_fields(self):
        checkboxes = self.html.attribute_values("data-presence")
        self.assertSameSet(checkboxes, builder.FLAG_FIELDS,
                           f"{MARKUP} data-presence", f"{BUILD} FLAG_FIELDS")
        self.assertSameSet(self.presence, builder.FLAG_FIELDS,
                           f"{APP} PRESENCE", f"{BUILD} FLAG_FIELDS")

    def test_app_facets_match_the_build_facet_fields(self):
        # Set comparison: the order of FACETS is the rendered panel order and is a UI decision,
        # while the order of FACET_FIELDS only affects facets.json key order.
        self.assertSameSet(self.facets, builder.FACET_FIELDS,
                           f"{APP} FACETS", f"{BUILD} FACET_FIELDS")
        # A facet is applied as an equality filter on a search-index column, so a facet field
        # that is not indexed renders a control that cannot filter.
        self.assertSubset(builder.FACET_FIELDS, builder.SEARCH_FIELDS,
                          f"{BUILD} FACET_FIELDS", f"{BUILD} SEARCH_FIELDS")

    def test_searchable_fields_match_the_engine_text_fields(self):
        self.assertIn("all", self.searchable_fields,
                      f"{APP} searchableFields dropped 'all', which {MARKUP} offers as the default option.")
        offered = [field for field in self.searchable_fields
                   if field not in ("all", self.sequence_field)]
        self.assertSameSet(offered, self.text_search_fields,
                           f"{APP} searchableFields", f"{CORE} TEXT_SEARCH_FIELDS")
        self.assertSubset(self.text_search_fields, INDEX_FIELDS,
                          f"{CORE} TEXT_SEARCH_FIELDS", f"{BUILD} SEARCH_FIELDS + FLAG_FIELDS")

    def test_search_field_options_are_offered_by_the_engine(self):
        options = self.html.options.get("search-field")
        self.assertIsNotNone(options, f"{MARKUP} has no <select id=\"search-field\">, which {APP} reads.")
        allowed = {"all", self.sequence_field, *self.text_search_fields}
        self.assertSubset(options, allowed, f'{MARKUP} #search-field option values',
                          f"{CORE} TEXT_SEARCH_FIELDS plus 'all' and {APP} SEQUENCE_FIELD")

    def test_the_guide_explains_exactly_the_verdicts_the_badge_branches_on(self):
        self.assertTrue(self.badge_verdicts,
                        f"{APP} `{AUDIT_BADGE}` compares against no verdict word; the test regex is stale.")
        self.assertSameSet(self.evidence_verdicts, self.badge_verdicts,
                           f'{MARKUP} "{EVIDENCE_HEADING}" paragraph', f"{APP} auditBadge")

    def test_every_badge_class_app_js_adds_is_styled(self):
        self.assertTrue(self.badge_classes,
                        f"{APP} `{AUDIT_BADGE}` adds no badge class; the test regex is stale.")
        # A class with no rule renders in the base colour, so an unreviewed verdict would read as
        # a confirmed one -- the one way this badge must never fail.
        self.assertSameSet(BADGE_RULE.findall(CSS_COMMENT.sub(" ", STYLES_SOURCE)), self.badge_classes,
                           f"{STYLES} .audit-badge rules", f"{APP} auditBadge classList.add")

    def test_table_columns_are_index_columns(self):
        # app.js fails the whole page with "Search metadata does not match the release" when a
        # TABLE_FIELDS entry is absent from manifest.index.fields.
        self.assertSubset(self.table_fields, INDEX_FIELDS,
                          f"{APP} TABLE_FIELDS", f"{BUILD} SEARCH_FIELDS + FLAG_FIELDS")


if __name__ == "__main__":
    unittest.main()
