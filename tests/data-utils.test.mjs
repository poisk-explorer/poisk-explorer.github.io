import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSequence, csvLine, fastaEntry, fnv1a64, formatLabel, safeExternalURL, pastedSequence } from '../web/data-utils.js';

// A separate CSV reader checks round trips without using the writer's quoting logic.
function parseCSV(text) {
  const result = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && character === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      result.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += character;
  }
  assert.equal(quoted, false, 'CSV should not end inside a quoted field');
  assert.equal(cell, '', 'CSV should end with a record separator');
  assert.equal(row.length, 0);
  return result;
}

test('CSV quotes every cell, escapes quotes, and writes CRLF record separators', () => {
  assert.equal(csvLine(['alpha', 'a,b', 'say "yes"', '', null, undefined, true, false, 0, -3]),
    '"alpha","a,b","say ""yes""","","","","true","false","0","-3"\r\n');
  assert.throws(() => csvLine('not a row'), TypeError);
});

test('multiline and Unicode CSV values round-trip unchanged with raw export', () => {
  const source = [
    ['Café β', 'first\nsecond', 'Windows\r\nnewline', 'lone\rcarriage', '"quoted", cell'],
    ['', '=SUM(1,2)', '  @command', '\tlabel', '  ordinary text  '],
  ];
  const text = source.map((row) => csvLine(row, { spreadsheetSafe: false })).join('');
  assert.deepEqual(parseCSV(text), source);
});

test('spreadsheet-safe mode protects formula-like string cells after leading whitespace', () => {
  const dangerous = [
    '=1+1', '+SUM(A1:A2)', '-3', '@command', '  =HYPERLINK("https://example.org")',
    '\n\n+2', '\t\r  @command', '\uFEFF-4', '\tlabel', '\rlabel',
  ];
  assert.deepEqual(parseCSV(csvLine(dangerous))[0], dangerous.map((value) => `'${value}`));
  assert.deepEqual(parseCSV(csvLine(dangerous, { spreadsheetSafe: false }))[0], dangerous);
});

test('ordinary data, numeric values, apostrophes, and symbols within text are unchanged', () => {
  const values = ['Café', ' A+B ', 'name@example.org', "'=1+1", 'A-1', 'line\n=following', '\ntext', '', -2, 2, true, false, null];
  assert.deepEqual(parseCSV(csvLine(values))[0], [
    'Café', ' A+B ', 'name@example.org', "'=1+1", 'A-1', 'line\n=following', '\ntext', '', '-2', '2', 'true', 'false', '',
  ]);
});

test('external URLs allow only valid absolute HTTPS links', () => {
  assert.equal(safeExternalURL('https://zenodo.org/records/19883049'), 'https://zenodo.org/records/19883049');
  assert.equal(safeExternalURL('HTTPS://EXAMPLE.ORG/a b?x=1#part'), 'https://example.org/a%20b?x=1#part');
  for (const value of [
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://example.org',
    'file:///etc/passwd', '//example.org', '/relative', 'not a URL', 'https://', '', null, {},
  ]) assert.equal(safeExternalURL(value), null);
});

test('field labels use readable names and retain known scientific abbreviations', () => {
  assert.equal(formatLabel('unique_record_id'), 'Record ID');
  assert.equal(formatLabel('target.uniprot_id'), 'UniProt ID');
  assert.equal(formatLabel('target.binding_affinity.affinity_value'), 'Affinity value');
  assert.equal(formatLabel('audit.some_future_field'), 'Some future field');
  assert.equal(formatLabel(''), '');
  assert.equal(formatLabel(null), '');
});

test('labels that share a last segment stay distinguishable', () => {
  // These rendered as the same "Seq id"/"Sequence from patent" text in one definition list.
  assert.equal(formatLabel('vh.seq_id'), 'VH SEQ ID');
  assert.equal(formatLabel('vl.seq_id'), 'VL SEQ ID');
  assert.equal(formatLabel('target.seq_id'), 'Target SEQ ID');
  assert.equal(formatLabel('vh.sequence_from_patent'), 'VH sequence (as reported)');
  assert.equal(formatLabel('vl.sequence_from_patent'), 'VL sequence (as reported)');
  assert.equal(formatLabel('target.sequence_from_patent'), 'Target sequence (as reported)');
  // Release 1.1's provenance columns: unique last segments, but the fallback drops "target.".
  assert.equal(formatLabel('target.sequence'), 'Target sequence (held by this release)');
  assert.equal(formatLabel('target.sequence_from_uniprot'), 'Target sequence (from UniProt)');
  assert.equal(formatLabel('target.sequence_accession'), 'Target GenBank accession (patent deposit)');
  assert.equal(formatLabel('vh.is_full_heavy_chain'), 'Full heavy chain');
  assert.equal(formatLabel('vl.is_full_light_chain'), 'Full light chain');
  assert.equal(formatLabel('discovery_methodology.cdr_modified'), 'CDR modified');
  assert.equal(formatLabel('epitope.linear_epitope_range.start'), 'Linear epitope start');
  assert.equal(formatLabel('epitope.linear_epitope_range.end'), 'Linear epitope end');
  // The dotted path wins, but the bare last segment is still the fallback.
  assert.equal(formatLabel('seq_id'), 'Seq id');
  assert.equal(formatLabel('future.protein_name'), 'Protein name');
});

test('FNV-1a 64 matches the reference vectors the build script hashes with', () => {
  assert.equal(fnv1a64(''), 'cbf29ce484222325');
  assert.equal(fnv1a64('a'), 'af63dc4c8601ec8c');
  assert.equal(fnv1a64('foobar'), '85944171f73967e8');
  assert.equal(fnv1a64('EVQLVESGGGLVQPGG'), 'dc4ee58ade05b903');
  assert.equal(fnv1a64('QVQLVQSGAEVKKPGASVKVSCKAS'), '0779a2e88b90ef85');
  assert.equal(fnv1a64(null), fnv1a64(''));
  for (const key of [fnv1a64(''), fnv1a64('a'), fnv1a64('EVQLVESGGGLVQPGG')]) {
    assert.match(key, /^[0-9a-f]{16}$/, 'keys are padded 16-digit lowercase hex');
  }
});

test('sequence canonicalisation keeps residue letters only', () => {
  assert.equal(canonicalSequence('evql vesg\n123 ggg'), 'EVQLVESGGGG');
  assert.equal(canonicalSequence('EVQL-VESG'), 'EVQLVESG');
  assert.equal(canonicalSequence(' 1 2 3 '), '');
  assert.equal(canonicalSequence(null), '');
  assert.equal(canonicalSequence(undefined), '');
  // Formatting differences must not change the hash key.
  assert.equal(fnv1a64(canonicalSequence('evqlvesgggg')), fnv1a64(canonicalSequence('EVQL VESG GGG 10')));
});

test('FASTA records wrap at 60 residues and keep the header to one line of fields', () => {
  const sequence = 'ABCDEFGHIJ'.repeat(7);
  const entry = fastaEntry({
    id: '000123', chain: 'VH', antibody: 'AB-1', patent: 'WO1', target: 'CD3 epsilon', sequence,
  });
  const lines = entry.split('\n');
  assert.equal(lines[0], '>000123|VH|AB-1|WO1|CD3 epsilon');
  assert.equal(lines[1], sequence.slice(0, 60));
  assert.equal(lines[2], sequence.slice(60));
  assert.equal(lines[3], '', 'the record ends with a newline');
  assert.equal(lines.length, 4);
  assert.equal(entry.at(-1), '\n');
});

test('FASTA headers survive pipes, newlines, and missing fields', () => {
  assert.equal(
    fastaEntry({ id: 'a|b', chain: 'VL', antibody: 'x\ny', patent: null, target: ' pad ', sequence: 'acdef' }),
    '>a b|VL|x y||pad\nACDEF\n');
  assert.equal(fastaEntry({ id: 'only' }), '>only||||\n', 'an empty sequence writes no residue lines');
  assert.equal(fastaEntry(), '>||||\n');
});

test('a pasted FASTA record looks up by its residues, not its header', () => {
  const sequence = 'EVQLLDSGGGLVQPGGCLRLSCAASGFTFSSCAMSWVRQAPGKGLEWVSAISGSGGSTYYADSVKG';
  const entry = fastaEntry({
    id: '000000', chain: 'VH', antibody: 'L612', patent: '5419904',
    target: 'Ganglioside GM3', sequence,
  });
  // canonicalSequence keeps every letter, so the header's words would be spliced onto the chain
  // and the hash would miss: the explorer used to report its own exported sequences as absent.
  assert.notEqual(canonicalSequence(entry), sequence);
  assert.equal(pastedSequence(entry), sequence);
  // The plain forms a user is as likely to paste must still work.
  assert.equal(pastedSequence(sequence), sequence);
  assert.equal(pastedSequence(`  ${sequence.toLowerCase()}\n`), sequence);
  assert.equal(pastedSequence('1 EVQL LDSG 10 GGLV'), 'EVQLLDSGGGLV');
  // A ';' comment line is the other FASTA dialect, and a header with no body yields nothing.
  assert.equal(pastedSequence(`; a comment\n${sequence}`), sequence);
  assert.equal(pastedSequence('>000000|VH|L612'), '');
});
