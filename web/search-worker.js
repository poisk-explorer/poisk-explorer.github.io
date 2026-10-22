import { createSearchEngine } from './search-core.js';

let engine = null;
let sourceIndex = null;
let loadGeneration = 0;
const activeExports = new Set();
const cancelledExports = new Set();

// Rows per export slice. The loops yield between slices so a cancel or a queued query is
// delivered instead of waiting behind a full-dataset export and its structured clone.
// Exported so the tests can size a fixture past it rather than assume the number.
export const EXPORT_SLICE = 20000;

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The manifest is dataset-authored text, so the worker re-checks the origin before fetching. */
function datasetURL(value) {
  const url = new URL(String(value), self.location.href);
  if (url.origin !== self.location.origin) throw new Error('The dataset references an invalid file location.');
  return url.href;
}

async function fetchJSON(url, gzipUrl) {
  if (gzipUrl && 'DecompressionStream' in globalThis) {
    try {
      const response = await fetch(datasetURL(gzipUrl));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // A host that serves .gz with Content-Encoding has already inflated the body for us.
      if ((response.headers.get('content-encoding') || '').includes('gzip')) return await response.json();
      return await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
    } catch (error) {
      // JSON is a portable fallback if the host/browser does not serve gzip files.
      if (url) console.warn(`POISK Explorer: could not read ${gzipUrl} (${error.message}); falling back to ${url}.`);
    }
  }
  const response = await fetch(datasetURL(url));
  if (!response.ok) throw new Error(`Could not load dataset file (HTTP ${response.status}).`);
  return response.json();
}

/** Copy `total` rows in slices, yielding between them; resolves null once cancelled. */
async function collect(id, total, take) {
  const output = new Array(total);
  for (let at = 0; at < total; at += EXPORT_SLICE) {
    if (at > 0) await nextTask();
    if (cancelledExports.has(id)) return null;
    const end = Math.min(at + EXPORT_SLICE, total);
    for (let position = at; position < end; position += 1) output[position] = take(position);
  }
  return output;
}

function exportPayload(type, id, output, cancelled) {
  const flag = cancelled ? { cancelled: true } : {};
  return type === 'export'
    ? { type, id, indices: output, ...flag }
    : { type, id, fields: sourceIndex.fields, rows: output, ...flag };
}

function runExport(data, id, fail) {
  const indices = engine.matchingIndices(data.query);
  const take = data.type === 'export'
    ? (position) => indices[position]
    : (position) => sourceIndex.rows[indices[position]];
  if (indices.length <= EXPORT_SLICE) {
    // One slice: answer synchronously, as this message type always has.
    const output = new Array(indices.length);
    for (let position = 0; position < indices.length; position += 1) output[position] = take(position);
    self.postMessage(exportPayload(data.type, id, output, false));
    return;
  }
  activeExports.add(id);
  collect(id, indices.length, take)
    .then((output) => self.postMessage(exportPayload(data.type, id, output ?? [], !output)))
    .catch(fail)
    .finally(() => {
      activeExports.delete(id);
      cancelledExports.delete(id);
    });
}

async function initFromURL(data, generation) {
  const index = await fetchJSON(data.indexUrl, data.gzipUrl);
  // A second init while this fetch was in flight wins; a late arrival must not resurrect it.
  if (generation !== loadGeneration) return;
  engine = createSearchEngine(index);
  sourceIndex = index;
  self.postMessage({ type: 'ready' });
}

async function loadSequences(data, id) {
  const asset = await fetchJSON(data.url, data.gzipUrl);
  self.postMessage({ type: 'loadSequences', id, count: engine.loadSequences(asset) });
}

self.addEventListener('message', ({ data }) => {
  const id = data?.id;
  const fail = (error) => self.postMessage({
    type: 'error', id, message: error instanceof Error ? error.message : String(error),
  });
  try {
    if (data?.type === 'init') {
      engine = null;
      sourceIndex = null;
      loadGeneration += 1;
      // The URL form keeps the main thread from parsing and cloning the whole index.
      if (data.indexUrl) {
        initFromURL(data, loadGeneration).catch(fail);
        return;
      }
      engine = createSearchEngine(data.index);
      sourceIndex = data.index;
      self.postMessage({ type: 'ready' });
      return;
    }
    if (data?.type === 'cancel') {
      // A null cancelId withdraws every export in flight.
      for (const active of activeExports) {
        if (data.cancelId === null || data.cancelId === undefined || data.cancelId === active) {
          cancelledExports.add(active);
        }
      }
      self.postMessage({ type: 'cancel', id, cancelId: data.cancelId ?? null });
      return;
    }
    if (!engine) throw new Error('Search data has not loaded yet.');

    switch (data?.type) {
      case 'query':
        self.postMessage({ type: 'result', id, ...engine.query(data.query) });
        break;
      case 'export':
      case 'metadataExport':
        runExport(data, id, fail);
        break;
      case 'lookup':
        self.postMessage({ type: 'lookup', id, index: engine.lookup(data.recordId) });
        break;
      case 'loadSequences':
        loadSequences(data, id).catch(fail);
        break;
      case 'lookupSequence':
        self.postMessage({ type: 'lookupSequence', id, indices: engine.lookupSequence(data.sequence) });
        break;
      case 'facetCounts':
        self.postMessage({ type: 'facetCounts', id, counts: engine.facetCounts(data.query, data.fields) });
        break;
      default:
        throw new Error('Unknown search worker request.');
    }
  } catch (error) {
    fail(error);
  }
});
