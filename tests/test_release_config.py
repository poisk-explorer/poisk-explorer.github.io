"""Checks for the committed release pin and the release tool's pure helpers (no network)."""

import contextlib
import copy
import io
import json
from pathlib import Path
import importlib.util
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("poisk_release", ROOT / "scripts/release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
CONFIG = ROOT / "dataset.config.json"

# Trimmed capture of https://zenodo.org/api/records/21775623 (fetched 2026-10-24): only the
# fields the release tool reads. The published record carries 18 files; the two the tool opens are
# enough here. Values are the publisher's, so re-pinning the already pinned record must reproduce
# dataset.config.json exactly.
ZENODO_RECORD = {
    "doi": "10.5281/zenodo.21775623",
    "links": {"self": "https://zenodo.org/api/records/21775623", "self_html": "https://zenodo.org/records/21775623"},
    "files": [
        {"key": "poisk_dataset.csv", "size": 234128089, "checksum": "md5:f0c1f098abf1756e4b9891aa4dc028ee",
         "links": {"self": "https://zenodo.org/api/records/21775623/files/poisk_dataset.csv/content"}},
        {"key": "poisk_dataset_column_description.csv", "size": 5415, "checksum": "md5:24fffaa865572d6b7723d5ee7c153bdd",
         "links": {"self": "https://zenodo.org/api/records/21775623/files/poisk_dataset_column_description.csv/content"}},
    ],
    "metadata": {
        "title": "POISK: Patent-extracted Organization of Immunoglobulin Sequence Knowledge",
        "version": "1.1",
        "publication_date": "2026-10-23",
        "doi": "10.5281/zenodo.21775623",
        "license": {"id": "cc-by-4.0"},
        "creators": [
            {"name": "Tupikina, Daria"},
            {"name": "Roncoli, Andrea", "orcid": "0009-0002-9168-0031"},
            {"name": "Bujotzek, Alexander"},
            {"name": "Abanades, Brennan", "orcid": "0000-0001-8712-533X"},
        ],
    },
}


def run(function, *arguments):
    """Call a CLI entry point, returning its exit status and discarding its output."""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return function(*arguments)


class CommittedPinTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = json.loads(CONFIG.read_text(encoding="utf-8"))

    def write(self, config):
        path = self.root / "dataset.config.json"
        path.write_text(release.serialize(config), encoding="utf-8")
        return path

    def test_committed_configuration_passes_every_check(self):
        self.assertEqual(release.config_problems(release.builder.load_config(CONFIG)), [])
        self.assertEqual(run(release.run_check, CONFIG), 0)

    def test_record_ids_must_agree_across_links_and_doi(self):
        for key, value in (("recordUrl", "https://zenodo.org/records/19730684"),
                           ("downloadUrl", "https://zenodo.org/records/1/files/poisk_dataset.csv?download=1"),
                           ("doi", "10.5281/zenodo.00000000")):
            config = copy.deepcopy(self.config)
            config["dataset"][key] = value
            with self.subTest(key=key):
                self.assertIn("record ids disagree", " ".join(release.config_problems(config)))
                self.assertEqual(run(release.run_check, self.write(config)), 1)

    def test_the_markup_fallback_links_must_name_the_pinned_record(self):
        """web/index.html hard-codes the record for the no-JS and failed-fetch paths."""
        markup = ROOT / "web/index.html"
        self.assertEqual(release.markup_problems(self.config, markup), [])
        # Derived from the committed pin, so re-pointing the release cannot turn the replace below
        # into a no-op that leaves this test asserting against an unmodified file.
        pinned = release.record_id(self.config["dataset"]["doi"])
        stale = self.root / "index.html"
        stale.write_text(markup.read_text(encoding="utf-8").replace(f"zenodo.org/records/{pinned}",
                                                                    "zenodo.org/records/19730684"), encoding="utf-8")
        self.assertNotIn(pinned, stale.read_text(encoding="utf-8"), "the replace must actually stale the markup")
        problems = release.markup_problems(self.config, stale)
        self.assertIn(f"links Zenodo record(s) 19730684 but the pin is {pinned}", " ".join(problems))
        # A draft config with no doi and no record url has nothing to compare against.
        draft = copy.deepcopy(self.config)
        draft["dataset"].update(doi="", recordUrl="", downloadUrl="")
        draft["source"]["url"] = "https://example.org/revised.csv"
        self.assertEqual(release.markup_problems(draft, stale), [])

    def test_a_repin_retargets_the_hardcoded_fallback_links(self):
        """--zenodo-record must not leave web/index.html pointing at the previous release."""
        markup = (ROOT / "web/index.html").read_text(encoding="utf-8")
        old_url = self.config["dataset"]["downloadUrl"]
        # Both halves come from the committed pin: neither a new record id nor a renamed CSV may
        # turn this fake "next release" into a no-op the assertions below would still pass on.
        old_id, old_file = release.record_id(old_url), release.file_key_of(old_url)
        new_url = old_url.replace(old_id, "20110022").replace(old_file, "poisk_dataset_v2.csv")
        moved = release.retarget_markup(markup, old_url, new_url)
        self.assertNotIn(old_id, moved)
        self.assertNotIn(old_file, moved)
        self.assertIn("zenodo.org/records/20110022", moved)
        self.assertIn("/files/poisk_dataset_v2.csv", moved)
        # Same release in, same bytes out, so a no-op re-pin never rewrites the file.
        self.assertEqual(release.retarget_markup(markup, old_url, old_url), markup)
        # And the retargeted markup is what --check wants for the new pin.
        repinned = copy.deepcopy(self.config)
        repinned["dataset"].update(doi="10.5281/zenodo.20110022",
                                   recordUrl="https://zenodo.org/records/20110022", downloadUrl=new_url)
        repinned["source"]["url"] = new_url
        stale = self.root / "stale.html"
        stale.write_text(markup, encoding="utf-8")
        fresh = self.root / "fresh.html"
        fresh.write_text(moved, encoding="utf-8")
        self.assertEqual(release.markup_problems(repinned, fresh), [])
        self.assertEqual(len(release.markup_problems(repinned, stale)), 2, "stale record id and file name")

    def test_a_non_zenodo_record_url_is_reported(self):
        config = copy.deepcopy(self.config)
        config["dataset"]["recordUrl"] = "https://example.org/dataset"
        self.assertIn("No Zenodo record id in dataset.recordUrl.", release.config_problems(config))

    def test_version_and_doi_must_appear_in_the_citation(self):
        for key, value, expected in (("version", "2.0.0", "dataset.version"), ("doi", "10.5281/zenodo.19883049x", "dataset.doi")):
            config = copy.deepcopy(self.config)
            config["dataset"][key] = value
            with self.subTest(key=key):
                self.assertIn(f"{expected} {value!r} does not appear in dataset.citation.", release.config_problems(config))

    def test_a_published_release_must_name_its_license(self):
        for value in ("", "   ", None):
            config = copy.deepcopy(self.config)
            config["dataset"]["license"] = value
            with self.subTest(value=value):
                self.assertIn("dataset.license must name the published license whenever dataset.doi is set.",
                              release.config_problems(config))

    def test_a_malformed_checksum_is_reported(self):
        config = copy.deepcopy(self.config)
        config["source"]["checksum"] = "md5:not-a-digest"
        self.assertIn("source.checksum must be md5:<hex> or sha256:<hex>.", release.config_problems(config))

    def test_a_configuration_the_builder_rejects_fails_the_check(self):
        config = copy.deepcopy(self.config)
        config["schemaVersion"] = 2
        self.assertEqual(run(release.run_check, self.write(config)), 1)


class ZenodoResponseTests(unittest.TestCase):
    def test_repinning_the_pinned_record_changes_nothing(self):
        committed = json.loads(CONFIG.read_text(encoding="utf-8"))
        updated = release.config_from_record(committed, ZENODO_RECORD, "21775623", "poisk_dataset.csv")
        self.assertEqual(release.serialize(updated), CONFIG.read_text(encoding="utf-8"))

    def test_citation_matches_the_published_wording(self):
        metadata = ZENODO_RECORD["metadata"]
        citation = release.build_citation(metadata["creators"], release.publication_year(metadata),
                                         metadata["title"], metadata["version"], ZENODO_RECORD["doi"])
        self.assertEqual(citation, json.loads(CONFIG.read_text(encoding="utf-8"))["dataset"]["citation"])

    def test_author_initials(self):
        for name, expected in (("Tupikina, Daria", "Tupikina, D."), ("Abanades, Brennan", "Abanades, B."),
                               ("Doe, Ada Jane", "Doe, A. J."), ("Doe, Jean-Luc", "Doe, J.-L."),
                               ("Mononym", "Mononym")):
            with self.subTest(name=name):
                self.assertEqual(release.abbreviate(name), expected)

    def test_single_and_paired_authors_keep_the_ampersand_rule(self):
        self.assertEqual(release.citation_authors([{"name": "Doe, Ada"}]), "Doe, A.")
        self.assertEqual(release.citation_authors([{"name": "Doe, Ada"}, {"name": "Roe, Bo"}]), "Doe, A., & Roe, B.")

    def test_license_labels_are_never_invented(self):
        self.assertEqual(release.license_label(ZENODO_RECORD["metadata"]), "CC BY 4.0")
        self.assertEqual(release.license_label({"license": "CC-BY-4.0"}), "CC BY 4.0")
        for metadata, message in (({}, "no metadata.license.id"), ({"license": {"id": "roche-internal"}}, "Unknown Zenodo license id")):
            with self.subTest(metadata=metadata), self.assertRaisesRegex(release.ReleaseError, message):
                release.license_label(metadata)

    def test_record_id_extraction(self):
        for value, expected in (
            ("https://zenodo.org/records/19883049", "19883049"),
            ("https://zenodo.org/records/19883049/files/poisk_dataset.csv?download=1", "19883049"),
            ("https://zenodo.org/record/19883049", "19883049"),
            ("10.5281/zenodo.19883049", "19883049"),
            ("https://doi.org/10.5281/zenodo.19730684", "19730684"),
            ("https://example.org/dataset.csv", None),
            ("", None),
            (None, None),
        ):
            with self.subTest(value=value):
                self.assertEqual(release.record_id(value), expected)

    def test_a_missing_or_inconsistent_record_is_rejected(self):
        committed = json.loads(CONFIG.read_text(encoding="utf-8"))
        cases = {
            "no file named": ("poisk_dataset.csv", {"files": [{"key": "other.csv", "checksum": "md5:" + "0" * 32}]}),
            "reports no usable DOI": ("poisk_dataset.csv", {"doi": "", "metadata": dict(ZENODO_RECORD["metadata"], doi="")}),
            "reports no metadata.version": ("poisk_dataset.csv", {"metadata": dict(ZENODO_RECORD["metadata"], version="")}),
        }
        for message, (file_key, override) in cases.items():
            record = dict(copy.deepcopy(ZENODO_RECORD), **override)
            with self.subTest(message=message), self.assertRaisesRegex(release.ReleaseError, message):
                release.config_from_record(committed, record, "21775623", file_key)
        with self.assertRaisesRegex(release.ReleaseError, "does not belong to Zenodo record"):
            release.config_from_record(committed, copy.deepcopy(ZENODO_RECORD), "19730684", "poisk_dataset.csv")

    def test_the_committed_download_url_shape_is_preserved(self):
        entry = ZENODO_RECORD["files"][0]
        committed = "https://zenodo.org/records/19883049/files/poisk_dataset.csv?download=1"
        self.assertEqual(release.source_url("19999999", entry, committed),
                         "https://zenodo.org/records/19999999/files/poisk_dataset.csv?download=1")
        # Any other committed shape falls back to the API link the record itself reports.
        self.assertEqual(release.source_url("19883049", entry, "https://example.org/poisk.csv"),
                         entry["links"]["self"])


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "revised.csv"
        self.source.write_text("unique_record_id\n000000\n", encoding="utf-8")
        self.output = self.root / "preview.config.json"

    def test_preview_blanks_publication_links_and_pins_the_local_digest(self):
        # run_preview derives the label from the committed version, so read it rather than pin it.
        draft = json.loads(CONFIG.read_text(encoding="utf-8"))["dataset"]["version"] + "-draft"
        self.assertEqual(run(release.run_preview, CONFIG, self.source, self.output, None), 0)
        preview = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(preview["source"]["checksum"], "md5:" + release.file_md5(self.source))
        self.assertEqual(preview["dataset"]["version"], draft)
        self.assertEqual([preview["dataset"][key] for key in ("doi", "recordUrl", "downloadUrl")], ["", "", ""])
        self.assertIn(f"(Version {draft})", preview["dataset"]["citation"])
        self.assertNotIn("doi.org", preview["dataset"]["citation"])
        self.assertEqual(release.config_problems(release.builder.load_config(self.output)), [])

    def test_preview_accepts_an_explicit_label(self):
        run(release.run_preview, CONFIG, self.source, self.output, "1.1.0-rc1")
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8"))["dataset"]["version"], "1.1.0-rc1")

    def test_preview_refuses_to_write_inside_the_repository(self):
        with self.assertRaisesRegex(release.ReleaseError, "must live outside"):
            release.run_preview(CONFIG, self.source, ROOT / "preview.config.json", None)

    def test_preview_requires_an_existing_source(self):
        with self.assertRaisesRegex(release.ReleaseError, "needs --source"):
            release.run_preview(CONFIG, None, self.output, None)
        with self.assertRaisesRegex(release.ReleaseError, "not a file"):
            release.run_preview(CONFIG, self.root / "absent.csv", self.output, None)


if __name__ == "__main__":
    unittest.main()
