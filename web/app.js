import { csvLine, safeExternalURL, formatLabel, fastaEntry, canonicalSequence, pastedSequence } from './data-utils.js';
import { TEXT_SEARCH_FIELDS } from './search-core.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
// One formatter for the whole page: a facet draw formats up to 51 counts in a row.
const numberFormat = new Intl.NumberFormat('en-US');
const number = value => numberFormat.format(Number(value));
const FACETS = [
  ['antibody_type', 'Antibody type'],
  ['antibody_discovery_status', 'Discovery status'],
  ['target.target_type', 'Target type'],
  ['target.organism', 'Organism'],
  ['target.binding_affinity.method', 'Assay method'],
  ['discovery_methodology.source_organism', 'Source organism'],
  ['discovery_methodology.specific_platform', 'Discovery platform'],
  ['epitope.type', 'Epitope type'],
  ['audit.verdict', 'Audit verdict'],
];
const PRESENCE = {
  has_affinity: 'Binding affinity', has_epitope: 'Epitope information',
  has_vh: 'Heavy chain sequence', has_vl: 'Light chain sequence',
};
// Rendered options per facet. target.binding_affinity.method has 1,560 distinct values and
// discovery_methodology.specific_platform 1,598 (measured on release v1.0.1), and rebuilding
// every one of them on a keystroke is what made the filter box slow. The option list is 214px
// tall with ~29px rows (styles.css), so 50 rendered options are already about seven screens of
// scrolling; the rest are reached by typing, and "select all matching" covers every match.
const FACET_LIMIT = 50;
const FACET_REDRAW_MS = 120;
// The exact-chain search mode. build.py only keys sequences of 20+ canonical letters, so a
// shorter query can never be in the asset and must not be reported as "no such sequence".
const SEQUENCE_FIELD = 'sequence';
const MINIMUM_SEQUENCE = 20;
// Every letter that occurs in a VH/VL cell of release v1.0.1 (measured over 166,804 indexed
// chains): the standard 20 plus the ambiguity codes B, J, O, X, Z. U never occurs, so excluding
// it keeps ordinary prose from being read as a peptide paste.
const PEPTIDE_TEXT = /^[A-TV-Z]{20,}$/;
const fieldLabels = Object.fromEntries(FACETS);
// One list for the select, the URL and the engine. SEQUENCE_FIELD is not an engine field: it
// routes to the exact-chain lookup instead of the text index.
const searchableFields = ['all', ...TEXT_SEARCH_FIELDS, SEQUENCE_FIELD];
const sortableFields = ['source', 'target.protein_name', 'antibody_identifier', 'patent_id', 'target.organism', 'audit.verdict'];
// Google Patents needs the jurisdiction prefix: /patent/US5419904/en answered 200 and
// /patent/5419904/en answered 404 (measured with curl). Every patent_id in release v1.0.1 is
// 7 or 8 bare digits (measured: 89,074 of 89,074 cells, 10,109 distinct values).
const US_PATENT_ID = /^\d{7,8}$/;
// The real UniProt accession grammar with an optional isoform suffix, capturing the accession so a
// ".2" sequence-version suffix can be displayed but left out of the link. A cell may hold several,
// separated by a comma, a semicolon, a slash or plain whitespace.
const UNIPROT_ACCESSION = /^((?:[OPQ]\d[A-Z0-9]{3}\d|[A-NR-Z]\d(?:[A-Z][A-Z0-9]{2}\d){1,2})(?:-\d+)?)(?:\.\d+)?$/;
// NOT_FOUND is a documented audit verdict, so this one column always prints its literal text.
const PLACEHOLDER_EXEMPT = new Set(['audit.verdict']);
// Residue indices arrive from the CSV as floats. Measured ".0" cells in v1.0.1:
// target.domain_start 19,529, target.domain_end 19,435, epitope range end 5,784, start 5,783.
const INTEGER_CELLS = new Set([
  'epitope.linear_epitope_range.start', 'epitope.linear_epitope_range.end',
  'target.domain_start', 'target.domain_end',
]);
// The index columns this page renders. The worker parses the index now, so checking these against
// the manifest is what remains of the old rows-against-fields check done on a parsed index.
const TABLE_FIELDS = [
  'unique_record_id', 'patent_id', 'antibody_identifier', 'antibody_type', 'target.protein_name',
  'target.gene_names', 'target.uniprot_id', 'target.organism',
  'target.binding_affinity.affinity_value', 'audit.verdict',
];
// FASTA chain labels. The export covers the two antibody chains; the record drawer also offers
// the target sequence, where the label says which chain it is.
const CHAIN_FIELDS = [['vh.sequence_from_patent', 'VH'], ['vl.sequence_from_patent', 'VL']];
const CHAIN_LABELS = {
  'vh.sequence_from_patent': 'VH', 'vl.sequence_from_patent': 'VL',
  'target.sequence_from_patent': 'Target',
};
// Mean export bytes per record, measured over release v1.0.1: 131,778,115 B of full records and
// 16,963,672 B of search-index rows, both over 89,074 records. FASTA: 26,670,323 B over the same
// 89,074 records (166,804 entries, headers included), measured with this file's own formatter.
const CSV_BYTES = { full: 1479, metadata: 190, fasta: 299 };
const EXPORT_KINDS = {
  metadata: { suffix: 'metadata', extension: 'csv', type: 'text/csv;charset=utf-8', label: 'Download CSV' },
  full: { suffix: 'full-records', extension: 'csv', type: 'text/csv;charset=utf-8', label: 'Download CSV' },
  fasta: { suffix: 'sequences', extension: 'fasta', type: 'text/plain;charset=utf-8', label: 'Download FASTA' },
};
const CSV_BATCH = 1000;
// Not a measurement: the point at which an export is worth a second, informed click.
const CONFIRM_BYTES = 20 * 1024 * 1024;
const TOAST_MS = 3800;
// Errors have to survive long enough to be read and acted on.
const ERROR_TOAST_MS = 12000;
let manifest, worker, engine, indexFields, positions, recordPositions, epitopeFields;
let sequence = 0, requestId = 0, recordRequest = 0, debounceTimer, toastTimer, exportController;
let currentRecord = null, ready = false, total = 0, pageCount = 0, latestResult = null;
let recordVersion = null, recordInHistory = false, navigating = false, lastOpener = null;
let exportConfirmed = false;
let placeholders = new Set();
// facets.json, fetched once alongside the index; facetLive is the tally over the current results.
let facetValues = {}, facetLive = null, facetTotals = new Map();
// The sequence asset is only worth its bytes once a chain is actually looked up.
let sequenceAsset = null, sequenceKeys = 0, sequenceLoad = null;
const pending = new Map();
const chunks = new Map();
const facetNodes = new Map();
const state = { q: '', field: 'all', filters: {}, sort: 'source', direction: 'asc', page: 1, pageSize: 25 };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/**
 * A `hidden` live region is outside the accessibility tree, so role="status" never saw a
 * mutation: the text was already there when the region appeared. The region now stays
 * rendered and only its opacity changes, which keeps it in the tree the way #export-progress is.
 */
function showToast(message, { error = false } = {}) {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.style.opacity = '1';
  toast.style.pointerEvents = 'auto';
  toast.textContent = message;
  toastTimer = setTimeout(hideToast, error ? ERROR_TOAST_MS : TOAST_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  const toast = $('#toast');
  toast.style.opacity = '0';
  toast.style.pointerEvents = 'none';
  // Emptied so that repeating the same message is a mutation, and announces again.
  toast.textContent = '';
}

/** build.py's `meaningful()` normalisation, so the UI recognises manifest.placeholders. */
function placeholderToken(text) {
  return text.trim().toLowerCase().replace(/[\s_-]+/gu, ' ').trim();
}

/**
 * build.py's `meaningful()`: manifest.placeholders is exactly its MISSING_VALUES set, so a flag
 * recomputed here from a full record matches the one the builder wrote into the search index.
 */
function isMeaningful(raw) {
  const text = raw === null || raw === undefined ? '' : String(raw);
  return Boolean(text.trim()) && !placeholders.has(placeholderToken(text));
}

/** One raw cell of a 44-column record row, by column name. */
function cellOf(record, field) {
  const at = recordPositions?.[field];
  const value = at === undefined ? '' : record[at];
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Display text for one cell. A placeholder word reads as absent data, and the integer index
 * columns drop the float tail the source CSV carries. '' means "render the em dash".
 */
function displayCell(field, raw) {
  const text = raw === null || raw === undefined ? '' : String(raw);
  if (!text.trim()) return '';
  if (!PLACEHOLDER_EXEMPT.has(field) && !isMeaningful(text)) return '';
  if (INTEGER_CELLS.has(field)) return text.replace(/^(-?\d+)\.0+$/, '$1');
  return text;
}

async function copyText(text, success = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(success);
  } catch {
    const textarea = element('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    const parent = $('dialog[open]') || document.body;
    parent.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (copied) showToast(success);
    else showToast('Copy unavailable. Select the text or copy the link from your address bar.', { error: true });
  }
}

function setExternalLinks(selector, value) {
  const url = safeExternalURL(value);
  // A draft build blanks these on purpose. The markup's hard-coded fallback must not outlive that,
  // or a preview of unpublished data would hand the user the previously published release.
  const blanked = typeof value === 'string' && !value.trim();
  for (const link of $$(selector)) {
    // Otherwise the markup keeps its canonical Zenodo URLs, so these links still work in the one
    // state where the user needs them most: the manifest fetch failed.
    if (url) link.href = url;
    else if (blanked) link.removeAttribute('href');
    link.hidden = !link.getAttribute('href');
  }
}

function dataURL(path) {
  const url = new URL(path, document.baseURI);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL('./', document.baseURI).pathname)) {
    throw new Error('The dataset references an invalid file location.');
  }
  return url.href;
}

async function fetchJSON(path, gzipPath, signal) {
  if (gzipPath && 'DecompressionStream' in globalThis) {
    try {
      const response = await fetch(dataURL(gzipPath), { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // A host that serves .gz with Content-Encoding has already inflated the body; piping that
      // through DecompressionStream again would fail and cost a second, much larger download.
      if ((response.headers.get('content-encoding') || '').includes('gzip')) return await response.json();
      return await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
    } catch (error) {
      if (signal?.aborted) throw error;
      // JSON is a portable fallback if the host/browser does not serve gzip files. Say so: the
      // fallback is several times larger, so a misconfigured host should not degrade in silence.
      if (path) console.warn(`POISK Explorer: could not read ${gzipPath} (${error.message}); falling back to the uncompressed ${path}.`);
    }
  }
  // A gzip-only build omits the plain URL entirely rather than publishing a dead one.
  if (!path) throw new Error('This release publishes only compressed data files, which this browser could not read.');
  const response = await fetch(dataURL(path), { signal, cache: path.endsWith('manifest.json') ? 'no-cache' : 'default' });
  if (!response.ok) throw new Error(`Could not load dataset file (HTTP ${response.status}). If the dataset was updated, reload this page.`);
  return response.json();
}

function readURL() {
  const params = new URLSearchParams(location.search);
  state.q = params.get('q') || '';
  state.field = searchableFields.includes(params.get('field')) ? params.get('field') : 'all';
  // A release that publishes no sequence asset has no exact-chain mode to select.
  if (state.field === SEQUENCE_FIELD && manifest && !sequenceAsset) state.field = 'all';
  state.sort = sortableFields.includes(params.get('sort')) ? params.get('sort') : 'source';
  state.direction = params.get('direction') === 'desc' ? 'desc' : 'asc';
  state.page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  state.pageSize = [25, 50, 100].includes(Number(params.get('size'))) ? Number(params.get('size')) : 25;
  state.filters = {};
  for (const [field] of FACETS) {
    // Repeated parameters, never one comma-joined value: real labels contain commas
    // ("Animal Immunization, Rational Design").
    const values = [...new Set(params.getAll(field))];
    if (values.length) state.filters[field] = values;
  }
  for (const field of Object.keys(PRESENCE)) {
    if (params.get(field) === 'true') state.filters[field] = true;
  }
  currentRecord = params.get('record');
  recordVersion = params.get('v');
}

/** The search-relevant state only, so a record open/close does not look like a new search. */
function searchKey() {
  return JSON.stringify([state.q, state.field, state.filters, state.sort, state.direction, state.page, state.pageSize]);
}

function writeURL({ push = false } = {}) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.field !== 'all') params.set('field', state.field);
  for (const [key, value] of Object.entries(state.filters)) {
    // One parameter per selected value, read back with getAll.
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.set(key, String(value));
  }
  if (state.sort !== 'source') params.set('sort', state.sort);
  if (state.direction !== 'asc') params.set('direction', state.direction);
  if (state.page > 1) params.set('page', state.page);
  if (state.pageSize !== 25) params.set('size', state.pageSize);
  if (currentRecord) {
    params.set('record', currentRecord);
    // unique_record_id is regenerated for every release, so a shared record link has to carry
    // the version it belongs to; otherwise a stale link is indistinguishable from a typo.
    const version = recordVersion || manifest?.dataset.version;
    if (version) params.set('v', version);
  }
  const url = `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`;
  // Opening a record is a step the Back button must undo. Searching, filtering and paging
  // edit the current entry, so Back still leaves the site in one press.
  history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function send(type, payload) {
  if (engine) {
    if (type === 'query') return Promise.resolve(engine.query(payload));
    if (type === 'export') return Promise.resolve({ indices: engine.matchingIndices(payload) });
    if (type === 'lookup') return Promise.resolve({ index: engine.lookup(payload) });
    if (type === 'metadataExport') return Promise.resolve({ fields: engine.raw.fields, rows: engine.matchingIndices(payload).map(i => engine.raw.rows[i]) });
    // In-process exports answer synchronously, so there is never a loop left to interrupt.
    if (type === 'cancel') return Promise.resolve({ cancelId: payload ?? null });
    if (type === 'facetCounts') return Promise.resolve({ counts: engine.facetCounts(payload.query, payload.fields) });
    if (type === 'lookupSequence') return Promise.resolve({ indices: engine.lookupSequence(payload) });
    // The worker fetches the asset itself; without one, this side does the fetching.
    if (type === 'loadSequences') return fetchJSON(payload.url, payload.gzipUrl).then(asset => ({ count: engine.loadSequences(asset) }));
  }
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (type === 'lookup') worker.postMessage({ type, id, recordId: payload });
    else if (type === 'cancel') worker.postMessage({ type, id, cancelId: payload ?? null });
    else if (type === 'lookupSequence') worker.postMessage({ type, id, sequence: payload });
    else if (type === 'loadSequences') worker.postMessage({ type, id, url: payload.url, gzipUrl: payload.gzipUrl });
    else if (type === 'facetCounts') worker.postMessage({ type, id, query: payload.query, fields: payload.fields });
    else worker.postMessage({ type, id, query: payload });
  });
}

/**
 * The worker loads the index from its URL, so the main thread never parses or structured-clones
 * it (measured on a full rebuild of release v1.0.1: search.json is 16,340,593 bytes, 1,718,260
 * gzipped). Only the in-process fallback, for a browser that cannot start a module worker, pays
 * that cost.
 */
async function startEngine(source) {
  worker?.terminate();
  engine = null;
  sequenceLoad = null;
  sequenceKeys = 0;
  // A gzip-only build publishes no plain URL; the worker's own fetch falls back the same way.
  const indexUrl = source.url || source.gzipUrl;
  try {
    worker = new Worker(new URL('./search-worker.js', import.meta.url), { type: 'module' });
    await new Promise((resolve, reject) => {
      let initialized = false;
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') { initialized = true; resolve(); return; }
        if (!initialized && data.type === 'error') { reject(new Error(data.message)); return; }
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.type === 'error') request.reject(new Error(data.message));
        else request.resolve(data);
      };
      worker.onerror = event => {
        if (!initialized) reject(new Error(event.message || 'Search worker could not start.'));
        else {
          for (const request of pending.values()) request.reject(new Error('Search stopped unexpectedly. Reload the page to retry.'));
          pending.clear();
          showToast('Search stopped unexpectedly. Reload the page to retry.', { error: true });
        }
      };
      // Absolute same-origin hrefs; the worker re-checks the origin before it fetches.
      worker.postMessage({ type: 'init', indexUrl: dataURL(indexUrl), gzipUrl: source.gzipUrl && dataURL(source.gzipUrl) });
    });
  } catch {
    worker?.terminate();
    const [{ createSearchEngine }, index] = await Promise.all([import('./search-core.js'), fetchJSON(source.url, source.gzipUrl)]);
    engine = createSearchEngine(index);
    engine.raw = index;
  }
}

function renderMetadata() {
  const dataset = manifest.dataset;
  $('#record-count').textContent = number(manifest.counts.records);
  $('#patent-count').textContent = number(manifest.counts.patents);
  $('#version').textContent = `v${dataset.version}`;
  $('#footer-version').textContent = `Dataset v${dataset.version}`;
  $('#citation-text').textContent = dataset.citation || 'Citation information is available with the dataset release.';
  $('#license-text').textContent = dataset.license ? `Dataset license: ${dataset.license}` : 'License details are provided with the Zenodo release.';
  setExternalLinks('.source-link', dataset.recordUrl);
  setExternalLinks('.full-download-link', dataset.downloadUrl);
  $('#copy-citation').disabled = !dataset.citation;
  // Distinct indexed VH/VL chains. Absent in a build from the previous contract.
  const sequences = manifest.counts.sequences;
  if (sequences) $('#sequence-summary').textContent = `${number(sequences)} distinct VH/VL sequences`;
  $('#guide-sequence-count').textContent = sequences ? number(sequences) : '—';
  // Measured per release rather than written into the markup, so a re-pin cannot leave a stale
  // figure behind. Older manifests carry neither counter; the generic sentence stands in for them.
  const { chainCells, nonStandardChainCells } = manifest.counts;
  if (Number.isFinite(chainCells) && Number.isFinite(nonStandardChainCells) && chainCells > 0) {
    $('#export-fasta-note').textContent = nonStandardChainCells
      ? `In this release, ${number(nonStandardChainCells)} of ${number(chainCells)} chain cells contain letters outside the standard 20 amino acids, so strict numbering tools may reject those entries.`
      : `Every chain in this release uses only the standard 20 amino acids.`;
  }
}

/** Every value selected in one facet. Several values in one field are ORed by the engine. */
function selectedValues(field) {
  const chosen = state.filters[field];
  return Array.isArray(chosen) ? chosen : [];
}

function setFacetValues(field, values) {
  if (values.length) state.filters[field] = values;
  else delete state.filters[field];
  state.page = 1;
  syncControls();
  runSearch();
}

/** Live tally over the current results; the build-time total until the first query answers. */
function optionCount(field, item) {
  const live = facetLive?.[field];
  if (!live) return item.count;
  // hasOwn, not `??`: a raw cell called "toString" would otherwise read a prototype function.
  return Object.hasOwn(live, item.value) ? live[item.value] : 0;
}

function facetTotal(field) {
  return facetTotals.get(field) ?? manifest.counts.records;
}

function anyOption(field, label) {
  const option = element('button', 'facet-option');
  option.type = 'button';
  option.dataset.facetField = field;
  option.dataset.facetAction = 'any';
  // A clear control, not a checkbox: it is pressed exactly when nothing in the facet is selected.
  option.setAttribute('aria-pressed', String(!selectedValues(field).length));
  option.append(element('span', '', `Any ${label.toLocaleLowerCase()}`), element('span', '', number(facetTotal(field))));
  return option;
}

function facetOption(field, item, checked) {
  const option = element('button', 'facet-option');
  option.type = 'button';
  // A checkbox row rather than a toggle button, because the selections accumulate.
  option.setAttribute('role', 'checkbox');
  option.setAttribute('aria-checked', String(checked));
  option.dataset.facetField = field;
  option.dataset.facetAction = 'value';
  option.dataset.facetValue = item.value;
  const box = element('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.tabIndex = -1;
  // The row is the control and the box is its picture; styles.css already stops clicks on it.
  box.setAttribute('aria-hidden', 'true');
  const text = element('span', '', item.label);
  // styles.css wraps `.facet-option>span:first-child`, which the checkbox now occupies.
  text.style.overflowWrap = 'anywhere';
  option.append(box, text, element('span', '', number(optionCount(field, item))));
  return option;
}

/** Redraw one facet's option list: on open, and (debounced) as its search box is typed into. */
function drawFacet(field) {
  const nodes = facetNodes.get(field);
  if (!nodes) return;
  const query = nodes.search.value.trim().toLocaleLowerCase();
  const values = facetValues[field] || [];
  const matching = query ? values.filter(item => item.label.toLocaleLowerCase().includes(query)) : values;
  const chosen = new Set(selectedValues(field));
  // Selected values first, so a selection stays visible in a list capped at FACET_LIMIT.
  const ordered = chosen.size
    ? [...matching.filter(item => chosen.has(item.value)), ...matching.filter(item => !chosen.has(item.value))]
    : matching;
  const fragment = document.createDocumentFragment();
  fragment.append(anyOption(field, nodes.label));
  for (const item of ordered.slice(0, FACET_LIMIT)) fragment.append(facetOption(field, item, chosen.has(item.value)));
  const hidden = matching.length - FACET_LIMIT;
  if (hidden > 0) fragment.append(element('p', 'facet-more', `${number(hidden)} more ${hidden === 1 ? 'label' : 'labels'} not shown. Type to narrow the list, or select every match above.`));
  if (!matching.length) fragment.append(element('p', 'facet-empty', 'No matching labels'));
  nodes.options.replaceChildren(fragment);
  nodes.matching = matching;
  // Selecting every match is what makes a 1,560-value list usable; it covers matches that the
  // FACET_LIMIT cap left unrendered, so it is only offered once the list has been narrowed.
  nodes.selectAll.hidden = !query || matching.length < 2;
  nodes.selectAll.textContent = `Select all ${number(matching.length)} matching`;
}

/** State changed without a redraw: update the rendered rows in place so focus survives. */
function syncFacetOptions() {
  for (const [field, nodes] of facetNodes) {
    const chosen = new Set(selectedValues(field));
    for (const option of $$('[data-facet-action]', nodes.options)) {
      if (option.dataset.facetAction === 'any') {
        option.setAttribute('aria-pressed', String(!chosen.size));
        continue;
      }
      const checked = chosen.has(option.dataset.facetValue);
      option.setAttribute('aria-checked', String(checked));
      const box = $('input', option);
      if (box) box.checked = checked;
    }
  }
}

/** The counts the last query produced, written over the rendered rows without rebuilding them. */
function applyFacetCounts() {
  for (const [field, nodes] of facetNodes) {
    const live = facetLive?.[field];
    if (!live) continue;
    for (const option of $$('[data-facet-action]', nodes.options)) {
      const value = option.dataset.facetValue;
      option.lastElementChild.textContent = number(option.dataset.facetAction === 'any'
        ? facetTotal(field)
        : Object.hasOwn(live, value) ? live[value] : 0);
    }
  }
}

function renderFacets() {
  const root = $('#facets');
  root.replaceChildren();
  facetNodes.clear();
  for (const [field, label] of FACETS) {
    // A field this release does not publish values for gets no control at all.
    if (!Array.isArray(facetValues[field]) || !facetValues[field].length) continue;
    const facet = element('details', 'facet');
    const summary = element('summary');
    summary.append(element('span', '', label));
    const selected = element('span', 'facet-selected');
    selected.dataset.selectedField = field;
    summary.append(selected);
    const search = element('input', 'facet-search');
    search.type = 'search';
    search.placeholder = `Find ${label.toLowerCase()}…`;
    search.setAttribute('aria-label', `Find ${label.toLowerCase()} filter options`);
    const selectAll = element('button', 'facet-select-all');
    selectAll.type = 'button';
    selectAll.hidden = true;
    selectAll.dataset.facetField = field;
    selectAll.dataset.facetAction = 'all';
    const options = element('div', 'facet-options');
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', `${label} values`);
    facet.append(summary, search, selectAll, options);
    facetNodes.set(field, { facet, summary, search, selectAll, options, label, matching: facetValues[field] });
    let redraw;
    search.addEventListener('input', () => {
      // One keystroke used to rebuild every option; these lists reach 1,598 values (measured).
      clearTimeout(redraw);
      redraw = setTimeout(() => drawFacet(field), FACET_REDRAW_MS);
    });
    facet.addEventListener('toggle', () => {
      if (!facet.open) return;
      for (const other of facetNodes.values()) if (other.facet !== facet) other.facet.open = false;
      search.value = '';
      drawFacet(field);
      search.focus();
    });
    root.append(facet);
  }
  if (!facetNodes.size) root.append(element('div', 'filter-placeholder', 'This release publishes no filter values.'));
}

/**
 * facets.json is content-addressed, so unlike manifest.json it is immutable and cacheable, and
 * it is fetched alongside the index instead of being inlined in the manifest (measured: 318,236
 * bytes of facet values for this release, 49,836 gzipped).
 */
async function loadFacets() {
  const pointer = manifest.facets || {};
  // A build from the previous contract inlined the values under manifest.facets itself.
  const asset = pointer.url || pointer.gzipUrl ? await fetchJSON(pointer.url, pointer.gzipUrl) : { fields: pointer };
  const fields = asset?.fields;
  facetValues = fields && typeof fields === 'object' ? fields : {};
}

/**
 * A hand-edited link must not produce a filter chip for a value that exists nowhere, so every
 * facet value from the URL is checked against the loaded list. Returns what was dropped.
 */
function validateFacetFilters() {
  const dropped = [];
  for (const [field, label] of FACETS) {
    const chosen = selectedValues(field);
    const known = facetValues[field];
    if (!chosen.length || !Array.isArray(known)) continue;
    const allowed = new Set(known.map(item => item.value));
    const kept = chosen.filter(value => allowed.has(value));
    if (kept.length === chosen.length) continue;
    for (const value of chosen) if (!allowed.has(value)) dropped.push(`${label}: ${value || '(blank)'}`);
    setFilterValues(field, kept);
  }
  return dropped;
}

/** Set without re-running the search: the caller is still assembling the state. */
function setFilterValues(field, values) {
  if (values.length) state.filters[field] = values;
  else delete state.filters[field];
}

function reportDroppedFilters(dropped) {
  if (!dropped.length) return;
  const shown = dropped.slice(0, 3).join('; ');
  showToast(`${dropped.length === 1 ? 'A filter value' : `${number(dropped.length)} filter values`} in this link ${dropped.length === 1 ? 'is' : 'are'} not in dataset v${manifest.dataset.version} and ${dropped.length === 1 ? 'was' : 'were'} removed: ${shown}${dropped.length > 3 ? '…' : ''}`, { error: true });
}

function syncControls() {
  $('#search-input').value = state.q;
  $('#search-field').value = state.field;
  $('#page-size').value = String(state.pageSize);
  for (const node of $$('[data-presence]')) node.checked = state.filters[node.dataset.presence] === true;
  for (const node of $$('[data-selected-field]')) {
    const chosen = selectedValues(node.dataset.selectedField);
    node.textContent = !chosen.length ? 'Any'
      : chosen.length === 1 ? chosen[0] || 'Not reported' : `${number(chosen.length)} selected`;
    node.title = node.textContent;
  }
  syncFacetOptions();
  // Every selected value counts, not every field: one facet now holds several.
  const count = Object.values(state.filters).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 1), 0);
  $('#filter-count').hidden = !count;
  $('#filter-count').textContent = number(count);
  $('#reset-filters').disabled = !count;
  const active = $('#active-filters');
  active.replaceChildren();
  active.hidden = !count;
  for (const [field, value] of Object.entries(state.filters)) {
    // One chip per value, so a single value can be removed without clearing the facet.
    for (const item of Array.isArray(value) ? value : [value]) {
      const label = PRESENCE[field] || `${fieldLabels[field]}: ${item || 'Not reported'}`;
      const button = element('button', 'filter-chip');
      button.type = 'button';
      button.append(element('span', '', label), element('b', '', '×'));
      button.setAttribute('aria-label', `Remove filter ${label}`);
      button.addEventListener('click', () => {
        // syncControls rebuilds this list, so the chip under the pointer stops existing. Remember
        // where it was and put focus on its successor instead of dropping it to <body>.
        const at = [...active.children].indexOf(button);
        if (Array.isArray(state.filters[field])) setFilterValues(field, selectedValues(field).filter(kept => kept !== item));
        else delete state.filters[field];
        state.page = 1;
        syncControls();
        const remaining = active.children;
        if (remaining.length) remaining[Math.min(at, remaining.length - 1)].focus();
        else if (!$('#reset-filters').disabled) $('#reset-filters').focus();
        else $('#results').focus();
        runSearch();
      });
      active.append(button);
    }
  }
  for (const header of $$('th[data-sort]')) {
    const activeSort = header.dataset.sort === state.sort;
    if (activeSort) header.setAttribute('aria-sort', state.direction === 'asc' ? 'ascending' : 'descending');
    else header.removeAttribute('aria-sort');
    $('span', header).textContent = activeSort ? (state.direction === 'asc' ? '↑' : '↓') : '↕';
  }
}

function auditBadge(verdict) {
  const badge = element('span', 'audit-badge', verdict || 'Not reported');
  const normalized = (verdict || '').toUpperCase();
  if (normalized === 'PLAUSIBLE') badge.classList.add('plausible');
  else if (normalized === 'CONTRADICTED') badge.classList.add('contradicted');
  else if (normalized !== 'CONFIRMED') badge.classList.add('not-found');
  return badge;
}

function renderRows(result) {
  const body = $('#result-rows');
  const fragment = document.createDocumentFragment();
  result.rows.forEach((row, rowNumber) => {
    const raw = key => {
      const cell = row[positions[key]];
      return cell === null || cell === undefined ? '' : String(cell);
    };
    const value = key => displayCell(key, raw(key));
    const cell = (key, className = '') => {
      const text = value(key);
      const td = element('td', text ? className : [className, 'missing'].filter(Boolean).join(' '), text || '—');
      // A suppressed placeholder stays reachable: the source cell did say something.
      if (!text && raw(key).trim()) td.title = raw(key);
      return td;
    };
    const tr = element('tr');
    const target = element('td');
    const title = element('span', 'cell-primary', value('target.protein_name') || 'Target not reported');
    title.title = title.textContent;
    target.append(title);
    const targetIdentifiers = [value('target.gene_names'), value('target.uniprot_id')].filter(Boolean).join(' · ');
    if (targetIdentifiers) target.append(element('span', 'cell-secondary', targetIdentifiers));
    const antibody = element('td');
    const antibodyTitle = element('span', 'cell-primary', value('antibody_identifier') || 'Not reported');
    antibodyTitle.title = antibodyTitle.textContent;
    antibody.append(antibodyTitle, element('span', 'cell-secondary', value('antibody_type')));
    const audit = element('td');
    audit.append(auditBadge(raw('audit.verdict')));
    const action = element('td');
    const button = element('button', 'open-record', '›');
    button.type = 'button';
    button.setAttribute('aria-label', `Open record ${raw('unique_record_id')}`);
    const open = () => openRecord(result.indices[rowNumber], raw('unique_record_id'), { push: true, opener: button });
    // The button is the real control, so it opens the record even when the row click is ignored.
    button.addEventListener('click', event => { event.stopPropagation(); open(); });
    action.append(button);
    tr.append(target, antibody, cell('patent_id', 'patent-cell'), cell('target.organism'),
      cell('target.binding_affinity.affinity_value'), audit, action);
    tr.addEventListener('click', () => {
      // Selecting text in a cell ends in a click; that must not throw the drawer open.
      const selection = getSelection();
      if (selection && !selection.isCollapsed) return;
      open();
    });
    fragment.append(tr);
  });
  body.replaceChildren(fragment);
}

function showLoadError(message) {
  $('#loading-state').hidden = true;
  $('#load-error').hidden = false;
  $('#load-error-message').textContent = message;
  $('#results-count').textContent = 'Collection unavailable';
  $('#results-description').textContent = 'Use the retry button above to load the collection.';
  $('#search-status').textContent = `The collection could not be loaded. ${message}`;
  $('#results').setAttribute('aria-busy', 'false');
}

/** True while an exact chain lookup is what produced the rows on screen. */
function lookupActive() {
  return Boolean(sequenceAsset) && state.field === SEQUENCE_FIELD && Boolean(state.q.trim());
}

/** The query as a chain, if it reads as one: letters only after whitespace and digits go. */
function peptideQuery(value) {
  const letters = pastedSequence(value);
  return PEPTIDE_TEXT.test(letters) ? letters : '';
}

/**
 * A FASTA record whose line breaks are already gone, so its description has been welded onto the
 * chain. The paste handler catches the usual route; this catches drag-and-drop, a browser that
 * hands over no clipboard data, and a hand-edited URL. The two cannot be separated after the fact
 * — a target name is letters and spaces just like residues — so say what happened instead.
 */
function mangledFasta(value) {
  return /^\s*>/u.test(value) && !/[\r\n]/u.test(value);
}

/** Why there are no rows. A lookup needs its own explanation, not "try fewer filters". */
function emptyMessage() {
  if (!lookupActive()) return 'Try a shorter identifier, another target name, or fewer filters.';
  if (mangledFasta(state.q)) {
    return 'This looks like a FASTA record whose description line has been merged into the sequence, so no chain was compared. Paste the residue lines on their own, or paste the record again with the keyboard.';
  }
  if (pastedSequence(state.q).length < MINIMUM_SEQUENCE) {
    return `A chain needs at least ${MINIMUM_SEQUENCE} residues to be looked up, so this text was not compared. Paste a complete VH or VL sequence.`;
  }
  return 'No record in this release reports this exact chain. The comparison is whole-chain and exact, so a fragment or a single-residue difference does not match — an empty result is not evidence that a sequence is unpatented.';
}

/**
 * One composed live message. A sort rewrites every row while the record count is unchanged and
 * focus stays put, so without this nothing at all is announced.
 */
function announceResults() {
  const order = lookupActive()
    ? 'Exact chain matches, in dataset order'
    : state.sort === 'source'
      ? (state.q ? 'Sorted by relevance' : `In ${state.direction === 'desc' ? 'reverse ' : ''}dataset order`)
      : `Sorted by ${formatLabel(state.sort)}, ${state.direction === 'desc' ? 'descending' : 'ascending'}`;
  $('#search-status').textContent = total === 0
    ? `No matching records. ${emptyMessage()}`
    : `${number(total)} ${total === 1 ? 'record' : 'records'}. ${order}. Showing ${$('#page-range').textContent}, page ${number(state.page)} of ${number(pageCount)}.`;
}

/** The three notices that explain what the engine just did, and the hint that offers a lookup. */
function updateSearchFeedback(result) {
  const warning = $('#search-warning');
  warning.hidden = !result.unterminatedQuote;
  if (result.unterminatedQuote) warning.textContent = 'Unclosed quotation mark: the rest of the query was read as one phrase.';
  // search-core.js ranks matches only while the implicit source order is in effect.
  const ranked = Boolean(state.q.trim()) && state.sort === 'source' && !lookupActive();
  const note = $('#relevance-note');
  note.hidden = !ranked;
  if (ranked) {
    note.textContent = state.direction === 'desc'
      ? 'Ordered by match quality, weakest match first.'
      : 'Ordered by match quality rather than dataset order: whole-word hits on a target or antibody name rank first.';
  }
  $('#empty-detail').textContent = emptyMessage();
  updateSequenceHint();
  pauseBrowseControls(lookupActive());
}

function updateSequenceHint() {
  const hint = $('#sequence-hint');
  const text = $('#sequence-hint-text');
  const action = $('#sequence-hint-action');
  if (lookupActive()) {
    const chains = sequenceKeys || manifest?.counts.sequences || 0;
    text.textContent = mangledFasta(state.q)
      ? 'FASTA description line merged into the sequence: nothing was compared. Paste the residue lines on their own.'
      : pastedSequence(state.q).length < MINIMUM_SEQUENCE
      ? `Exact chain match: text shorter than ${MINIMUM_SEQUENCE} residues is not indexed and was not compared.`
      : `Exact whole-chain match${chains ? ` against ${number(chains)} distinct VH/VL chains` : ''}: letters only, no alignment and no partial matching. Filters and column sorting are paused.`;
    action.textContent = 'Search identifiers instead';
    action.hidden = false;
    hint.hidden = false;
    return;
  }
  // A pasted chain finds nothing in the identifier fields, so offer the lookup instead of 0 rows.
  if (sequenceAsset && peptideQuery(state.q)) {
    text.textContent = 'That looks like a chain sequence, and identifier search does not look inside sequences.';
    action.textContent = 'Match it as an exact VH/VL chain';
    action.hidden = false;
    hint.hidden = false;
    return;
  }
  hint.hidden = true;
  action.hidden = true;
}

/**
 * A lookup is answered from the sequence asset by hash, so the engine's filters and column sort
 * play no part in it. Controls that would silently do nothing go out of service while one is
 * active, which is also what the hint above states.
 */
function pauseBrowseControls(paused) {
  for (const node of [$('#facets'), $('.availability')]) {
    node.inert = paused;
    node.style.opacity = paused ? '0.5' : '';
  }
  for (const header of $$('th[data-sort] button')) header.disabled = paused;
}

/** One fetch of sequences.json per page view, the first time a chain is actually looked up. */
function loadSequenceIndex() {
  if (!sequenceAsset) return Promise.reject(new Error('This release does not publish a sequence index, so exact chain lookup is unavailable.'));
  sequenceLoad ??= send('loadSequences', sequenceAsset)
    .then(reply => { sequenceKeys = reply.count; return reply.count; })
    .catch(error => {
      // A failed load must not poison the next attempt.
      sequenceLoad = null;
      throw error;
    });
  return sequenceLoad;
}

/**
 * Exact chain lookup. The engine answers with row indices into the search index, and that index
 * no longer lives on this thread, so the cells come from the detail chunks of the rows on the
 * current page: one chunk for most chains (measured: a key spans 2.05 chunks on average, median
 * 1, at most 146 of the 223 chunks for the single most repeated chain in release v1.0.1).
 */
async function lookupSequenceRows(query) {
  const empty = { total: 0, page: 1, pageCount: 0, indices: [], rows: [], matches: [], unterminatedQuote: false };
  if (pastedSequence(query.q).length < MINIMUM_SEQUENCE) return empty;
  await loadSequenceIndex();
  // Pass the residues, never the raw paste: a FASTA header's letters would change the hash.
  const { indices } = await send('lookupSequence', pastedSequence(query.q));
  if (!indices.length) return empty;
  const pageCount = Math.ceil(indices.length / query.pageSize);
  const page = Math.min(Math.max(1, pageCount), query.page);
  const slice = indices.slice((page - 1) * query.pageSize, page * query.pageSize);
  const places = indexFields.map(field => recordPositions[field]);
  const rows = await collectRecords(slice, record => places.map(at => (at === undefined ? '' : record[at])));
  return { total: indices.length, page, pageCount, indices: slice, rows, matches: indices, unterminatedQuote: false };
}

/**
 * Facet numbers that follow the current results instead of the build-time totals. Measured in
 * node against release v1.0.1 (89,074 rows, the six facet fields its index carries): 51.7 ms for
 * the whole dataset, 6.0 ms once an organism filter narrows it, median of 5 runs. So: once per
 * search, in the worker — never once per option or once per keystroke.
 */
async function refreshFacetCounts(call, query) {
  const fields = [...facetNodes.keys()];
  if (!fields.length) return;
  try {
    const { counts } = await send('facetCounts', { query, fields });
    if (call !== sequence) return;
    const live = { ...counts };
    // A facet with a selection of its own would otherwise read 0 beside every value the user has
    // not picked, which is the one number a multi-select facet must never show. Its own options
    // are counted against the other filters, so adding a second value stays an informed choice.
    for (const field of fields) {
      if (!selectedValues(field).length) continue;
      const others = { ...query, filters: { ...query.filters } };
      delete others.filters[field];
      const reply = await send('facetCounts', { query: others, fields: [field] });
      if (call !== sequence) return;
      live[field] = reply.counts[field];
    }
    facetLive = live;
    // Every row holds exactly one value per field, so a field's counts sum to its match set.
    facetTotals = new Map(fields.map(field => [field, Object.values(live[field] || {}).reduce((sum, value) => sum + value, 0)]));
    applyFacetCounts();
  } catch {
    // Keeping the previous counts beats a toast on every search; the rows are unaffected.
  }
}

async function runSearch() {
  if (!ready) return;
  const call = ++sequence;
  $('#results').setAttribute('aria-busy', 'true');
  $('#export-results').disabled = true;
  try {
    const query = structuredClone(state);
    const result = lookupActive() ? await lookupSequenceRows(query) : await send('query', query);
    if (call !== sequence) return;
    $('#load-error').hidden = true;
    latestResult = result;
    total = result.total;
    pageCount = result.pageCount;
    state.page = result.page;
    $('#results-count').textContent = `${number(total)} ${total === 1 ? 'record' : 'records'}`;
    const constrained = Boolean(state.q || Object.keys(state.filters).length);
    $('#results-description').textContent = lookupActive()
      ? `Exact VH/VL chain match · ${number(manifest.counts.records)} records in the collection`
      : constrained ? `Matching your selection · ${number(manifest.counts.records)} in the collection` : 'Across the complete collection';
    $('#loading-state').hidden = true;
    $('#empty-state').hidden = total !== 0;
    $('#table-container').hidden = total === 0;
    $('#pagination').hidden = total === 0;
    $('#export-results').disabled = total === 0;
    renderRows(result);
    $('#page-range').textContent = `${number((state.page - 1) * state.pageSize + 1)}–${number(Math.min(state.page * state.pageSize, total))} of ${number(total)}`;
    $('#page-position').textContent = `${number(state.page)} / ${number(pageCount)}`;
    $('#first-page').disabled = $('#previous-page').disabled = state.page <= 1;
    $('#next-page').disabled = $('#last-page').disabled = state.page >= pageCount;
    syncControls();
    updateSearchFeedback(result);
    announceResults();
    writeURL();
    // A lookup has no engine match set to tally, and its facets are paused: the numbers on
    // screen keep describing the filtered browse the user will come back to.
    if (!lookupActive()) refreshFacetCounts(call, query);
  } catch (error) {
    if (call !== sequence) return;
    // A toast alone left the spinner turning forever with the retry button out of reach.
    showLoadError(error.message);
  } finally {
    if (call === sequence) $('#results').setAttribute('aria-busy', 'false');
  }
}

async function loadChunk(chunk, { signal, cache = true } = {}) {
  if (cache && chunks.has(chunk)) {
    const existing = chunks.get(chunk);
    chunks.delete(chunk);
    chunks.set(chunk, existing);
    return existing;
  }
  const details = manifest.details;
  const data = await fetchJSON(details.pattern?.replace('{chunk}', chunk), details.gzipPattern?.replace('{chunk}', chunk), signal);
  if (data.start !== chunk * details.chunkSize || !Array.isArray(data.rows) || data.rows.some(row => !Array.isArray(row) || row.length !== manifest.fields.length)) {
    throw new Error('Record data does not match this release. Reload the page and try again.');
  }
  if (cache) {
    chunks.set(chunk, data);
    if (chunks.size > 8) chunks.delete(chunks.keys().next().value);
  }
  return data;
}

/**
 * Fetch the full records for `indices`, four chunks at a time, and convert each record as it
 * arrives. Converting inside the loop is what keeps a whole-collection export from holding the
 * records and their formatted copies at the same time. The result is parallel to `indices`, and
 * stays sparse when the signal aborts, so callers can tell a short answer from a complete one.
 */
async function collectRecords(indices, convert, { signal, cache = true, onProgress } = {}) {
  const groups = new Map();
  indices.forEach((index, position) => {
    const chunk = Math.floor(index / manifest.details.chunkSize);
    if (!groups.has(chunk)) groups.set(chunk, []);
    groups.get(chunk).push({ index, position });
  });
  const queue = [...groups.entries()];
  const output = new Array(indices.length);
  let next = 0, completed = 0;
  const fetchNext = async () => {
    while (next < queue.length) {
      if (signal?.aborted) return;
      const [chunkNumber, wanted] = queue[next++];
      const chunk = await loadChunk(chunkNumber, { signal, cache });
      for (const { index, position } of wanted) {
        const row = chunk.rows[index - chunk.start];
        if (!row) throw new Error('A requested record was missing. Reload the page and try again.');
        output[position] = convert(row);
      }
      completed += wanted.length;
      onProgress?.(completed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, fetchNext));
  return output;
}

/**
 * One FASTA entry per chain the record actually reports, headed by record ID, chain, antibody,
 * patent, and target. Measured over release v1.0.1: 166,804 entries, 26,670,323 bytes.
 */
function fastaFromRecord(record) {
  const header = {
    id: cellOf(record, 'unique_record_id'),
    antibody: cellOf(record, 'antibody_identifier'),
    patent: cellOf(record, 'patent_id'),
    target: cellOf(record, 'target.protein_name'),
  };
  let text = '';
  for (const [field, chain] of CHAIN_FIELDS) {
    const sequence = cellOf(record, field);
    // A placeholder word is not a chain, and a cell of digits canonicalises to nothing.
    if (!isMeaningful(sequence) || !canonicalSequence(sequence)) continue;
    text += fastaEntry({ ...header, chain, sequence });
  }
  return text;
}

/**
 * The search-index row rebuilt from a full record, so an exact-chain lookup can export the same
 * metadata columns a search exports. The flags repeat build.py's rule: a cell counts when it is
 * neither blank nor one of manifest.placeholders.
 */
function metadataRow(record) {
  return indexFields.map(field => {
    if (field === 'has_epitope') return epitopeFields.some(name => isMeaningful(cellOf(record, name)));
    if (field === 'has_affinity') return isMeaningful(cellOf(record, 'target.binding_affinity.affinity_value'));
    if (field === 'has_vh') return isMeaningful(cellOf(record, 'vh.sequence_from_patent'));
    if (field === 'has_vl') return isMeaningful(cellOf(record, 'vl.sequence_from_patent'));
    return cellOf(record, field);
  });
}

/**
 * Real cells hold several accessions ("P13612, P26010", "P06756/P18564", "P05231 P08887") and
 * placeholder words. Split on the separators but keep them, so the cell still reads exactly as the
 * source wrote it while every accession in it becomes a link.
 */
function appendUniprot(dd, text) {
  const pieces = text.split(/([,;/\s]+)/u);
  if (!pieces.some(piece => UNIPROT_ACCESSION.test(piece))) {
    dd.textContent = text;
    return;
  }
  for (const piece of pieces) {
    const match = UNIPROT_ACCESSION.exec(piece);
    if (!match) {
      if (piece) dd.append(document.createTextNode(piece));
      continue;
    }
    const link = element('a', '', piece);
    // match[1] drops a ".2" sequence version, which uniprotkb/<accession>/entry does not accept.
    link.href = `https://www.uniprot.org/uniprotkb/${encodeURIComponent(match[1])}/entry`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    dd.append(link);
  }
}

function recordFieldList(fields, record) {
  const list = element('dl', 'record-dl');
  for (const field of fields) {
    const raw = record[field] === null || record[field] === undefined ? '' : String(record[field]);
    const value = displayCell(field, raw);
    const label = formatLabel(field);
    list.append(element('dt', '', label));
    const dd = element('dd', value ? '' : 'missing');
    // A suppressed placeholder stays reachable: the source cell did say something.
    if (!value && raw.trim()) dd.title = raw;
    if (field.endsWith('sequence_from_patent') && value) {
      dd.className = 'sequence-field';
      const toolbar = element('div', 'sequence-toolbar');
      toolbar.append(element('span', '', `${number(value.replace(/\s/g, '').length)} characters · as reported`));
      const copy = element('button', 'text-button', 'Copy sequence');
      copy.type = 'button';
      // Up to three sequence rows share one visible label, so the chain goes in the name.
      copy.setAttribute('aria-label', `Copy ${label}`);
      copy.addEventListener('click', () => copyText(value, `${label} copied`));
      const fasta = element('button', 'text-button', 'Copy as FASTA');
      fasta.type = 'button';
      fasta.setAttribute('aria-label', `Copy ${label} as FASTA`);
      // The same entry the FASTA export writes: letters only, wrapped at 60, with the identifiers
      // in the header. Pasting the raw cell into an alignment tool is what this avoids.
      fasta.addEventListener('click', () => copyText(fastaEntry({
        id: record.unique_record_id,
        chain: CHAIN_LABELS[field] || formatLabel(field),
        antibody: record.antibody_identifier,
        patent: record.patent_id,
        target: record['target.protein_name'],
        sequence: value,
      }), `${label} copied as FASTA`));
      // Grouped, so the toolbar keeps its "count left, actions right" rhythm with two buttons.
      const actions = element('div');
      actions.style.display = 'flex';
      actions.style.gap = '12px';
      actions.append(copy, fasta);
      toolbar.append(actions);
      dd.append(toolbar, element('code', 'sequence-text', value));
    } else if (field === 'target.uniprot_id' && value) {
      appendUniprot(dd, value);
    } else dd.textContent = value || '—';
    list.append(dd);
  }
  return list;
}

function renderRecord(row) {
  const record = Object.fromEntries(manifest.fields.map((field, i) => [field, row[i]]));
  const content = $('#record-content');
  content.replaceChildren();
  const title = element('h2', '', record['target.protein_name'] || record.antibody_identifier || 'Binding record');
  title.id = 'record-title';
  content.append(title, element('p', 'record-id', record.unique_record_id));
  const summary = element('div', 'record-summary');
  summary.append(auditBadge(record['audit.verdict']));
  const patentId = displayCell('patent_id', record.patent_id);
  if (patentId && US_PATENT_ID.test(patentId)) {
    const link = element('a', '', `US${patentId} ↗`);
    link.href = `https://patents.google.com/patent/US${patentId}/en`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    summary.append(link);
  } else if (patentId) {
    // An id in an unexpected shape would build a dead link, so it stays plain text.
    summary.append(element('span', '', patentId));
  }
  content.append(summary);
  const groups = [
    ['Antibody', ['antibody_identifier', 'antibody_type', 'antibody_discovery_status', 'vh.seq_id', 'vh.is_full_heavy_chain', 'vh.sequence_from_patent', 'vl.seq_id', 'vl.is_full_light_chain', 'vl.sequence_from_patent', 'similar_antibody_seq_ids']],
    ['Target & binding', manifest.fields.filter(field => field.startsWith('target.'))],
    ['Epitope', manifest.fields.filter(field => field.startsWith('epitope.'))],
    ['Discovery', manifest.fields.filter(field => field.startsWith('discovery_methodology.'))],
  ];
  for (const [name, fields] of groups) {
    const section = element('section', 'record-section');
    section.append(element('h3', '', name), recordFieldList(fields, record));
    content.append(section);
  }
  const audit = element('section', 'record-section');
  audit.append(element('h3', '', 'Extraction audit'), recordFieldList(['audit.verdict', 'audit.flags'], record));
  audit.append(element('p', 'record-explanation', record['audit.reasoning'] || 'No audit explanation was reported.'));
  content.append(audit);
  const rawSection = element('section', 'record-section');
  const raw = element('details');
  raw.append(element('summary', '', `All ${manifest.fields.length} original fields`));
  const list = element('dl', 'record-dl');
  for (const field of manifest.fields) list.append(element('dt', '', field), element('dd', '', record[field] || '—'));
  raw.append(list);
  rawSection.append(raw);
  content.append(rawSection);
}

async function openRecord(index, expectedId, { push = false, opener = null } = {}) {
  const call = ++recordRequest;
  currentRecord = expectedId;
  // The record resolved against this release, so that is the version a shared link belongs to.
  recordVersion = manifest.dataset.version;
  if (opener) lastOpener = opener;
  // A retry or a URL-driven open edits the entry it came from; a click adds one. Only a pushed
  // entry may be closed with history.back(): a shared link is the first entry of its session.
  const pushed = push && !recordInHistory;
  writeURL({ push: pushed });
  if (pushed) recordInHistory = true;
  const content = $('#record-content');
  const heading = element('h2', '', 'Loading record…');
  heading.id = 'record-title';
  content.replaceChildren(heading, element('p', 'muted', 'Fetching the full record and its evidence.'));
  const dialog = $('#record-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  try {
    const chunk = await loadChunk(Math.floor(index / manifest.details.chunkSize));
    if (call !== recordRequest) return;
    const row = chunk.rows[index - chunk.start];
    if (!row || row[manifest.fields.indexOf('unique_record_id')] !== expectedId) throw new Error('The record does not match this dataset version. Reload the page to refresh the collection.');
    renderRecord(row);
  } catch (error) {
    if (call !== recordRequest) return;
    heading.textContent = 'Record unavailable';
    const retry = element('button', 'button button-secondary', 'Try again');
    retry.addEventListener('click', () => openRecord(index, expectedId));
    content.replaceChildren(heading, element('p', 'record-error', error.message), retry);
  }
}

/**
 * A shared record link is version-scoped, so this says which release it came from and keeps the
 * parameter in the URL. Dropping it silently left the user with no way to tell what they had.
 */
function showMissingRecord(id, detail) {
  const current = manifest.dataset.version;
  const shared = recordVersion && recordVersion !== current ? recordVersion : null;
  const heading = element('h2', '', detail ? 'Record unavailable' : 'Record not in this release');
  heading.id = 'record-title';
  const explanation = detail
    ? `This link could not be opened: ${detail}`
    : `Record ${id} is not part of dataset v${current}${shared ? `, and this link was shared from v${shared}` : ''}. Record identifiers are regenerated for every release, so a link made against another version cannot be resolved here.`;
  const nodes = [heading, element('p', 'record-error', explanation)];
  const url = safeExternalURL(manifest.dataset.recordUrl);
  if (url) {
    const link = element('a', 'button button-secondary', 'Open the dataset release on Zenodo ↗');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    nodes.push(link);
  }
  $('#record-content').replaceChildren(...nodes);
  const dialog = $('#record-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

async function openRecordFromURL() {
  if (!currentRecord) return;
  const id = currentRecord;
  // The same guard openRecord uses: a record the user just clicked must win over the URL.
  const call = ++recordRequest;
  try {
    const found = await send('lookup', id);
    if (call !== recordRequest) return;
    if (found.index < 0) {
      showMissingRecord(id);
      return;
    }
    await openRecord(found.index, id);
    // The id resolved, but ids are regenerated per release: a link from another version can land
    // on a different record entirely, so say so rather than showing it as if it were the one meant.
    if (call === recordRequest && recordVersion && recordVersion !== manifest.dataset.version) {
      $('#record-content').prepend(element('p', 'record-error',
        `This link was shared from dataset v${recordVersion}, and record identifiers are regenerated for every release. The record below may not be the one the link meant — check it against v${recordVersion}.`));
    }
  } catch (error) {
    // This runs on a page that already loaded, so it reports itself and nothing else.
    if (call !== recordRequest) return;
    showMissingRecord(id, error.message);
  }
}

/**
 * One Blob part per 1,000 rows. A part per record hands the Blob 89,075 strings for the whole
 * collection; the spread that used to prepend the BOM copied every one of them onto the stack.
 */
function csvParts(lines) {
  const parts = [];
  for (let at = 0; at < lines.length; at += CSV_BATCH) parts.push(lines.slice(at, at + CSV_BATCH).join(''));
  return parts;
}

/**
 * The source CSV has no BOM (measured: its first bytes are "unique_r"), so an unconditional one
 * made "uncheck to preserve source text exactly" false \u2014 a plain UTF-8 reader saw the first
 * header cell as "\ufeffunique_record_id".
 */
function withBOM(parts, spreadsheetSafe) {
  if (spreadsheetSafe && parts.length) parts[0] = `\ufeff${parts[0]}`;
  return parts;
}

function downloadExport(parts, kind) {
  const { suffix, extension, type } = EXPORT_KINDS[kind];
  const blob = new Blob(parts, { type });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `poisk-${String(manifest.dataset.version).replace(/[^a-zA-Z0-9._-]/g, '-')}-${suffix}.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function startExport() {
  if (exportController) return;
  const controller = new AbortController();
  exportController = controller;
  const kind = exportKind();
  const query = structuredClone(state);
  // FASTA is plain text: there is no formula to protect and no BOM to add.
  const csvOptions = { spreadsheetSafe: kind !== 'fasta' && $('#spreadsheet-safe').checked };
  const progress = $('#export-progress');
  progress.hidden = false;
  progress.textContent = 'Preparing your selection…';
  $('#start-export').disabled = true;
  $('#cancel-export').hidden = false;
  for (const input of $$('#export-dialog input')) input.disabled = true;
  try {
    let count;
    // An exact-chain lookup is not an engine query, so its own match list is the selection.
    const matches = lookupActive() ? latestResult?.matches ?? [] : null;
    if (kind === 'metadata' && !matches) {
      const data = await send('metadataExport', query);
      if (controller.signal.aborted) return;
      count = data.rows.length;
      const parts = [csvLine(data.fields, csvOptions)];
      // Yield between batches so cancellation and the progress indicator stay responsive.
      for (let i = 0; i < data.rows.length; i += CSV_BATCH) {
        if (controller.signal.aborted) return;
        let batch = '';
        for (const row of data.rows.slice(i, i + CSV_BATCH)) batch += csvLine(row, csvOptions);
        parts.push(batch);
        progress.textContent = `Preparing ${number(Math.min(i + CSV_BATCH, count))} of ${number(count)} records…`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      // Only a real download reaches the success message: an abort in the last batch used to
      // fall through to "Downloaded N records" with no file.
      if (controller.signal.aborted) return;
      downloadExport(withBOM(parts, csvOptions.spreadsheetSafe), kind);
      finishExport(count, csvOptions, kind);
    } else {
      const indices = matches ?? (await send('export', query)).indices;
      count = indices.length;
      if (controller.signal.aborted) return;
      // The index rows live in the worker, so every kind below is built from full records: the
      // 44 original columns, the chains as FASTA, or the index columns rebuilt from them.
      const convert = kind === 'full' ? row => csvLine(row, csvOptions)
        : kind === 'fasta' ? fastaFromRecord
        : row => csvLine(metadataRow(row), csvOptions);
      const noun = kind === 'fasta' ? 'records of sequences' : kind === 'full' ? 'complete records' : 'records';
      const lines = await collectRecords(indices, convert, {
        signal: controller.signal,
        cache: false,
        onProgress: done => { progress.textContent = `Loaded ${number(done)} of ${number(count)} ${noun}…`; },
      });
      if (controller.signal.aborted) return;
      // `some` skips the holes of a sparse array, so the old guard passed and the download
      // then wrote literal "undefined" rows. `includes` visits holes as undefined.
      if (lines.includes(undefined)) throw new Error('Some records were not loaded. Please retry the export.');
      // unshift rather than a spread into a new array: this list reaches 89,074 strings.
      if (kind === 'full') lines.unshift(csvLine(manifest.fields, csvOptions));
      else if (kind === 'metadata') lines.unshift(csvLine(indexFields, csvOptions));
      downloadExport(withBOM(csvParts(lines), csvOptions.spreadsheetSafe), kind);
      finishExport(count, csvOptions, kind);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      controller.abort();
      progress.textContent = `Export failed: ${error.message}`;
      showToast(`Export failed: ${error.message}`, { error: true });
    }
  } finally {
    if (exportController === controller) exportController = null;
    $('#start-export').disabled = false;
    $('#cancel-export').hidden = true;
    for (const input of $$('#export-dialog input')) input.disabled = false;
    // describeExport, not resetExportButton: it also restores the per-kind button label and
    // the spreadsheet option's own disabled state, which the loop above just cleared.
    describeExport();
  }
}

function finishExport(count, csvOptions, kind) {
  const note = kind === 'fasta' ? 'Plain text, 60 residues per line, one entry per reported chain.'
    : csvOptions.spreadsheetSafe ? 'Spreadsheet protection enabled.' : 'Original field text preserved.';
  $('#export-progress').textContent = `Downloaded ${number(count)} ${count === 1 ? 'record' : 'records'}. ${note}`;
}

function cancelExport() {
  resetExportButton();
  if (!exportController) return;
  exportController.abort();
  // The worker may still be slicing a full-collection export; let it drop that work so a
  // queued query is not stuck behind it.
  send('cancel').catch(() => {});
  const message = 'Export cancelled. No file was downloaded.';
  $('#export-progress').textContent = message;
  // That progress line lives inside the dialog, which is usually the thing that just closed.
  showToast(message);
}

function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${number(Math.round(bytes / 1e6))} MB`;
  if (bytes >= 1e3) return `${number(Math.round(bytes / 1e3))} kB`;
  return `${number(bytes)} bytes`;
}

function exportKind() {
  const chosen = $('input[name="export-kind"]:checked')?.value;
  return Object.hasOwn(EXPORT_KINDS, chosen) ? chosen : 'metadata';
}

/** An estimate from the measured mean bytes per record: the file is assembled in this tab. */
function exportEstimate() {
  const kind = exportKind();
  return { kind, bytes: total * CSV_BYTES[kind] };
}

function resetExportButton() {
  exportConfirmed = false;
  $('#start-export').textContent = EXPORT_KINDS[exportKind()].label;
}

function describeExport() {
  const { kind, bytes } = exportEstimate();
  const order = lookupActive() ? 'Exact chain matches are written in dataset order.' : 'Your current sort order is preserved.';
  $('#export-description').textContent = `${number(total)} matching ${total === 1 ? 'record' : 'records'} from dataset v${manifest.dataset.version}, about ${formatSize(bytes)} of ${kind === 'fasta' ? 'FASTA' : 'CSV'} built in this browser tab. ${order}`;
  // Formula protection and the BOM are CSV concerns; a FASTA file must stay plain text.
  $('#spreadsheet-safe').disabled = kind === 'fasta';
  resetExportButton();
}

async function initialize() {
  ready = false;
  $('#load-error').hidden = true;
  $('#loading-state').hidden = false;
  $('#loading-state strong').textContent = 'Opening the collection';
  try {
    if (location.protocol === 'file:') throw new Error('Serve the built site with a local web server. See the README for the one-line preview command.');
    manifest = await fetchJSON('data/manifest.json');
    if (manifest.schemaVersion !== 1) throw new Error('This dataset format is not supported by this version of the explorer.');
    // Absent in a build from the previous contract, in which case no cell is suppressed.
    placeholders = new Set(Array.isArray(manifest.placeholders) ? manifest.placeholders : []);
    indexFields = manifest.index.fields;
    if (!Array.isArray(indexFields) || TABLE_FIELDS.some(field => !indexFields.includes(field))) {
      throw new Error('Search metadata does not match the release. Reload the page to try again.');
    }
    positions = Object.fromEntries(indexFields.map((field, position) => [field, position]));
    recordPositions = Object.fromEntries(manifest.fields.map((field, position) => [field, position]));
    epitopeFields = manifest.fields.filter(field => field.startsWith('epitope.'));
    // Only a release that publishes the asset can offer the exact-chain mode at all.
    sequenceAsset = manifest.sequences?.url || manifest.sequences?.gzipUrl ? manifest.sequences : null;
    if (!sequenceAsset) {
      $(`#search-field option[value="${SEQUENCE_FIELD}"]`)?.remove();
      if (state.field === SEQUENCE_FIELD) state.field = 'all';
    }
    renderMetadata();
    // The facet values are their own cacheable asset now, so they load while the worker fetches
    // and parses the index instead of after it.
    await Promise.all([loadFacets(), startEngine(manifest.index)]);
    renderFacets();
    const dropped = validateFacetFilters();
    syncControls();
    // The worker owns the parsed index, so the row count that used to be checked here is asked
    // for instead: an unconstrained query answers from the untouched source order.
    const { total: indexed } = await send('query', { q: '', field: 'all', filters: {}, sort: 'source', direction: 'asc', page: 1, pageSize: 1 });
    if (indexed !== manifest.counts.records) throw new Error('Search metadata does not match the release. Reload the page to try again.');
    ready = true;
    for (const node of $$('#search-form input, #search-form select, #search-form button, [data-example], [data-presence], #share-search')) node.disabled = false;
    reportDroppedFilters(dropped);
    await runSearch();
  } catch (error) {
    showLoadError(error.message);
    return;
  }
  // Outside the try: a record named in the URL must never be able to report a loaded
  // collection as a fatal load failure.
  try {
    await openRecordFromURL();
  } catch (error) {
    showToast(error.message, { error: true });
  }
}

/*
 * A FASTA record pasted into the search box has to be caught here. `#search-input` is an <input>,
 * and the HTML value sanitiser deletes the line breaks before any listener sees the value — which
 * welds the description line onto the chain, so the site reported its own "Copy as FASTA" output
 * as absent from the release. The clipboard still has the line structure; use it while it exists.
 */
$('#search-input').addEventListener('paste', event => {
  const pasted = event.clipboardData?.getData('text') ?? '';
  if (!/^\s*[>;]/u.test(pasted) || !/[\r\n]/u.test(pasted)) return;
  const residues = pastedSequence(pasted);
  if (residues.length < MINIMUM_SEQUENCE) return;
  event.preventDefault();
  const input = event.target;
  input.value = residues;
  state.q = residues;
  state.page = 1;
  clearTimeout(debounceTimer);
  runSearch();
  showToast('Pasted the chain from that FASTA record; its description line was left out.');
});
$('#search-input').addEventListener('input', event => {
  state.q = event.target.value;
  state.page = 1;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 180);
});
$('#search-form').addEventListener('submit', event => {
  event.preventDefault();
  clearTimeout(debounceTimer);
  state.q = $('#search-input').value;
  state.page = 1;
  runSearch();
});
$('#search-field').addEventListener('change', event => { state.field = event.target.value; state.page = 1; runSearch(); });
for (const button of $$('[data-example]')) button.addEventListener('click', () => { state.q = button.dataset.example; state.field = 'all'; state.page = 1; syncControls(); runSearch(); });
for (const checkbox of $$('[data-presence]')) checkbox.addEventListener('change', () => {
  if (checkbox.checked) state.filters[checkbox.dataset.presence] = true;
  else delete state.filters[checkbox.dataset.presence];
  state.page = 1; syncControls(); runSearch();
});
$('#reset-filters').addEventListener('click', () => { state.filters = {}; state.page = 1; syncControls(); runSearch(); });
// One delegated listener for every facet option, instead of a closure per rendered option.
$('#facets').addEventListener('click', event => {
  const control = event.target.closest('[data-facet-action]');
  if (!control) return;
  const field = control.dataset.facetField;
  const nodes = facetNodes.get(field);
  if (!nodes) return;
  const action = control.dataset.facetAction;
  if (action === 'any') setFacetValues(field, []);
  // Every match, including those the rendered list capped off.
  else if (action === 'all') setFacetValues(field, nodes.matching.map(item => item.value));
  else {
    const value = control.dataset.facetValue;
    const chosen = selectedValues(field);
    setFacetValues(field, chosen.includes(value) ? chosen.filter(kept => kept !== value) : [...chosen, value]);
  }
});
$('#facets').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const facet = event.target.closest('.facet');
  if (!facet?.open) return;
  // Without this the facet's search box swallows Escape to clear itself and the list stays open.
  event.preventDefault();
  facet.open = false;
  $('summary', facet).focus();
});
$('#sequence-hint-action').addEventListener('click', () => {
  state.field = state.field === SEQUENCE_FIELD ? 'all' : SEQUENCE_FIELD;
  state.page = 1;
  syncControls();
  runSearch();
});
$('#clear-search').addEventListener('click', () => { state.q = ''; state.filters = {}; state.page = 1; syncControls(); runSearch(); });
for (const header of $$('th[data-sort]')) $('button', header).addEventListener('click', () => {
  if (state.sort === header.dataset.sort) state.direction = state.direction === 'asc' ? 'desc' : 'asc';
  else { state.sort = header.dataset.sort; state.direction = 'asc'; }
  state.page = 1; runSearch();
});
$('#page-size').addEventListener('change', event => { state.pageSize = Number(event.target.value); state.page = 1; runSearch(); });
for (const [selector, target] of [['#first-page', () => 1], ['#previous-page', () => state.page - 1], ['#next-page', () => state.page + 1], ['#last-page', () => pageCount]]) {
  $(selector).addEventListener('click', () => { state.page = target(); runSearch(); });
}
$('#toggle-filters').addEventListener('click', () => {
  const shown = $('#filters-panel').classList.toggle('mobile-visible');
  $('#toggle-filters').setAttribute('aria-expanded', String(shown));
  // Animated scrolling is exactly what prefers-reduced-motion asks us not to do.
  if (shown) $('#filters-panel').scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
});
for (const button of $$('[data-open]')) button.addEventListener('click', () => $(`#${button.dataset.open}`).showModal());
for (const button of $$('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of $$('dialog')) dialog.addEventListener('click', event => {
  // offsetX < 0 only ever fired on the left edge of a centred dialog. The backdrop is every
  // point outside the dialog's own box, and a click on its padding is not a dismissal.
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right ||
      event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});
$('#record-dialog').addEventListener('close', () => {
  ++recordRequest;
  currentRecord = null;
  recordVersion = null;
  // The row that opened the drawer is where focus belongs; the results panel is the fallback
  // for a drawer opened from a link, or when a new search replaced the row.
  if (lastOpener?.isConnected) lastOpener.focus();
  else $('#results').focus();
  lastOpener = null;
  if (navigating) return;
  // Closing undoes the entry that opening pushed, so Back and Forward stay symmetric.
  if (recordInHistory) { recordInHistory = false; history.back(); }
  else writeURL();
});
$('#export-dialog').addEventListener('close', cancelExport);
$('#share-search').addEventListener('click', () => { writeURL(); copyText(location.href, 'Search link copied'); });
$('#share-record').addEventListener('click', () => { writeURL(); copyText(location.href, 'Record link copied'); });
$('#copy-citation').addEventListener('click', () => {
  const citation = manifest?.dataset.citation;
  // The button is disabled until the manifest lands; this is the belt to that braces.
  if (citation) copyText(citation, 'Citation copied');
});
$('#export-results').addEventListener('click', () => {
  describeExport();
  if (!exportController) $('#export-progress').hidden = true;
  $('#export-dialog').showModal();
});
for (const input of $$('#export-dialog input[name="export-kind"], #spreadsheet-safe')) {
  input.addEventListener('change', describeExport);
}
$('#start-export').addEventListener('click', () => {
  const { bytes } = exportEstimate();
  if (!exportConfirmed && bytes > CONFIRM_BYTES) {
    exportConfirmed = true;
    $('#start-export').textContent = `Download about ${formatSize(bytes)}`;
    showToast(`This export is about ${formatSize(bytes)} and is built in this browser tab. Choose the button again to continue.`);
    return;
  }
  startExport();
});
$('#cancel-export').addEventListener('click', cancelExport);
$('#toast').addEventListener('click', hideToast);
// A failed search leaves a loaded collection in place, so retrying the search is the cheap fix.
$('#retry-load').addEventListener('click', () => { if (ready) runSearch(); else initialize(); });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('dialog[open]')) {
    event.preventDefault(); $('#search-input').focus();
  }
});
window.addEventListener('popstate', async () => {
  // Set for the whole handler: the record dialog's close handler must not write history while
  // history is what moved us, and re-rendering the rows here would steal the restored focus.
  navigating = true;
  try {
    const previous = currentRecord;
    const before = searchKey();
    readURL();
    // The entry we moved to may carry facet values from an older release, exactly as a pasted
    // link can, so it goes through the same check.
    const dropped = validateFacetFilters();
    recordInHistory = Boolean(currentRecord);
    syncControls();
    reportDroppedFilters(dropped);
    if (searchKey() !== before) await runSearch();
    if (currentRecord && currentRecord !== previous) await openRecordFromURL();
    else if (!currentRecord && $('#record-dialog').open) $('#record-dialog').close();
  } finally {
    navigating = false;
  }
});
readURL();
initialize();
