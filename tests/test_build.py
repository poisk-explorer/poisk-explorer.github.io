"""Fixture-based checks for publication integrity and the browser data contract."""

import contextlib
import copy
import csv
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.error import URLError
from urllib.parse import urljoin
from urllib.request import Request


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("poisk_build", ROOT / "scripts/build.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)

# The 47 columns of the pinned release, in release order (dist/data/manifest.json "fields").
# Kept as a literal so a reordered or renamed source column is a test failure, not a silent change.
RELEASE_HEADER = [
    "unique_record_id",
    "patent_id",
    "antibody_identifier",
    "antibody_type",
    "antibody_discovery_status",
    "vh.seq_id",
    "vh.is_full_heavy_chain",
    "vh.sequence_from_patent",
    "vl.seq_id",
    "vl.is_full_light_chain",
    "vl.sequence_from_patent",
    "similar_antibody_seq_ids",
    "discovery_methodology.cdr_modified",
    "discovery_methodology.source_organism",
    "discovery_methodology.specific_platform",
    "discovery_methodology.strategies",
    "target.organism",
    "target.target_type",
    "target.protein_name",
    "target.gene_names",
    "target.uniprot_id",
    "target.seq_id",
    "target.sequence_from_patent",
    "target.domain_start",
    "target.domain_end",
    "target.domain_coordinates",
    "target.binding_components",
    "target.binding_affinity.affinity_value",
    "target.binding_affinity.method",
    "target.binding_conditions",
    "epitope.type",
    "epitope.linear_epitope_range.start",
    "epitope.linear_epitope_range.end",
    "epitope.structural_contact_residues",
    "epitope.antigenic_site_name",
    "epitope.binning_competitors",
    "epitope.evidence_types",
    "epitope.functional_properties",
    "epitope.ligand_receptor_competition",
    "epitope.mutagenesis_residues",
    "epitope.variants",
    "audit.verdict",
    "audit.flags",
    "audit.reasoning",
    "target.sequence_accession",
    "target.sequence_from_uniprot",
    "target.sequence",
]
VH_SEQUENCE = "EVQLVESGGGLVQPGGSLRLSCAAS"
VH_SEQUENCE_KEY = "2791bb0c6cf28767"  # fnv1a64 of VH_SEQUENCE; a hash change must break this test.
VL_SEQUENCE = "DIQMTQSPSSLSASVGDRVTITC"
SHORT_SEQUENCE = "QVQLVQSGAEVKKPGAS"  # 17 characters: meaningful text, but not an indexable sequence.


class FakeResponse(io.BytesIO):
    """Enough of an http response for download_source; keeps every test off the network."""

    def __init__(self, payload, url):
        super().__init__(payload)
        self.url = url

    def geturl(self):
        return self.url

    def __enter__(self):
        return self

    def __exit__(self, *details):
        self.close()
        return False


class FakeOpener:
    def __init__(self, payload, url):
        self.payload, self.url = payload, url

    def open(self, request, timeout=None):
        return FakeResponse(self.payload, self.url)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.csv"
        self.output = self.root / "dist"
        self.web = self.root / "web"
        self.web.mkdir()
        (self.web / "index.html").write_text("<!doctype html><title>Fixture</title>")
        self.fields = builder.SEARCH_FIELDS + builder.SEQUENCE_FIELDS + ["epitope.antigenic_site_name", "audit.reasoning"]
        self.config = json.loads((ROOT / "dataset.config.json").read_text())
        self.config["chunkSize"] = 2

    def row(self, record_id="000001", **values):
        record = {field: "" for field in self.fields}
        record.update(unique_record_id=record_id, patent_id="001234", antibody_type="Conventional")
        record.update(values)
        return [record[field] for field in self.fields]

    def write_csv(self, rows, fields=None):
        with self.source.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(self.fields if fields is None else fields)
            writer.writerows(rows)
        self.pin_checksum()

    def pin_checksum(self):
        self.config["source"]["checksum"] = "md5:" + hashlib.md5(self.source.read_bytes()).hexdigest()

    def build(self, **options):
        return builder.build(self.source, self.output, self.config, self.web, **options)

    def read_asset(self, manifest, key):
        return json.loads((self.output / manifest[key]["url"]).read_text())

    def write_config(self, config):
        path = self.root / "config.json"
        path.write_text(json.dumps(config))
        return path

    def test_round_trip_chunks_facets_flags_and_gzip(self):
        text = 'Evidence with commas, "quotes", café and\nmultiple lines.'
        rows = [
            self.row(**{"antibody_identifier": "A, B", "audit.reasoning": text,
                        "epitope.type": "Not Specified", "epitope.antigenic_site_name": "site A",
                        "target.binding_affinity.affinity_value": "N/A", "vh.sequence_from_patent": "EVQL"}),
            self.row("000002", **{"antibody_type": "", "epitope.type": "NOT_SPECIFIED",
                                    "epitope.antigenic_site_name": "None", "target.binding_affinity.affinity_value": "0",
                                    "vh.sequence_from_patent": "NULL", "vl.sequence_from_patent": "N/A"}),
            self.row("000003", **{"patent_id": "009876", "epitope.type": "linear"}),
        ]
        self.write_csv(rows)
        manifest = self.build()
        self.assertEqual(manifest["counts"], {"records": 3, "patents": 2, "sequences": 0,
                                              "chainCells": 1, "nonStandardChainCells": 0})
        self.assertEqual(manifest["fields"], self.fields)
        self.assertEqual(manifest["sourceChecksum"], self.config["source"]["checksum"])
        index = self.read_asset(manifest, "index")
        self.assertEqual(index["fields"], builder.SEARCH_FIELDS + builder.FLAG_FIELDS)
        # has_epitope, has_affinity, has_vh, has_vl: "EVQL" is meaningful text even if too short to index.
        self.assertEqual([row[-4:] for row in index["rows"]],
                         [[True, False, True, False], [False, True, False, False], [True, False, False, False]])
        self.assertEqual(index["rows"][0][:3], ["000001", "001234", "A, B"])
        first = json.loads((self.output / manifest["details"]["pattern"].format(chunk=0)).read_text())
        second = json.loads((self.output / manifest["details"]["pattern"].format(chunk=1)).read_text())
        self.assertEqual(first, {"start": 0, "rows": rows[:2]})
        self.assertEqual(second, {"start": 2, "rows": rows[2:]})
        self.assertEqual(self.read_asset(manifest, "facets")["fields"]["antibody_type"], [
            {"value": "Conventional", "label": "Conventional", "count": 2},
            {"value": "", "label": "Not reported", "count": 1},
        ])
        for path in (self.output / "data").rglob("*.json"):
            self.assertEqual(gzip.decompress(path.with_suffix(".json.gz").read_bytes()), path.read_bytes())
        prior_gzip = (self.output / manifest["index"]["gzipUrl"]).read_bytes()
        self.build()
        self.assertEqual((self.output / manifest["index"]["gzipUrl"]).read_bytes(), prior_gzip)
        self.assertTrue((self.output / "index.html").is_file())
        self.assertTrue((self.output / ".nojekyll").is_file())

    def test_release_header_maps_to_index_fields_by_name(self):
        self.fields = list(RELEASE_HEADER)
        # A distinct, meaningful value per column proves the index reads the column it names.
        record = {field: f"{position:02d} {field} value" for position, field in enumerate(RELEASE_HEADER)}
        record["unique_record_id"] = "000001"
        record["vh.sequence_from_patent"] = VH_SEQUENCE
        record["vl.sequence_from_patent"] = VL_SEQUENCE
        self.assertEqual(len(set(record.values())), len(RELEASE_HEADER))
        self.write_csv([[record[field] for field in RELEASE_HEADER]])
        manifest = self.build()
        self.assertEqual(manifest["fields"], RELEASE_HEADER)
        index = self.read_asset(manifest, "index")
        expected = {field: record[field] for field in builder.SEARCH_FIELDS}
        expected.update(has_epitope=True, has_affinity=True, has_vh=True, has_vl=True)
        self.assertEqual(dict(zip(manifest["index"]["fields"], index["rows"][0])), expected)

    def test_facet_values_sharing_a_count_sort_by_case_then_raw_text(self):
        antibody_types = ["alpha", "ALPHA", "Alpha", "beta", "beta"]
        epitope_types = ["linear", "LINEAR", "Linear", "", ""]
        self.write_csv([
            self.row(f"{number:06d}", antibody_type=antibody_type, **{"epitope.type": epitope_type})
            for number, (antibody_type, epitope_type) in enumerate(zip(antibody_types, epitope_types), start=1)
        ])
        facets = self.read_asset(self.build(), "facets")["fields"]
        self.assertEqual(facets["antibody_type"], [
            {"value": "beta", "label": "beta", "count": 2},
            {"value": "ALPHA", "label": "ALPHA", "count": 1},
            {"value": "Alpha", "label": "Alpha", "count": 1},
            {"value": "alpha", "label": "alpha", "count": 1},
        ])
        self.assertEqual(facets["epitope.type"], [
            {"value": "", "label": "Not reported", "count": 2},
            {"value": "LINEAR", "label": "LINEAR", "count": 1},
            {"value": "Linear", "label": "Linear", "count": 1},
            {"value": "linear", "label": "linear", "count": 1},
        ])

    def test_facets_are_a_separate_asset_referenced_by_the_manifest(self):
        self.write_csv([self.row()])
        manifest = self.build()
        self.assertEqual(set(manifest["facets"]), {"url", "gzipUrl"})
        self.assertTrue(manifest["facets"]["url"].endswith("/facets.json"))
        self.assertEqual(manifest["facets"]["gzipUrl"], manifest["facets"]["url"] + ".gz")
        facets = self.read_asset(manifest, "facets")
        self.assertEqual(sorted(facets["fields"]), sorted(builder.FACET_FIELDS))
        self.assertEqual(manifest["placeholders"], sorted(builder.MISSING_VALUES))
        self.assertIn("", manifest["placeholders"])
        self.assertNotIn("false", manifest["placeholders"])

    def test_sequence_index_is_exact_canonical_and_shared(self):
        self.write_csv([
            self.row("000001", **{"vh.sequence_from_patent": VH_SEQUENCE}),
            self.row("000002", **{"vl.sequence_from_patent": f"  {VH_SEQUENCE.lower()[:10]} {VH_SEQUENCE.lower()[10:]}\n"}),
            self.row("000003", **{"vh.sequence_from_patent": SHORT_SEQUENCE, "vl.sequence_from_patent": VL_SEQUENCE}),
        ])
        manifest = self.build()
        self.assertEqual(manifest["sequences"]["algorithm"], "fnv1a64")
        self.assertTrue(manifest["sequences"]["url"].endswith("/sequences.json"))
        self.assertEqual(builder.fnv1a64(VH_SEQUENCE), VH_SEQUENCE_KEY)
        sequences = self.read_asset(manifest, "sequences")
        lookup = dict(zip(sequences["keys"], sequences["rows"]))
        self.assertEqual(sequences["keys"], sorted(lookup))
        self.assertEqual(manifest["counts"]["sequences"], 2)
        # Whitespace and case differences collapse onto one key listing both records.
        self.assertEqual(lookup[VH_SEQUENCE_KEY], [0, 1])
        self.assertEqual(lookup[builder.fnv1a64(VL_SEQUENCE)], [2])
        self.assertNotIn(builder.fnv1a64(SHORT_SEQUENCE), lookup)
        index = self.read_asset(manifest, "index")
        self.assertEqual([row[-2:] for row in index["rows"]],
                         [[True, False], [False, True], [True, True]])

    def test_sequence_key_collision_is_rejected(self):
        self.write_csv([self.row("000001", **{"vh.sequence_from_patent": VH_SEQUENCE,
                                              "vl.sequence_from_patent": VL_SEQUENCE})])
        with mock.patch.object(builder, "fnv1a64", lambda text: "0" * 16):
            with self.assertRaisesRegex(builder.BuildError, "collision"):
                self.build()

    def test_duplicate_and_empty_ids_are_rejected(self):
        for rows, message in (([self.row(), self.row()], "Duplicate"), ([self.row("  ")], "Empty")):
            with self.subTest(message=message):
                self.write_csv(rows)
                with self.assertRaisesRegex(builder.BuildError, message):
                    self.build()

    def test_incorrect_width_is_rejected(self):
        self.write_csv([self.row()[:-1]])
        with self.assertRaisesRegex(builder.BuildError, "expected"):
            self.build()

    def test_missing_and_duplicate_columns_are_rejected(self):
        self.write_csv([], fields=self.fields[1:])
        with self.assertRaisesRegex(builder.BuildError, "Missing required"):
            self.build()
        self.write_csv([], fields=self.fields + [self.fields[0]])
        with self.assertRaisesRegex(builder.BuildError, "duplicate"):
            self.build()

    def test_missing_facet_only_column_is_rejected(self):
        # A facet column that is not also searched used to escape main() as a bare KeyError.
        facet_only = "antibody_type"
        with mock.patch.object(builder, "SEARCH_FIELDS", [f for f in builder.SEARCH_FIELDS if f != facet_only]):
            self.fields = [field for field in self.fields if field != facet_only]
            self.write_csv([])
            with self.assertRaisesRegex(builder.BuildError, f"Missing required CSV columns: {facet_only}"):
                self.build()

    def test_malformed_quoting_is_rejected(self):
        self.write_csv([self.row()])
        with self.source.open("a") as handle:
            handle.write('"unterminated')
        self.pin_checksum()
        with self.assertRaisesRegex(builder.BuildError, "Malformed CSV"):
            self.build()

    def test_checksum_mismatch_does_not_modify_previous_build(self):
        self.write_csv([self.row()])
        self.build()
        marker = self.output / "marker.txt"
        marker.write_text("keep")
        self.config["source"]["checksum"] = "md5:" + "0" * 32
        with self.assertRaisesRegex(builder.BuildError, "Checksum mismatch"):
            self.build()
        self.assertEqual(marker.read_text(), "keep")

    def test_verified_checksum_is_not_recomputed(self):
        self.write_csv([self.row()])
        checksum = builder.verify_checksum(self.source, self.config["source"]["checksum"])
        with mock.patch.object(builder, "verify_checksum", side_effect=AssertionError("rehashed the source")):
            manifest = self.build(checksum=checksum)
        self.assertEqual(manifest["sourceChecksum"], checksum)

    def test_invalid_csv_does_not_modify_previous_build(self):
        self.write_csv([self.row()])
        manifest = self.build()
        original = (self.output / manifest["index"]["url"]).read_bytes()
        self.write_csv([self.row(), self.row()])
        with self.assertRaises(builder.BuildError):
            self.build()
        self.assertEqual((self.output / manifest["index"]["url"]).read_bytes(), original)
        self.assertFalse(list(self.root.glob(".dist-build-*")))

    def test_stale_staging_directory_is_removed(self):
        stale = self.root / ".dist-build-killed"
        (stale / "data").mkdir(parents=True)
        self.write_csv([self.row()])
        self.build()
        self.assertFalse(stale.exists())
        self.assertFalse(list(self.root.glob(".dist-build-*")))

    def test_release_and_chunk_size_changes_use_distinct_asset_urls(self):
        self.write_csv([self.row()])
        first = self.build()
        self.write_csv([self.row("000002")])
        second = self.build()
        self.assertNotEqual(first["index"]["url"], second["index"]["url"])
        self.assertNotEqual(first["details"]["pattern"], second["details"]["pattern"])
        self.assertFalse((self.output / first["index"]["url"]).exists())
        self.assertFalse((self.output / first["details"]["pattern"].format(chunk=0)).exists())
        self.config["chunkSize"] = 1
        third = self.build()
        self.assertNotEqual(second["details"]["pattern"], third["details"]["pattern"])
        self.assertEqual(json.loads((self.output / "data/manifest.json").read_text()), third)

    def test_representations_publish_only_what_the_manifest_advertises(self):
        self.write_csv([self.row()])
        plain = self.build(representations="plain")
        self.assertEqual(set(plain["facets"]), {"url"})
        self.assertEqual(set(plain["details"]), {"pattern", "chunkSize"})
        self.assertFalse(list((self.output / "data").rglob("*.gz")))
        self.assertTrue((self.output / "data/manifest.json").is_file())
        compressed = self.build(representations="gzip")
        self.assertEqual(set(compressed["facets"]), {"gzipUrl"})
        self.assertEqual(set(compressed["details"]), {"gzipPattern", "chunkSize"})
        self.assertEqual(set(compressed["index"]), {"gzipUrl", "fields"})
        # The manifest is the only document the browser can request without reading the manifest, so
        # gzip-only still publishes it as plain JSON; every asset it describes is compressed-only.
        self.assertEqual([path.name for path in (self.output / "data").rglob("*.json")], ["manifest.json"])
        self.assertEqual(json.loads((self.output / "data/manifest.json").read_text(encoding="utf-8")), compressed)
        self.assertEqual(json.loads(gzip.decompress((self.output / "data/manifest.json.gz").read_bytes())), compressed)
        with self.assertRaisesRegex(builder.BuildError, "representations"):
            self.build(representations="brotli")

    def test_a_mixed_unique_record_id_grammar_is_reported(self):
        """
        v1.1 shipped 85,390 six-digit ids beside 7,803 twelve-digit ones and nothing in the repo
        could see it: RELEASE_HEADER pins column names and order only. Record links and any
        downstream join key depend on the key's grammar, so a mix says so on stderr.
        """
        self.write_csv([self.row("000001"), self.row("000002")])
        single = io.StringIO()
        with contextlib.redirect_stderr(single):
            self.build()
        self.assertNotIn("value shapes", single.getvalue())

        self.write_csv([self.row("000001"), self.row("474677273107")])
        mixed = io.StringIO()
        with contextlib.redirect_stderr(mixed):
            self.build()
        notice = mixed.getvalue()
        self.assertIn("unique_record_id has 2 value shapes", notice)
        self.assertIn("6 digits", notice)
        self.assertIn("12 digits", notice)
        # A shape is length plus whether it is numeric, so a same-length non-numeric key counts too.
        self.write_csv([self.row("000001"), self.row("A00002")])
        other = io.StringIO()
        with contextlib.redirect_stderr(other):
            self.build()
        self.assertIn("6 characters", other.getvalue())

    def test_not_found_page_is_self_contained(self):
        self.write_csv([self.row()])
        self.build()
        page = (self.output / "404.html").read_text(encoding="utf-8")
        self.assertIn("does not exist", page)
        home_link = page.split('<nav><a class="button" href="', 1)[1].split('"', 1)[0]
        for missing_path in ("/missing", "/missing/", "/missing/nested/page"):
            with self.subTest(missing_path=missing_path):
                self.assertEqual(urljoin("https://poisk-explorer.github.io" + missing_path, home_link),
                                 "https://poisk-explorer.github.io/")
        self.assertIn(self.config["dataset"]["recordUrl"], page)
        for dependency in ("<script", "styles.css", "app.js", "//"):
            self.assertNotIn(dependency, page.replace("https://", ""))
        self.config["dataset"].update(doi="", recordUrl="", downloadUrl="", version="draft")
        self.build()
        self.assertNotIn("Zenodo", (self.output / "404.html").read_text(encoding="utf-8"))

    def test_sha256_and_bom(self):
        self.write_csv([self.row()])
        self.source.write_bytes(b"\xef\xbb\xbf" + self.source.read_bytes())
        self.config["source"]["checksum"] = "sha256:" + hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.assertEqual(self.build()["counts"]["records"], 1)

    def test_configuration_rejects_insecure_links(self):
        for section, key in (("source", "url"), ("dataset", "recordUrl"), ("dataset", "downloadUrl")):
            config = copy.deepcopy(self.config)
            config[section][key] = "http://example.org/dataset"
            with self.subTest(section=section, key=key), self.assertRaisesRegex(builder.BuildError, "HTTPS"):
                builder.load_config(self.write_config(config))

    def test_configuration_rejects_embedded_credentials(self):
        config = copy.deepcopy(self.config)
        config["source"]["url"] = "https://token:secret@zenodo.org/records/19883049/files/poisk_dataset.csv"
        with self.assertRaisesRegex(builder.BuildError, "without embedded credentials"):
            builder.load_config(self.write_config(config))

    def test_configuration_rejects_malformed_checksums(self):
        for checksum in ("", "1d663c6797f03466349c995b4e8a913a", "md5:", "md5-" + "a" * 32,
                         "md5:" + "a" * 31, "md5:" + "a" * 33, "sha1:" + "a" * 40,
                         "sha256:" + "a" * 32, "md5:" + "g" * 32, None, 32, ["md5:" + "a" * 32]):
            config = copy.deepcopy(self.config)
            config["source"]["checksum"] = checksum
            with self.subTest(checksum=checksum), self.assertRaisesRegex(builder.BuildError, "source.checksum"):
                builder.load_config(self.write_config(config))

    def test_configuration_rejects_invalid_chunk_sizes(self):
        for size in (0, -1, 5001, True, False, 1.5, "400", None):
            config = copy.deepcopy(self.config)
            config["chunkSize"] = size
            with self.subTest(size=size), self.assertRaisesRegex(builder.BuildError, "chunkSize"):
                builder.load_config(self.write_config(config))
        config = copy.deepcopy(self.config)
        del config["chunkSize"]
        self.assertEqual(builder.load_config(self.write_config(config))["chunkSize"], 400)

    def test_configuration_rejects_non_string_license(self):
        for license_value in (False, 0, ["CC-BY-4.0"], {"id": "CC-BY-4.0"}):
            config = copy.deepcopy(self.config)
            config["dataset"]["license"] = license_value
            with self.subTest(license=license_value), self.assertRaisesRegex(builder.BuildError, "dataset.license"):
                builder.load_config(self.write_config(config))
        config = copy.deepcopy(self.config)
        del config["dataset"]["license"]
        with self.assertRaisesRegex(builder.BuildError, "dataset.license"):
            builder.load_config(self.write_config(config))

    def test_draft_configuration_allows_empty_publication_links(self):
        self.config["dataset"].update(doi="", recordUrl="", downloadUrl="", version="draft")
        self.assertEqual(builder.load_config(self.write_config(self.config))["dataset"]["version"], "draft")

    def test_redirect_handler_rejects_downgrade_to_http(self):
        handler = builder.HTTPSOnlyRedirect()
        request = Request("https://zenodo.org/records/19883049/files/poisk_dataset.csv")
        with self.assertRaisesRegex(builder.BuildError, "Download redirect"):
            handler.redirect_request(request, None, 302, "Found", {}, "http://zenodo.org/records/19883049")
        redirected = handler.redirect_request(request, None, 302, "Found", {}, "https://zenodo.org/elsewhere")
        self.assertEqual(redirected.full_url, "https://zenodo.org/elsewhere")

    def test_unusable_cache_entry_is_replaced(self):
        # Never contacts the network: the opener is replaced so the download path stays offline.
        cache = self.root / "cache"
        cache.mkdir()
        self.write_csv([self.row()])
        source = {"source": self.config["source"]}
        payload = self.source.read_bytes()
        with mock.patch.object(builder, "build_opener", return_value=FakeOpener(payload, source["source"]["url"])):
            cached, digest = builder.download_source(source, cache)
        self.assertEqual(digest, source["source"]["checksum"])
        self.assertEqual(cached.read_bytes(), payload)
        cached.write_bytes(b"truncated")
        notice = io.StringIO()
        with mock.patch.object(builder, "build_opener", side_effect=URLError("offline")) as opener:
            with contextlib.redirect_stderr(notice), self.assertRaises(URLError):
                builder.download_source(source, cache)
        self.assertIn("Discarding unusable cache entry", notice.getvalue())
        self.assertEqual(opener.call_count, 1)
        self.assertFalse(cached.exists())
        with mock.patch.object(builder, "build_opener", return_value=FakeOpener(payload, source["source"]["url"])):
            self.assertEqual(builder.download_source(source, cache)[1], digest)
        self.assertFalse(list(cache.glob("download-*")))

    def test_download_rejects_an_insecure_final_url(self):
        cache = self.root / "cache"
        cache.mkdir()
        self.write_csv([self.row()])
        source = {"source": self.config["source"]}
        with mock.patch.object(builder, "build_opener", return_value=FakeOpener(self.source.read_bytes(), "http://zenodo.org/x")):
            with self.assertRaisesRegex(builder.BuildError, "Download response URL"):
                builder.download_source(source, cache)
        self.assertFalse(list(cache.glob("*.csv")))

    def test_presence_markers(self):
        for value in ("", "  ", "None", "null", "NOT_SPECIFIED", "N/A", "not-applicable", "-", "[]",
                      "not found", "NOT_FOUND", "None Found"):
            with self.subTest(value=value):
                self.assertFalse(builder.meaningful(value))
        # A recorded boolean is data, not a missing value.
        for value in ("0", "site A", "1e-9 M", "False", "TRUE"):
            with self.subTest(value=value):
                self.assertTrue(builder.meaningful(value))

    def test_output_cannot_replace_sources(self):
        self.write_csv([self.row()])
        with self.assertRaisesRegex(builder.BuildError, "separate"):
            builder.build(self.source, self.root, self.config, self.web)
        with self.assertRaisesRegex(builder.BuildError, "separate"):
            builder.build(self.source, self.web / "dist", self.config, self.web)


if __name__ == "__main__":
    unittest.main()
