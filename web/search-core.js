import { canonicalSequence, fnv1a64 } from './data-utils.js';

/** Searchable metadata only; full record text is deliberately excluded. */
export const TEXT_SEARCH_FIELDS = Object.freeze([
  'unique_record_id',
  'patent_id',
  'antibody_identifier',
  'target.protein_name',
  'target.gene_names',
  'target.uniprot_id',
  'antibody_discovery_status',
  'discovery_methodology.source_organism',
  'discovery_methodology.specific_platform',
]);

/** @deprecated Use TEXT_SEARCH_FIELDS; kept so existing importers keep resolving. */
export const SEARCH_FIELDS = TEXT_SEARCH_FIELDS;

/** A whole-word hit in one of these is what a user almost always meant. */
const RANKED_FIELDS = Object.freeze([
  'target.protein_name',
  'target.gene_names',
  'antibody_identifier',
]);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// Patents write "TGFβ" and "TGF-beta" for the same target, so index the spelled-out name.
const GREEK_NAMES = Object.freeze({
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta',
  'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta',
  'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu',
  'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron', 'π': 'pi',
  'ρ': 'rho', 'ς': 'sigma', 'σ': 'sigma', 'τ': 'tau',
  'υ': 'upsilon', 'φ': 'phi', 'χ': 'chi', 'ψ': 'psi',
  'ω': 'omega',
});
const GREEK_LETTERS = /[α-ω]/gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(GREEK_LETTERS, (letter) => GREEK_NAMES[letter]);
}

/** Punctuation-free form: makes "PD1", "PD-1" and "pd 1" the same token. */
export function squash(normalizedValue) {
  return normalizedValue.replace(/[^a-z0-9]/gu, '');
}

/** Whitespace means AND; quoted text is one phrase. Unclosed quotes are tolerated. */
export function tokenizeQuery(value) {
  if (typeof value !== 'string') return [];
  const tokens = [];
  let token = '';
  let quoted = false;
  const flush = () => {
    const normalized = normalize(token).trim();
    if (normalized) tokens.push(normalized);
    token = '';
  };
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    if (character === '\\' && (value[i + 1] === '"' || value[i + 1] === '\\')) {
      token += value[++i];
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/u.test(character)) {
      flush();
    } else {
      token += character;
    }
  }
  flush();
  return [...new Set(tokens)];
}

/** True when a stray `"` left a phrase open, so the UI can say the query was read as one phrase. */
export function hasUnterminatedQuote(value) {
  if (typeof value !== 'string') return false;
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    if (character === '\\' && (value[i + 1] === '"' || value[i + 1] === '\\')) i += 1;
    else if (character === '"') quoted = !quoted;
  }
  return quoted;
}

function isBlank(value) {
  return value === '' || value === null || value === undefined;
}

function positiveInteger(value, fallback) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : fallback;
}

function isWordCharacter(text, at) {
  const code = text.charCodeAt(at);
  // Normalised text is lowercase, so the ASCII fast path covers almost every cell.
  if (code < 128) return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
  return WORD_CHARACTER.test(text[at]);
}

/** 3 whole word, 2 word start, 1 substring, 0 absent — index tests, no per-row regex. */
function matchQuality(text, token) {
  if (!token) return 0; // indexOf('') would never advance.
  let best = 0;
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    const startsWord = at === 0 || !isWordCharacter(text, at - 1);
    if (!startsWord) {
      best = Math.max(best, 1);
      continue;
    }
    const end = at + token.length;
    if (end === text.length || !isWordCharacter(text, end)) return 3;
    best = 2;
  }
  return best;
}

/** Squashed text has no separators, so only the edges are boundaries: 3 exact, 2 prefix, 1 inside. */
function squashQuality(text, token) {
  if (!token || !text.includes(token)) return 0;
  if (text === token) return 3;
  return text.startsWith(token) ? 2 : 1;
}

/**
 * Build once per dataset. Pagination reuses the last filtered/sorted row indices.
 * Filters use raw field names and exact values; an empty string selects missing
 * cells (empty, null, or absent). An array of values selects any of those values.
 * Boolean filters match real booleans, never the strings "true" or "false".
 */
export function createSearchEngine(index) {
  if (!index || !Array.isArray(index.fields) || !Array.isArray(index.rows)) {
    throw new TypeError('Search data must contain fields and rows arrays.');
  }
  if (index.fields.some((field) => typeof field !== 'string') ||
      new Set(index.fields).size !== index.fields.length) {
    throw new TypeError('Search field names must be unique strings.');
  }
  if (index.rows.some((row) => !Array.isArray(row))) {
    throw new TypeError('Every search row must be an array.');
  }

  const { rows } = index;
  const fieldPositions = new Map(index.fields.map((field, position) => [field, position]));
  const searchableFields = TEXT_SEARCH_FIELDS.filter((field) => fieldPositions.has(field));
  // Two forms per field instead of one joined copy of everything: a token matches either.
  const columns = searchableFields.map((field) => ({
    field,
    ranked: RANKED_FIELDS.includes(field),
    text: new Array(rows.length),
    squashed: new Array(rows.length),
  }));
  const columnsByField = new Map(columns.map((column) => [column.field, column]));
  const sourceIndices = new Array(rows.length);
  const recordPositions = new Map();
  const recordIdPosition = fieldPositions.get('unique_record_id');

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (const column of columns) {
      const normalized = normalize(row[fieldPositions.get(column.field)]);
      column.text[rowIndex] = normalized;
      column.squashed[rowIndex] = squash(normalized);
    }
    sourceIndices[rowIndex] = rowIndex;
    const recordId = row[recordIdPosition];
    if (!isBlank(recordId) && !recordPositions.has(String(recordId))) {
      recordPositions.set(String(recordId), rowIndex);
    }
  }

  let lastKey = null;
  let lastMatches = [];
  let scores = null;
  let sequenceKeys = null;
  let sequenceRows = null;

  function prepare(input) {
    const query = input && typeof input === 'object' ? input : {};
    const tokens = tokenizeQuery(query.q);
    const field = columnsByField.has(query.field) ? query.field : 'all';
    const sort = fieldPositions.has(query.sort) ? query.sort : 'source';
    const direction = query.direction === 'desc' ? 'desc' : 'asc';
    const filters = [];
    if (query.filters && typeof query.filters === 'object' && !Array.isArray(query.filters)) {
      for (const key of Object.keys(query.filters).sort()) {
        if (!fieldPositions.has(key)) continue;
        const raw = query.filters[key];
        // Undefined means the filter was omitted. Null explicitly selects blanks.
        if (raw === undefined) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        const supported = values.filter((value) =>
          value === null || typeof value === 'string' || typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)));
        if (supported.length) filters.push([key, supported]);
      }
    }
    // Squashed forms are derived from the tokens, so they need no place in the memo key. A token
    // that squashes to nothing is pure punctuation and carries no constraint: dropping it is what
    // keeps `CD3 / CD19` from demanding a literal "/" in a metadata field and returning nothing.
    const forms = tokens.map((token) => [token, squash(token)]).filter(([, squashed]) => squashed);
    const key = JSON.stringify([tokens, field, filters, sort, direction]);
    return { tokens, forms, field, filters, sort, direction, key };
  }

  /**
   * Score both indexes and keep the better one. A row that matches only because punctuation was
   * folded away — "PD1" against a target named "PD-1" — is as exact a hit as a literal one, and
   * scoring it on the normalised text alone would sink it below fusion constructs that merely
   * contain the typed string.
   */
  function relevance(rowIndex, forms) {
    let wholeWord = true;
    let wordStart = true;
    for (const [token, squashed] of forms) {
      let anywhere = 0;
      let ranked = 0;
      for (const column of columns) {
        const quality = Math.max(matchQuality(column.text[rowIndex], token),
          squashQuality(column.squashed[rowIndex], squashed));
        if (quality > anywhere) anywhere = quality;
        if (column.ranked && quality > ranked) ranked = quality;
      }
      if (ranked < 3) wholeWord = false;
      if (anywhere < 2) wordStart = false;
      if (!wholeWord && !wordStart) return 1;
    }
    return wholeWord ? 3 : wordStart ? 2 : 1;
  }

  function findMatches(input) {
    const { forms, field, filters, sort, direction, key } = prepare(input);
    if (key === lastKey) return lastMatches;
    const filterChecks = filters.map(([name, values]) => [fieldPositions.get(name), values]);
    let matches;
    if (!forms.length && !filterChecks.length) {
      matches = sourceIndices;
    } else {
      /*
       * The scan below runs once per row per searched column, so it reads flat arrays with
       * integer loops instead of iterating objects.
       *
       * "normalised token in normalised text OR squashed token in squashed text" needs only the
       * squashed test: squash just drops characters, so text containing the token always squashes
       * to text containing the squashed token. Tokens that squash to nothing were dropped in
       * prepare(), so every token here has a squashed form to match on.
       */
      const searched = field === 'all' ? columns : [columnsByField.get(field)];
      const tokenSquash = forms.map(([, squashed]) => squashed);
      const columnSquash = searched.map((column) => column.squashed);
      matches = [];
      rowLoop: for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        for (let t = 0; t < tokenSquash.length; t += 1) {
          const needle = tokenSquash[t];
          let found = false;
          for (let c = 0; c < columnSquash.length; c += 1) {
            if (columnSquash[c][rowIndex].includes(needle)) {
              found = true;
              break;
            }
          }
          if (!found) continue rowLoop;
        }
        const row = rows[rowIndex];
        for (const [position, values] of filterChecks) {
          const value = row[position];
          if (!values.some((candidate) =>
            isBlank(candidate) ? isBlank(value) : candidate === value)) continue rowLoop;
        }
        matches.push(rowIndex);
      }
    }

    if (sort !== 'source') {
      // Preserve the immutable source order when sorting the unfiltered dataset.
      if (matches === sourceIndices) matches = matches.slice();
      const position = fieldPositions.get(sort);
      const multiplier = direction === 'desc' ? -1 : 1;
      matches.sort((left, right) => {
        const a = rows[left][position];
        const b = rows[right][position];
        const aBlank = isBlank(a);
        const bBlank = isBlank(b);
        if (aBlank !== bBlank) return aBlank ? 1 : -1;
        if (aBlank && bBlank) return left - right;
        return collator.compare(String(a), String(b)) * multiplier || left - right;
      });
    } else if (forms.length) {
      // Relevance only orders the implicit source sort; an explicit column sort wins.
      if (!scores) scores = new Uint8Array(rows.length);
      for (const rowIndex of matches) scores[rowIndex] = relevance(rowIndex, forms);
      matches.sort((left, right) => scores[right] - scores[left] || left - right);
      if (direction === 'desc') matches.reverse();
    } else if (direction === 'desc') {
      if (matches === sourceIndices) matches = matches.slice();
      matches.reverse();
    }

    lastKey = key;
    lastMatches = matches;
    return matches;
  }

  return {
    query(input = {}) {
      const matches = findMatches(input);
      const pageSize = Math.min(250, positiveInteger(input?.pageSize, 25));
      const pageCount = Math.ceil(matches.length / pageSize);
      const page = Math.min(Math.max(1, pageCount), positiveInteger(input?.page, 1));
      const indices = matches.slice((page - 1) * pageSize, page * pageSize);
      return {
        total: matches.length,
        page,
        pageCount,
        indices,
        rows: indices.map((rowIndex) => rows[rowIndex]),
        unterminatedQuote: hasUnterminatedQuote(input?.q),
      };
    },
    matchingIndices(input = {}) {
      // Callers may reorder their export list without corrupting pagination.
      return findMatches(input).slice();
    },
    lookup(recordId) {
      if (recordId === null || recordId === undefined) return -1;
      return recordPositions.get(String(recordId)) ?? -1;
    },
    /** Live facet tallies over the current match set, so the counts follow the selection. */
    facetCounts(input = {}, fields = []) {
      const matches = findMatches(input);
      const requested = Array.isArray(fields) ? fields : [fields];
      const counts = new Map();
      for (const field of requested) {
        if (typeof field !== 'string' || counts.has(field)) continue;
        const tally = new Map();
        counts.set(field, tally);
        const position = fieldPositions.get(field);
        if (position === undefined) continue;
        for (const rowIndex of matches) {
          const value = rows[rowIndex][position];
          const name = isBlank(value) ? '' : String(value);
          tally.set(name, (tally.get(name) ?? 0) + 1);
        }
      }
      // fromEntries, not a literal: a raw cell called "__proto__" must stay an own property.
      return Object.fromEntries([...counts].map(([field, tally]) => [field, Object.fromEntries(tally)]));
    },
    loadSequences(asset) {
      if (!asset || !Array.isArray(asset.keys) || !Array.isArray(asset.rows) ||
          asset.keys.length !== asset.rows.length) {
        throw new TypeError('Sequence data must contain matching keys and rows arrays.');
      }
      sequenceKeys = asset.keys;
      sequenceRows = asset.rows;
      return sequenceKeys.length;
    },
    /** Exact chain match: canonicalise, hash, then binary-search the sorted hex keys. */
    lookupSequence(value) {
      if (!sequenceKeys) throw new Error('Sequence data has not loaded yet.');
      const canonical = canonicalSequence(value);
      if (!canonical) return [];
      const key = fnv1a64(canonical);
      let low = 0;
      let high = sequenceKeys.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const candidate = sequenceKeys[middle];
        // A copy: callers reorder their own result without editing the loaded asset.
        if (candidate === key) {
          const found = sequenceRows[middle];
          return Array.isArray(found) ? found.slice() : [];
        }
        if (candidate < key) low = middle + 1;
        else high = middle - 1;
      }
      return [];
    },
  };
}
