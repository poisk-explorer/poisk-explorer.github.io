import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  createSearchEngine, hasUnterminatedQuote, squash, tokenizeQuery,
} from '../web/search-core.js';
import { canonicalSequence, fnv1a64 } from '../web/data-utils.js';

const fields = [
  'unique_record_id', 'patent_id', 'antibody_identifier', 'antibody_type',
  'target.organism', 'target.protein_name', 'target.gene_names', 'target.uniprot_id',
  'target.binding_affinity.method', 'audit.verdict', 'has_epitope', 'has_affinity', 'has_sequence',
];
const rows = [
  ['r0', 'WO10', 'AB-1', 'IgG', 'Human', 'Café receptor alpha', 'ERBB1', 'P00533', 'SPR', 'Pass', true, true, true],
  ['r1', 'WO2', 'AB-2', 'igg', 'human', 'Beta receptor alpha', 'ERBB2', 'P04626', 'SPR', 'pass', false, true, false],
  ['r2', 'WO1', 'AB-3', '', 'Mouse', 'Cafe receptor beta', 'EGFR', 'P00533', 'ELISA', '', true, false, true],
  ['r3', 'WO2', 'AB-4', null, '', null, '', '', null, null, 'true', false, false],
  ['r4', '', 'AB-5', undefined, null, '', 'ABC2', '', '', '', false, false, false],
  ['r5', null, 'AB-6', 'IgG', 'Human', 'Alpha', 'receptor', 'P00000', 'SPR', 'Pass', false, true, true],
];
const makeEngine = () => createSearchEngine({ fields, rows });

test('search is case- and diacritic-insensitive and ANDs tokens across metadata fields', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.query({ q: 'CAFÉ p00533' }).indices, [0, 2]);
  assert.deepEqual(engine.query({ q: 'receptor ERBB1' }).indices, [0]);
  assert.deepEqual(engine.query({ q: 'AB-2 WO2' }).indices, [1]);
  assert.deepEqual(engine.query({ q: 'r2' }).indices, [2]);
  assert.equal(engine.query({ q: 'Human' }).total, 0, 'organism is a filter, not full-text metadata');
});

test('quoted phrases stay within a field, and malformed quotes still search', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.query({ q: '"receptor alpha"' }).indices, [0, 1]);
  assert.equal(engine.query({ q: '"alpha receptor"' }).total, 0, 'phrase cannot span protein and gene');
  assert.deepEqual(engine.query({ q: '"cafe receptor' }).indices, [0, 2]);
  assert.deepEqual(tokenizeQuery('  "" café CAFE  "receptor   alpha" '), ['cafe', 'receptor alpha']);
  assert.deepEqual(tokenizeQuery('"a \\"b\\""'), ['a "b"']);
});

test('field-specific search only searches that field', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.query({ q: 'receptor', field: 'target.gene_names' }).indices, [5]);
  assert.equal(engine.query({ q: 'P00533', field: 'target.protein_name' }).total, 0);
  assert.deepEqual(engine.query({ q: 'P00533', field: 'unrecognized' }).indices, [0, 2]);
});

test('filters preserve exact raw case, combine with search, and allow blanks', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.query({ filters: { 'target.organism': 'Human' } }).indices, [0, 5]);
  assert.deepEqual(engine.query({ filters: { 'target.organism': 'human' } }).indices, [1]);
  assert.deepEqual(engine.query({ q: 'receptor', filters: { antibody_type: 'IgG' } }).indices, [0, 5]);
  assert.deepEqual(engine.query({ filters: { antibody_type: '' } }).indices, [2, 3, 4]);
  assert.deepEqual(engine.query({ filters: { 'audit.verdict': null } }).indices, [2, 3, 4]);
  assert.deepEqual(engine.query({ filters: { 'target.organism': ['Mouse', 'human'] } }).indices, [1, 2]);
  assert.deepEqual(engine.query({ filters: { antibody_type: 'IgG', 'audit.verdict': 'Pass' } }).indices, [0, 5]);
});

test('boolean filters do not confuse boolean values and strings', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.query({ filters: { has_epitope: true } }).indices, [0, 2]);
  assert.deepEqual(engine.query({ filters: { has_epitope: false } }).indices, [1, 4, 5]);
  assert.deepEqual(engine.query({ filters: { has_epitope: 'true' } }).indices, [3]);
});

test('sort is natural, stable on ties, and keeps missing values last in both directions', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.query({ sort: 'patent_id' }).indices, [2, 1, 3, 0, 4, 5]);
  assert.deepEqual(engine.query({ sort: 'patent_id', direction: 'desc' }).indices, [0, 1, 3, 2, 4, 5]);
  assert.deepEqual(engine.query({ sort: 'source', direction: 'desc' }).indices, [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(engine.query().indices, [0, 1, 2, 3, 4, 5], 'sort must not alter source order');
});

test('pagination reports totals, clamps page, and uses row references', () => {
  const engine = makeEngine();
  const first = engine.query({ pageSize: 2 });
  assert.equal(first.total, 6);
  assert.equal(first.pageCount, 3);
  assert.equal(first.page, 1);
  assert.deepEqual(first.indices, [0, 1]);
  assert.equal(first.rows[0], rows[0]);
  assert.deepEqual(engine.query({ page: 2, pageSize: 2 }).indices, [2, 3]);
  const last = engine.query({ page: 99, pageSize: 2 });
  assert.equal(last.page, 3);
  assert.deepEqual(last.indices, [4, 5]);
  assert.deepEqual(engine.query({ page: -1, pageSize: -1 }).indices, [0, 1, 2, 3, 4, 5]);
});

test('export returns all matching indices in current order and cannot corrupt cached results', () => {
  const engine = makeEngine();
  const query = { q: 'receptor', sort: 'patent_id', pageSize: 1, page: 2 };
  const exported = engine.matchingIndices(query);
  assert.deepEqual(exported, [2, 1, 0, 5]);
  exported.reverse();
  assert.deepEqual(engine.query(query).indices, [1]);
  const paged = engine.query(query);
  paged.indices[0] = 99;
  assert.deepEqual(engine.query(query).indices, [1]);
});

test('empty results and malformed queries have safe defaults', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.query({ q: 'not-in-dataset', page: 999 }), {
    total: 0, page: 1, pageCount: 0, indices: [], rows: [], unterminatedQuote: false,
  });
  for (const query of [null, undefined, 4, '', { q: {}, filters: [], sort: {}, page: NaN, pageSize: Infinity }]) {
    assert.equal(engine.query(query).total, 6);
  }
  assert.equal(engine.query({ filters: { unknown: 'value', antibody_type: undefined } }).total, 6);
  assert.equal(engine.query({ page: Symbol('bad page'), pageSize: {} }).total, 6);
  assert.equal(engine.query({ filters: { antibody_type: NaN } }).total, 6);
  assert.equal(engine.query({ filters: { antibody_type: null } }).total, 3);
});

test('record ID lookup is exact and returns first row for duplicate IDs', () => {
  const engine = makeEngine();
  assert.equal(engine.lookup('r2'), 2);
  assert.equal(engine.lookup('R2'), -1);
  assert.equal(engine.lookup(undefined), -1);
  const duplicate = createSearchEngine({ fields: ['unique_record_id'], rows: [['x'], ['x']] });
  assert.equal(duplicate.lookup('x'), 0);
});

test('empty datasets work, and invalid index structures fail clearly', () => {
  const engine = createSearchEngine({ fields: [], rows: [] });
  assert.equal(engine.query().total, 0);
  assert.equal(engine.lookup('r0'), -1);
  for (const index of [null, {}, { fields: ['x', 'x'], rows: [] }, { fields: [], rows: [null] }]) {
    assert.throws(() => createSearchEngine(index), TypeError);
  }
});

const nameFields = [
  'unique_record_id', 'patent_id', 'antibody_identifier',
  'target.protein_name', 'target.gene_names', 'target.uniprot_id',
];
const nameRows = [
  ['n0', 'WO1', 'AB-1', 'Programmed cell death protein PD-1', 'PDCD1', 'Q15116'],
  ['n1', 'WO2', 'AB-2', 'PD1 ligand', 'CD274', 'Q9NZQ7'],
  ['n2', 'WO3', 'AB-3', 'TGFβ receptor type 2', 'TGFBR2', 'P37173'],
  ['n3', 'WO4', 'AB-4', 'TGF-beta 1', 'TGFB1', 'P01137'],
  ['n4', 'WO5', 'AB-5', 'Interferon γ', 'IFNG', 'P01579'],
  ['n5', 'WO6', 'AB-6', 'µ-opioid receptor', 'OPRM1', 'P35372'],
];
const nameEngine = () => createSearchEngine({ fields: nameFields, rows: nameRows });

test('punctuation and Greek spellings of the same target converge', () => {
  const engine = nameEngine();
  // Measured on the real index before this change: 'PD-1' matched 1,674 rows, 'PD1' only 392,
  // overlapping in 213. Both forms must now reach the same records.
  const found = (q) => engine.query({ q }).indices.toSorted((left, right) => left - right);
  for (const q of ['PD-1', 'PD1', 'pd 1', '"pd 1"', 'PD‑1' /* non-breaking hyphen */]) {
    assert.deepEqual(found(q), [0, 1], q);
  }
  for (const q of ['TGFβ', 'TGF-beta', 'tgfbeta', 'TGF beta']) assert.deepEqual(found(q), [2, 3], q);
  assert.deepEqual(found('interferon gamma'), [4]);
  assert.deepEqual(found('interferon γ'), [4]);
  assert.deepEqual(found('mu-opioid'), [5], 'micro sign folds to mu');
  // Converging does not mean ranking identically: the spelling the user typed still comes first.
  assert.deepEqual(engine.query({ q: 'PD-1' }).indices, [0, 1]);
  assert.deepEqual(engine.query({ q: 'PD1' }).indices, [1, 0]);
});

test('a folded spelling can reach the top relevance band', () => {
  /*
   * Relevance is scored on the squashed index as well as the normalised one. Without that, a row
   * matched only because punctuation was folded away could never leave the bottom band, so a
   * "CD3" search ranked CD38 — a different antigen that merely shares a prefix — above a target
   * actually named CD-3. Measured on the real index, fixing it moved the 1,571 records whose
   * target is PD-1 from result positions 276-1,856 up to 1-1,603 for the query "PD1".
   */
  const engine = createSearchEngine({
    fields: nameFields,
    rows: [
      ['r0', 'WO1', 'AB-1', 'CD38', 'CD38', 'P28907'],
      ['r1', 'WO2', 'AB-2', 'CD-3', 'CD3E', 'P07766'],
    ],
  });
  assert.deepEqual(engine.query({ q: 'CD3' }).indices, [1, 0]);
  assert.deepEqual(engine.query({ q: 'CD-3' }).indices, [1, 0]);
  // CD38's own exact spelling still outranks the folded CD-3 row for a CD38 query.
  assert.deepEqual(engine.query({ q: 'CD38' }).indices, [0]);
});

test('a token that is only punctuation constrains nothing', () => {
  const engine = nameEngine();
  // 'CD3 / CD19' used to demand a literal "/" in a metadata field and returned zero rows.
  assert.deepEqual(engine.query({ q: 'PD1 /' }).indices, engine.query({ q: 'PD1' }).indices);
  assert.deepEqual(engine.query({ q: '/' }).total, nameRows.length);
  assert.deepEqual(engine.query({ q: '+ -' }).total, nameRows.length);
});

test('every Greek letter transliterates to a latin name', () => {
  const greek = 'αβγδεζηθικλμνξοπρςστυφχψω';
  const engine = createSearchEngine({
    fields: ['unique_record_id', 'target.protein_name'],
    rows: [['g0', greek], ['g1', greek.toUpperCase()]],
  });
  for (const name of [
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
    'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi',
    'chi', 'psi', 'omega',
  ]) assert.deepEqual(engine.query({ q: name }).indices, [0, 1], name);
  assert.equal(engine.query({ q: 'undefined' }).total, 0, 'no letter may be left unmapped');
});

test('squashing punctuation does not widen field scope or quoted phrases', () => {
  const engine = nameEngine();
  assert.deepEqual(engine.query({ q: 'PD1', field: 'target.protein_name' }).indices, [1, 0]);
  assert.equal(engine.query({ q: 'PD1', field: 'target.gene_names' }).total, 0,
    'PDCD1 does not contain the squashed token');
  assert.equal(engine.query({ q: 'PD1', field: 'patent_id' }).total, 0);
  assert.deepEqual(engine.query({ q: '"receptor type"' }).indices, [2]);
  assert.equal(engine.query({ q: '"type 2 tgfbr2"' }).total, 0,
    'a phrase still cannot span the protein name and the gene name');
  assert.equal(squash('tgf-beta 1'), 'tgfbeta1');
  assert.equal(squash('plain'), 'plain');
});

test("'all' search still ANDs tokens that live in different fields", () => {
  const engine = nameEngine();
  // The joined allText string is gone; 'all' now means "every token matches some one field".
  assert.deepEqual(engine.query({ q: 'ligand CD274' }).indices, [1]);
  assert.deepEqual(engine.query({ q: 'WO4 P01137 beta' }).indices, [3]);
  assert.equal(engine.query({ q: 'ligand TGFBR2' }).total, 0, 'tokens from different records');
  assert.equal(engine.query({ q: '"ligand cd274"' }).total, 0, 'phrase across two fields');
  assert.equal(engine.query({ q: '"Q15116 PDCD1"' }).total, 0);
});

const rankFields = ['unique_record_id', 'patent_id', 'antibody_identifier', 'target.protein_name', 'target.gene_names'];
const rankRows = [
  ['s0', 'WO1', 'AB-0', 'Glycoprotein ABCD3 complex', ''],
  ['s1', 'WO2', 'AB-1', 'CD33 antigen', 'CD33'],
  ['s2', 'CD3', 'AB-2', 'Unrelated protein', ''],
  ['s3', 'WO4', 'AB-3', 'CD3 epsilon', 'CD3E'],
  ['s4', 'WO5', 'CD3-binder', 'Something else', ''],
];

test('relevance ranks whole-word hits first and substring-only hits last', () => {
  const engine = createSearchEngine({ fields: rankFields, rows: rankRows });
  // 3: whole word in protein name (s3) or antibody identifier (s4).
  // 2: word start anywhere — CD33/CD33 (s1) and the whole-word-but-unranked patent_id (s2).
  // 1: substring only — ABCD3 (s0), which is first in source order and must sort last.
  assert.deepEqual(engine.query({ q: 'CD3' }).indices, [3, 4, 1, 2, 0]);
  assert.deepEqual(engine.query({ q: 'CD3', sort: 'source', direction: 'desc' }).indices, [0, 2, 1, 4, 3],
    'descending reverses the ranked order');
  assert.deepEqual(engine.query({ q: 'CD3 epsilon' }).indices, [3], 'every token must qualify');
  assert.deepEqual(engine.query({ q: 'CD3', pageSize: 2 }).indices, [3, 4], 'pages follow the ranking');
});

test('an explicit column sort still overrides relevance', () => {
  const engine = createSearchEngine({ fields: rankFields, rows: rankRows });
  assert.deepEqual(engine.query({ q: 'CD3', sort: 'patent_id' }).indices, [2, 0, 1, 3, 4]);
  assert.deepEqual(engine.query({ q: 'CD3', sort: 'patent_id', direction: 'desc' }).indices, [4, 3, 1, 0, 2]);
  assert.deepEqual(engine.query({ sort: 'source' }).indices, [0, 1, 2, 3, 4],
    'with no tokens the source order is untouched');
});

test('an unterminated quote is reported without changing tokenizing', () => {
  const engine = nameEngine();
  assert.equal(engine.query({ q: '"receptor type"' }).unterminatedQuote, false);
  assert.equal(engine.query({ q: '"receptor type' }).unterminatedQuote, true);
  assert.equal(engine.query({ q: 'plain text' }).unterminatedQuote, false);
  assert.equal(engine.query({}).unterminatedQuote, false);
  assert.equal(engine.query({ q: 42 }).unterminatedQuote, false);
  assert.equal(hasUnterminatedQuote('a \\" b'), false, 'an escaped quote opens nothing');
  assert.equal(hasUnterminatedQuote('a \\\\" b'), true);
  assert.equal(hasUnterminatedQuote('"a" "b"'), false);
  assert.equal(hasUnterminatedQuote('"a" "b'), true);
  assert.equal(hasUnterminatedQuote(null), false);
  assert.ok(Array.isArray(tokenizeQuery('"receptor type')), 'tokenizeQuery still returns an array');
});

const sequences = [
  ['EVQLVESGGGLVQPGGSLRLSCAAS', [0, 2]],
  ['QVQLVQSGAEVKKPGASVKVSCKAS', [1]],
  ['DIQMTQSPSSLSASVGDRVTITCRAS', [1, 3]],
  ['EIVLTQSPGTLSLSPGERATLSCRAS', [4]],
  ['SYELTQPPSVSVSPGQTASITCSGD', [5]],
];
const sequenceAsset = () => {
  const entries = sequences
    .map(([sequence, indices]) => [fnv1a64(canonicalSequence(sequence)), indices])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return { algorithm: 'fnv1a64', keys: entries.map(([key]) => key), rows: entries.map(([, indices]) => indices) };
};

test('exact sequence lookup finds every record a chain appears in', () => {
  const engine = nameEngine();
  assert.throws(() => engine.lookupSequence(sequences[0][0]), /has not loaded/);
  assert.equal(engine.loadSequences(sequenceAsset()), 5);
  assert.deepEqual(engine.lookupSequence('EVQLVESGGGLVQPGGSLRLSCAAS'), [0, 2]);
  assert.deepEqual(engine.lookupSequence('DIQMTQSPSSLSASVGDRVTITCRAS'), [1, 3], 'VH in one record, VL in another');
  assert.deepEqual(engine.lookupSequence('SYELTQPPSVSVSPGQTASITCSGD'), [5], 'last key in sort order');
  assert.deepEqual(engine.lookupSequence('evqlvesggg lvqpgg slrlscaas\n'), [0, 2], 'canonicalised first');
  assert.deepEqual(engine.lookupSequence('EVQLVESGGGLVQPGGSLRLSCAA'), [], 'one residue short is a miss');
  assert.deepEqual(engine.lookupSequence(''), []);
  assert.deepEqual(engine.lookupSequence('123'), []);
  assert.deepEqual(engine.lookupSequence(null), []);
  const found = engine.lookupSequence('EVQLVESGGGLVQPGGSLRLSCAAS');
  found.push(99);
  assert.deepEqual(engine.lookupSequence('EVQLVESGGGLVQPGGSLRLSCAAS'), [0, 2], 'callers get a copy');
  for (const asset of [null, {}, { keys: [], rows: null }, { keys: ['a'], rows: [] }]) {
    assert.throws(() => engine.loadSequences(asset), TypeError);
  }
});

test('facet counts follow the current match set', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.facetCounts({}, ['antibody_type', 'target.organism']), {
    antibody_type: { IgG: 2, igg: 1, '': 3 },
    'target.organism': { Human: 2, human: 1, Mouse: 1, '': 2 },
  });
  assert.deepEqual(engine.facetCounts({ q: 'receptor' }, ['antibody_type']), {
    antibody_type: { IgG: 2, igg: 1, '': 1 },
  });
  assert.deepEqual(engine.facetCounts({ filters: { antibody_type: 'IgG' } }, ['target.organism']), {
    'target.organism': { Human: 2 },
  });
  assert.deepEqual(engine.facetCounts({ q: 'nothing-matches' }, ['antibody_type']), { antibody_type: {} });
  assert.deepEqual(engine.facetCounts({}, 'audit.verdict'), { 'audit.verdict': { Pass: 2, pass: 1, '': 3 } },
    'a single field name is accepted');
  assert.deepEqual(engine.facetCounts({}, ['not_a_field', 'antibody_type', 'antibody_type']).not_a_field, {},
    'unknown fields report no values');
  // Counts are keyed by the rendered value, so the fixture's string "true" joins the booleans.
  assert.deepEqual(engine.facetCounts({}, ['has_epitope']), { has_epitope: { true: 3, false: 3 } });
  assert.deepEqual(engine.query({ q: 'receptor' }).indices, [0, 1, 2, 5],
    'facet counting must not disturb the cached result');
});

test('facet count keys cannot reach the prototype', () => {
  const engine = createSearchEngine({
    fields: ['unique_record_id', 'antibody_type'],
    rows: [['p0', '__proto__'], ['p1', '__proto__'], ['p2', 'constructor']],
  });
  const counts = engine.facetCounts({}, ['antibody_type']);
  assert.equal(Object.hasOwn(counts.antibody_type, '__proto__'), true);
  assert.equal(counts.antibody_type.__proto__, 2);
  assert.equal(counts.antibody_type.constructor, 1);
});

test('worker acknowledges data loading and returns query, export, lookup, and error messages', async () => {
  const previousSelf = globalThis.self;
  const messages = [];
  let receive;
  globalThis.self = {
    addEventListener(type, callback) {
      assert.equal(type, 'message');
      receive = callback;
    },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../web/search-worker.js');
    const send = (data) => {
      receive({ data });
      return messages.shift();
    };
    assert.equal(send({ type: 'query', id: 1 }).type, 'error');
    assert.deepEqual(send({ type: 'init', index: { fields, rows } }), { type: 'ready' });
    const result = send({ type: 'query', id: 2, query: { q: 'cafe', pageSize: 1 } });
    assert.equal(result.type, 'result');
    assert.equal(result.id, 2);
    assert.equal(result.total, 2);
    assert.deepEqual(result.indices, [0]);
    assert.deepEqual(send({ type: 'export', id: 3, query: { q: 'cafe' } }), {
      type: 'export', id: 3, indices: [0, 2],
    });
    send({ type: 'query', id: 30, query: { q: 'AB-4' } });
    const metadataExport = send({
      type: 'metadataExport', id: 31,
      query: { q: 'cafe', sort: 'patent_id', pageSize: 1, page: 2 },
    });
    assert.deepEqual(metadataExport, {
      type: 'metadataExport', id: 31, fields, rows: [rows[2], rows[0]],
    }, 'export uses its supplied query, includes every match, and preserves sort order');
    assert.equal(metadataExport.rows[0], rows[2], 'worker retains original rows without another dataset copy');
    assert.deepEqual(send({ type: 'lookup', id: 4, recordId: 'r2' }), {
      type: 'lookup', id: 4, index: 2,
    });
    assert.deepEqual(send({ type: 'lookup', id: 5, recordId: 'missing' }), {
      type: 'lookup', id: 5, index: -1,
    });
    assert.equal(send({ type: 'unknown', id: 6 }).type, 'error');
    assert.equal(send({ type: 'init', index: null }).type, 'error');
    assert.equal(send({ type: 'query', id: 7 }).type, 'error', 'failed reload clears previous dataset');
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

/**
 * Each case imports its own copy of the worker: the listener registers once per module instance,
 * and the URL message forms need a `self` with a location plus a fetch stub.
 */
async function startWorker(label, files = new Map()) {
  const previousSelf = globalThis.self;
  const previousFetch = globalThis.fetch;
  const messages = [];
  let receive;
  globalThis.self = {
    location: { href: 'https://example.test/web/search-worker.js', origin: 'https://example.test' },
    addEventListener(type, callback) {
      assert.equal(type, 'message');
      receive = callback;
    },
    postMessage(message) { messages.push(message); },
  };
  globalThis.fetch = async (url) => {
    const file = files.get(String(url));
    if (!file) return new Response('missing', { status: 404 });
    return new Response(file.gzip ? gzipSync(Buffer.from(file.body)) : file.body);
  };
  const module = await import(`../web/search-worker.js?case=${label}`);
  return {
    module,
    messages,
    post: (data) => receive({ data }),
    send: (data) => {
      receive({ data });
      return messages.shift();
    },
    async next() {
      for (let tick = 0; tick < 50 && !messages.length; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return messages.shift();
    },
    restore() {
      if (previousSelf === undefined) delete globalThis.self;
      else globalThis.self = previousSelf;
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
    },
  };
}

test('worker loads the index and the sequence asset from URLs', async () => {
  const worker = await startWorker('urls', new Map([
    ['https://example.test/data/search.json', { body: JSON.stringify({ fields: nameFields, rows: nameRows }) }],
    ['https://example.test/data/sequences.json.gz', { body: JSON.stringify(sequenceAsset()), gzip: true }],
  ]));
  try {
    worker.post({ type: 'init', indexUrl: '/data/search.json' });
    assert.deepEqual(await worker.next(), { type: 'ready' }, 'the main thread never parses the index');
    const result = worker.send({ type: 'query', id: 1, query: { q: 'TGFβ' } });
    assert.equal(result.type, 'result');
    assert.equal(result.total, 2);
    assert.equal(result.unterminatedQuote, false);
    worker.post({ type: 'loadSequences', id: 2, url: '/data/sequences.json', gzipUrl: '/data/sequences.json.gz' });
    assert.deepEqual(await worker.next(), { type: 'loadSequences', id: 2, count: 5 });
    assert.deepEqual(worker.send({ type: 'lookupSequence', id: 3, sequence: 'diqmtqspsslsasvgdrvtitcras' }),
      { type: 'lookupSequence', id: 3, indices: [1, 3] });
    assert.deepEqual(worker.send({ type: 'lookupSequence', id: 4, sequence: 'NOTINDEXED' }),
      { type: 'lookupSequence', id: 4, indices: [] });
    assert.deepEqual(worker.send({ type: 'facetCounts', id: 5, query: { q: 'receptor' }, fields: ['patent_id'] }),
      { type: 'facetCounts', id: 5, counts: { patent_id: { WO3: 1, WO6: 1 } } });
  } finally {
    worker.restore();
  }
});

test('worker falls back to plain JSON and refuses files from another origin', async () => {
  const worker = await startWorker('fallback', new Map([
    ['https://example.test/data/search.json', { body: JSON.stringify({ fields: nameFields, rows: nameRows }) }],
  ]));
  try {
    // The .gz sibling is missing here, so the worker must retry the plain file as app.js does.
    worker.post({ type: 'init', indexUrl: '/data/search.json', gzipUrl: '/data/search.json.gz' });
    assert.deepEqual(await worker.next(), { type: 'ready' });
    assert.equal(worker.send({ type: 'query', id: 1, query: { q: 'PD1' } }).total, 2);
    worker.post({ type: 'init', indexUrl: 'https://elsewhere.test/data/search.json' });
    const refused = await worker.next();
    assert.equal(refused.type, 'error');
    assert.match(refused.message, /invalid file location/);
    assert.equal(worker.send({ type: 'query', id: 2 }).type, 'error', 'a failed reload clears the dataset');
    worker.post({ type: 'init', indexUrl: '/data/missing.json' });
    assert.match((await worker.next()).message, /HTTP 404/);
    worker.post({ type: 'loadSequences', id: 3, url: '/data/sequences.json' });
    assert.equal((await worker.next()).type, 'error', 'sequences need a loaded index');
  } finally {
    worker.restore();
  }
});

test('a cancelled export no longer blocks a queued query', async () => {
  const worker = await startWorker('cancel');
  const { EXPORT_SLICE } = worker.module;
  const fields = ['unique_record_id', 'patent_id'];
  const rows = Array.from({ length: EXPORT_SLICE + 1 }, (unused, position) => [`b${position}`, 'WO1']);
  try {
    assert.deepEqual(worker.send({ type: 'init', index: { fields, rows } }), { type: 'ready' });
    worker.post({ type: 'metadataExport', id: 1, query: {} });
    assert.equal(worker.messages.length, 0, 'an export past one slice yields before answering');
    assert.deepEqual(worker.send({ type: 'cancel', id: 2, cancelId: 1 }), { type: 'cancel', id: 2, cancelId: 1 });
    const queued = worker.send({ type: 'query', id: 3, query: { q: `b${EXPORT_SLICE}` } });
    assert.equal(queued.type, 'result', 'the query is answered while the export is parked');
    assert.equal(queued.total, 1);
    const stopped = await worker.next();
    assert.equal(stopped.type, 'metadataExport');
    assert.equal(stopped.id, 1);
    assert.equal(stopped.cancelled, true);
    assert.deepEqual(stopped.rows, []);
    assert.deepEqual(stopped.fields, fields);

    // Nothing cancels this one, so the whole dataset comes back.
    worker.post({ type: 'export', id: 4, query: {} });
    const finished = await worker.next();
    assert.equal(finished.indices.length, EXPORT_SLICE + 1);
    assert.equal(finished.cancelled, undefined, 'a completed export carries no cancel flag');

    // A cancel without an id withdraws every export in flight.
    worker.post({ type: 'metadataExport', id: 5, query: {} });
    assert.deepEqual(worker.send({ type: 'cancel', id: 6 }), { type: 'cancel', id: 6, cancelId: null });
    assert.equal((await worker.next()).cancelled, true);
    // A cancel for an export that already finished must not affect the next one.
    assert.deepEqual(worker.send({ type: 'cancel', id: 7, cancelId: 5 }), { type: 'cancel', id: 7, cancelId: 5 });
    worker.post({ type: 'metadataExport', id: 5, query: {} });
    assert.equal((await worker.next()).rows.length, EXPORT_SLICE + 1);
  } finally {
    worker.restore();
  }
});
