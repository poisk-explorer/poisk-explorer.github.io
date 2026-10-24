/**
 * RFC 4180 CSV row. Every cell is quoted and embedded newlines are preserved.
 * Safe exports prefix formula-like text with an apostrophe; callers can disable
 * this to download exact raw cell values. Numbers and booleans stay unchanged.
 */
export function csvLine(values, { spreadsheetSafe = true } = {}) {
  if (!Array.isArray(values)) throw new TypeError('CSV row values must be an array.');
  return values.map((value) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (spreadsheetSafe && typeof value === 'string' &&
        (/^\s*[=+\-@]/u.test(value) || /^[\t\r]/u.test(value))) {
      text = `'${text}`;
    }
    return `"${text.replace(/"/g, '""')}"`;
  }).join(',') + '\r\n';
}

/** Accept only absolute HTTPS links from dataset/configuration values. */
export function safeExternalURL(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Keys may be a full dotted path or a bare last segment. Dotted paths win, because
 * vh.seq_id and vl.seq_id (and the three sequence_from_patent columns) share a last
 * segment and used to render as the same label in one definition list.
 *
 * Release 1.1 adds target.sequence, target.sequence_from_uniprot and target.sequence_accession.
 * Their last segments are unique but uninformative, and the fallback strips the "target." prefix
 * that carries the provenance distinction, so each is spelled out here too.
 */
const FIELD_LABELS = Object.freeze({
  unique_record_id: 'Record ID',
  patent_id: 'Patent ID',
  antibody_identifier: 'Antibody identifier',
  antibody_type: 'Antibody type',
  protein_name: 'Protein name',
  gene_names: 'Gene names',
  uniprot_id: 'UniProt ID',
  affinity_value: 'Affinity value',
  has_epitope: 'Epitope available',
  has_affinity: 'Affinity available',
  has_sequence: 'Sequence available',
  has_vh: 'VH sequence available',
  has_vl: 'VL sequence available',
  'vh.seq_id': 'VH SEQ ID',
  'vl.seq_id': 'VL SEQ ID',
  'target.seq_id': 'Target SEQ ID',
  'vh.sequence_from_patent': 'VH sequence (as reported)',
  'vl.sequence_from_patent': 'VL sequence (as reported)',
  'target.sequence_from_patent': 'Target sequence (as reported)',
  'target.sequence_accession': 'Target GenBank accession (patent deposit)',
  'target.sequence_from_uniprot': 'Target sequence (from UniProt)',
  'target.sequence': 'Target sequence (held by this release)',
  'vh.is_full_heavy_chain': 'Full heavy chain',
  'vl.is_full_light_chain': 'Full light chain',
  'discovery_methodology.cdr_modified': 'CDR modified',
  'epitope.linear_epitope_range.start': 'Linear epitope start',
  'epitope.linear_epitope_range.end': 'Linear epitope end',
});

export function formatLabel(field) {
  if (typeof field !== 'string') return '';
  if (Object.hasOwn(FIELD_LABELS, field)) return FIELD_LABELS[field];
  const key = field.split('.').at(-1);
  if (Object.hasOwn(FIELD_LABELS, key)) return FIELD_LABELS[key];
  const label = key.replace(/_/g, ' ').trim();
  return label ? label[0].toUpperCase() + label.slice(1) : '';
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = (1n << 64n) - 1n;

/** FNV-1a 64-bit over the ASCII bytes, as 16 lowercase hex digits. Must match build.py. */
export function fnv1a64(text) {
  const value = String(text ?? '');
  let h = FNV_OFFSET;
  for (let i = 0; i < value.length; i += 1) {
    h = ((h ^ BigInt(value.charCodeAt(i) & 0xff)) * FNV_PRIME) & FNV_MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/** The hashed form of a chain sequence: residue letters only, so spacing and numbering drop out. */
export function canonicalSequence(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z]/g, '');
}

/**
 * A chain as a person actually pastes it: off the clipboard, out of a FASTA file, or straight from
 * this site's own FASTA export. Description lines go first, because canonicalSequence keeps every
 * letter and would otherwise splice the header's words onto the front of the chain — which made the
 * explorer report its own exported sequences as absent from the release.
 */
export function pastedSequence(value) {
  const residues = String(value ?? '')
    .split(/[\r\n]+/u)
    .filter((line) => !/^\s*[>;]/u.test(line))
    .join('\n');
  return canonicalSequence(residues);
}

const FASTA_WRAP = 60;

/** One FASTA record. Pipes and newlines are stripped so the header stays a single field list. */
export function fastaEntry({ id, chain, antibody, patent, target, sequence } = {}) {
  const header = [id, chain, antibody, patent, target]
    .map((part) => String(part ?? '').replace(/[|\r\n]+/g, ' ').trim())
    .join('|');
  const residues = canonicalSequence(sequence);
  let body = '';
  for (let at = 0; at < residues.length; at += FASTA_WRAP) {
    body += `${residues.slice(at, at + FASTA_WRAP)}\n`;
  }
  return `>${header}\n${body}`;
}
