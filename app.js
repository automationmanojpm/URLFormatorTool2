'use strict';

/** Release version — bump for fixes/features; update CHANGELOG.md and `?v=` on app.js + style.css in index.html. */
const APP_VERSION = '1.3.5';

/** Full URL lists per output tab — used for output search / filter */
const lastOutputArrays = {
  'final-list': [],
  'final-list-ios': [],
  'with-scheme': [],
  'no-scheme': [],
  'ports-only': [],
  'wildcard-log': [],
  'skipped-list': [],
};

/* ══════════════════════════════════════════════
   PARSING — detect and extract raw URL strings
   ══════════════════════════════════════════════ */

function detectFormat(text) {
  const t = text.trim();
  if (t.startsWith('[')) return 'json';

  // Multi-line: check if any line looks like a CSV row (has quoted fields or commas)
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const csvLike = lines.some(l => (l.startsWith('"') && l.includes(',')) || l.split(',').length > 2);
    if (csvLike) return 'csv';
    return 'lines';
  }

  // Single line: if it has commas it's CSV
  if (t.includes(',')) return 'csv';
  return 'lines';
}

function parseInput(text, formatHint) {
  const format = formatHint === 'auto' ? detectFormat(text) : formatHint;

  if (format === 'json') {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      const bracket = parseUnquotedBracketUrlList(text.trim());
      if (bracket !== null) return bracket;
    }
  }

  if (format === 'csv') {
    // Parse each line as a CSV row and flatten — handles both single-line and multi-line CSVs
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
      if (line.includes(',') || line.startsWith('"')) {
        results.push(...parseCsvRow(line));
      } else {
        // Plain line with no commas — strip any surrounding quotes and add directly
        const v = line.replace(/^["']+|["']+$/g, '').trim();
        if (v) results.push(v);
      }
    }
    return results;
  }

  // default: one per line — strip surrounding quotes so "https://x.com" works
  return text.split('\n')
    .map(l => l.trim().replace(/^["']+|["']+$/g, '').trim())
    .filter(Boolean);
}

/**
 * iOS / MDM-style paste: [https://a.com,https://b.com] (no JSON quotes).
 * Splits on commas only when followed by http(s):// to reduce breaks inside query strings.
 */
function parseUnquotedBracketUrlList(text) {
  const t = text.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(/,(?=https?:\/\/)/i).map(s => s.trim()).filter(Boolean);
}

function parseCsvRow(text) {
  const results = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      const v = current.trim();
      if (v) results.push(v);
      current = '';
    } else {
      current += ch;
    }
  }
  const v = current.trim();
  if (v) results.push(v);
  return results;
}

/* ══════════════════════════════════════════════
   SPLITTING — handle glued URLs (https://a...https://b)
   ══════════════════════════════════════════════ */

/**
 * Split concatenated URLs (e.g. …comhttps://…) but not nested https:// inside a query value
 * (e.g. redirect_uri=https://…) — OAuth and similar use `=` before the inner scheme.
 */
function splitGlued(value) {
  return value.split(/(?<!=)(?=https?:\/\/)/i).map(s => s.trim()).filter(Boolean);
}

/* ══════════════════════════════════════════════
   CLEANING — main URL normalisation
   ══════════════════════════════════════════════ */

const APP_TLDS = new Set(['controller', 'mpassplus', 'android', 'ios']);

/**
 * Remove query params whose entire value is a lone `*` (DigiLocker-style placeholders),
 * without touching values like `state=SFDC_CA_DEV/*`.
 */
function normalizeQueryWildcardOnlyStars(query) {
  if (!query || query[0] !== '?') return query;
  let q = query;
  while (/&[^&=]+=\*$/.test(q)) {
    q = q.replace(/&[^&=]+=\*$/, '');
  }
  const single = q.match(/^\?([^=&]+)=\*$/);
  if (single) return `?${single[1]}`;
  return q;
}

/**
 * Returns { withScheme, noScheme, hasPort, wildcardLog } or null if invalid.
 * `wildcardLog` is a short human-readable summary when *, /*, or *. glob rules changed the URL.
 */
function cleanEntry(raw, opts) {
  const wcNotes = [];
  let s = raw.trim().replace(/,+$/, '');

  // Strip surrounding quotes that may survive CSV/line parsing
  s = s.replace(/^["']+|["']+$/g, '').trim();

  // Strip leading glob * before a scheme letter
  {
    const before = s;
    s = s.replace(/^\*+(?=[a-zA-Z])/g, '').trim();
    if (s !== before) wcNotes.push('removed leading * before scheme');
  }

  // Remove all whitespace
  s = s.replace(/\s+/g, '');

  // Strip trailing wildcards/slashes from the path only (before `?`), so query values
  // like `state=SFDC_CA_DEV/*` stay intact. Lone-* placeholder params are handled below.
  const qMark = s.indexOf('?');
  let basePart = qMark === -1 ? s : s.slice(0, qMark);
  let queryPart = qMark === -1 ? '' : s.slice(qMark);
  const hadTrailingWildcard = /\*$/.test(basePart);
  {
    const before = basePart;
    basePart = basePart.replace(/[/*]+$/, '').trim();
    if (basePart !== before) wcNotes.push('removed trailing / or * from path (before ?)');
  }
  if (queryPart) {
    const beforeQ = queryPart;
    queryPart = normalizeQueryWildcardOnlyStars(queryPart);
    if (queryPart !== beforeQ) wcNotes.push('normalized query param(s) with lone * value');
  }
  s = basePart + queryPart;

  // Only clean up orphaned path/query artefacts when a trailing * was removed from the path.
  // e.g. path …/foo?app_id=* — * removed from path? No; lone * in query handled by normalizeQueryWildcardOnlyStars.
  // Legacy: path ended with /* → query orphan cleanup on full string.
  if (hadTrailingWildcard) {
    const beforeO = s;
    s = s.replace(/(?:&[^&=]*=?)$/, ''); // strip trailing &key= or &key artefact
    s = s.replace(/[=&?]+$/, '').trim(); // strip remaining orphaned = & ?
    s = s.replace(/\?$/, '').trim(); // strip empty query marker
    if (s !== beforeO) wcNotes.push('cleaned trailing query fragment after path wildcard removal');
  }

  if (!s) return null;

  // Fix single-slash scheme: https:/foo → https://foo
  if (opts.fixSchemes) {
    s = s.replace(/^(https?:)\/(?!\/)/i, '$1//');
  }

  // Detect scheme (track http/https so "Add https://" can be skipped for bare domains only)
  let hadHttpFamily = false;
  const schemeM = s.match(/^([a-z][a-z0-9+.-]*):/i);
  // If the "scheme" contains a dot, the first : is almost certainly host:port (e.g. internal.com:8080), not a scheme.
  if (schemeM && !schemeM[1].includes('.')) {
    const scheme = schemeM[1].toLowerCase();
    if (['http', 'https'].includes(scheme)) hadHttpFamily = true;
    if (opts.filterNonHttp && !['http', 'https'].includes(scheme)) {
      return null; // non-HTTP scheme (app IDs, tel:, etc.)
    }
    s = s.slice(schemeM[0].length).replace(/^\/\//, '');
  } else {
    s = s.replace(/^\/\//, '');
  }

  // Strip wildcard host prefixes: *.domain.com → domain.com
  if (opts.stripWildcards) {
    const beforeW = s;
    s = s.replace(/^(\*\.)+/g, '');
    s = s.replace(/^\*+/g, '');
    if (s !== beforeW) wcNotes.push('stripped *. or * wildcard host prefix');
  }

  // Strip www.
  if (opts.stripWww) {
    s = s.replace(/^www\./i, '');
  }

  if (!s) return null;

  // Split into host:port and path
  const slashIdx = s.indexOf('/');
  let hostPort = slashIdx !== -1 ? s.slice(0, slashIdx) : s;
  let path = slashIdx !== -1 ? s.slice(slashIdx) : '';

  // Strip remaining inline wildcards from pathname only (not query — e.g. state=…/*)
  if (opts.stripWildcards) {
    const beforePath = path;
    const pq = path.indexOf('?');
    if (pq === -1) {
      path = path.replace(/(\/?\*)+$/g, '').replace(/\/+$/, '');
    } else {
      let pathOnly = path.slice(0, pq);
      const queryOnly = path.slice(pq);
      pathOnly = pathOnly.replace(/(\/?\*)+$/g, '').replace(/\/+$/, '');
      path = pathOnly + queryOnly;
    }
    if (path !== beforePath) wcNotes.push('removed trailing path wildcards (/* …) from pathname');
  }

  // Strip paths if option enabled
  if (opts.stripPaths) {
    path = '';
  }

  // Validate host
  const host = hostPort.split(':')[0];
  const hostClean = host.replace(/^\.+/, '');

  // Must contain a dot
  if (!hostClean.includes('.')) return null;

  // Drop entries that start with a dot after cleaning
  if (hostClean.startsWith('.')) return null;

  // Drop known app-identifier TLDs
  if (opts.filterNonHttp) {
    const tld = hostClean.split('.').pop().toLowerCase();
    if (APP_TLDS.has(tld)) return null;
  }

  // Strip any leading dot from host:port artefact
  hostPort = hostPort.replace(/^\.+/, '');

  // Drop incomplete query strings (ends with = or &)
  const full = hostPort + path;
  if (opts.dropIncompleteQuery && /[=&]$/.test(full)) return null;

  // Detect port
  const hasPort = /:\d+/.test(hostPort);

  // Check if there is actually a valid TLD (must end in 2+ letter TLD)
  if (!/\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(full)) return null;

  const dedupKey = 'https://' + full;
  const noScheme = hasPort ? null : full; // port entries excluded from no-scheme
  // Without addScheme, do not synthesize https:// for bare host/path (no port); ports still need https in lists
  const omitSyntheticHttps = !opts.addScheme && !hadHttpFamily && !hasPort;
  const withScheme = omitSyntheticHttps ? null : dedupKey;

  const wildcardLog = wcNotes.length ? wcNotes.join(' · ') : null;
  return { withScheme, noScheme, hasPort, raw, dedupKey, wildcardLog };
}

/** Tab-separated row for wildcard log; normalizes tabs/newlines inside cells so each entry stays one line. */
function wildcardLogTsvRow(piece, dedupKey, wildcardLog) {
  const cell = s =>
    String(s)
      .replace(/\t/g, ' ')
      .replace(/\r\n|\r|\n/g, ' ');
  return [cell(piece), cell(dedupKey), cell(wildcardLog)].join('\t');
}

/** First line of wildcard log textarea (not included in `lastOutputArrays['wildcard-log']` for filtering). */
const WILDCARD_LOG_TSV_HEADER = 'In\tOut\tRules applied';

/* ══════════════════════════════════════════════
   PROCESSING — orchestrate everything
   ══════════════════════════════════════════════ */

function process(inputText, opts) {
  const formatHint = document.querySelector('input[name="input-format"]:checked').value;
  const rawEntries = parseInput(inputText, formatHint);

  const results = {
    withScheme: [],
    noScheme: [],
    portsOnly: [],
    finalList: [],      // shape from opts.finalListPreset: full-https → all withScheme; else bare + https for ports
    finalPortCount: 0,  // entries with explicit :port (for legend / summary)
    /** One tab-separated row per accepted URL where glob/wildcard rules changed the input (In, Out, rules) */
    wildcardNotes: [],
    skipped: [],
    totalInput: 0,
    validCount: 0,   // all successfully cleaned URLs, regardless of which outputs are on
    dupesRemoved: 0,
  };

  const allPieces = [];

  for (const entry of rawEntries) {
    results.totalInput++;
    const pieces = splitGlued(entry);
    for (const piece of pieces) {
      allPieces.push({ piece, original: entry });
    }
  }

  // If splitting produced more than original count, adjust totalInput
  // (keep totalInput as number of raw CSV/line entries)

  const seenWith = new Set();
  const seenNo   = new Set();

  for (const { piece, original } of allPieces) {
    const cleaned = cleanEntry(piece, opts);

    if (!cleaned) {
      results.skipped.push(piece || original);
      continue;
    }

    const { withScheme, noScheme, hasPort, dedupKey, wildcardLog } = cleaned;

    const isDup = opts.dedup && seenWith.has(dedupKey);
    if (isDup) {
      results.dupesRemoved++;
      continue; // skip dup across all output lists
    }
    seenWith.add(dedupKey);
    results.validCount++;

    if (wildcardLog) {
      results.wildcardNotes.push(wildcardLogTsvRow(piece, dedupKey, wildcardLog));
    }

    if (opts.outWithScheme && withScheme) {
      results.withScheme.push(withScheme);
    }

    if (opts.outNoScheme && noScheme) {
      if (!seenNo.has(noScheme)) {
        seenNo.add(noScheme);
        results.noScheme.push(noScheme);
      }
    }

    if (opts.outPorts && hasPort) {
      results.portsOnly.push(dedupKey);
    }

    const flp = opts.finalListPreset || 'edge';
    if (flp === 'full-https') {
      if (withScheme) {
        results.finalList.push(withScheme);
        if (hasPort) results.finalPortCount++;
      } else if (noScheme) {
        results.finalList.push(noScheme);
      }
    } else {
      if (hasPort) {
        results.finalList.push(dedupKey);
        results.finalPortCount++;
      } else if (noScheme) {
        results.finalList.push(noScheme);
      }
    }
  }

  return results;
}

/* ══════════════════════════════════════════════
   JSON SERIALISATION
   ══════════════════════════════════════════════ */

function toJson(arr, compact) {
  if (arr.length === 0) return '[]';
  if (compact) {
    return '[' + arr.map(v => JSON.stringify(v)).join(',') + ']';
  }
  return JSON.stringify(arr, null, 2);
}

/** Same order as Final List; comma-separated, no JSON quotes and no surrounding `[]` (iOS / MDM paste). */
function toIosManagedAppConfigArray(arr) {
  if (arr.length === 0) return '';
  return arr.map(v => String(v)).join(',');
}

/* ══════════════════════════════════════════════
   UI HELPERS
   ══════════════════════════════════════════════ */

/**
 * Quick preset that controls Final List shape.
 * Active chip wins; else infer from toggles; custom mixes → Edge-style Final List.
 */
function getFinalListPresetId() {
  const active = document.querySelector('.preset-btn.active');
  if (active && ['edge', 'full-https', 'domains'].includes(active.dataset.preset)) {
    return active.dataset.preset;
  }
  const www   = document.getElementById('opt-strip-www').checked;
  const ows   = document.getElementById('opt-out-with-scheme').checked;
  const ons   = document.getElementById('opt-out-no-scheme').checked;
  const ports = document.getElementById('opt-out-ports').checked;
  if (!www && ows && ons && ports) return 'full-https';
  if (www && !ows && ons && !ports) return 'domains';
  return 'edge';
}

function getOpts() {
  return {
    stripWildcards:      document.getElementById('opt-strip-wildcards').checked,
    stripWww:            document.getElementById('opt-strip-www').checked,
    fixSchemes:          document.getElementById('opt-fix-schemes').checked,
    addScheme:           document.getElementById('opt-add-scheme').checked,
    dedup:               document.getElementById('opt-dedup').checked,
    filterNonHttp:       document.getElementById('opt-filter-non-http').checked,
    dropIncompleteQuery: document.getElementById('opt-drop-incomplete-query').checked,
    stripPaths:          document.getElementById('opt-strip-paths').checked,
    outWithScheme:       document.getElementById('opt-out-with-scheme').checked,
    outNoScheme:         document.getElementById('opt-out-no-scheme').checked,
    outPorts:            document.getElementById('opt-out-ports').checked,
    compact:             document.getElementById('opt-compact').checked,
    finalListPreset:     getFinalListPresetId(),
  };
}

const PRESET_HINTS = {
  edge:
    'Full <strong>Reset to defaults</strong> cleaning/filtering · strip <code>www.</code> · all output tabs on · <strong>Final List</strong> = bare + <code>https://</code> for ports (Edge).',
  'full-https':
    'Same cleaning defaults as Edge · keep <code>www.</code> · all output tabs on · <strong>Final List</strong> = every line <code>https://…</code>.',
  domains:
    'Same cleaning defaults as Edge · strip <code>www.</code> · <strong>No Scheme</strong> only among outputs · <strong>Final List</strong> = Edge-style ports rule.',
};

/** Rich copy for the (i) panels — keep in sync with processing behavior. */
const PRESET_DETAILS = {
  edge: `
    <p><strong>When to use:</strong> Microsoft Edge <strong>URL List</strong> and similar policies where you want one combined list.</p>
    <p><strong>What it sets:</strong> <strong>All</strong> processing options match <strong>Reset to defaults</strong> — cleaning, filtering, compact JSON, plus strip <code>www.</code> and <strong>With Scheme</strong>, <strong>No Scheme</strong>, and <strong>Ports Only</strong> all on.</p>
    <p><strong>Final List:</strong> Bare host/path when there is no port; <code>https://</code> is added only for URLs with an explicit port so Edge can parse them.</p>
  `,
  'full-https': `
    <p><strong>When to use:</strong> You need every <strong>Final List</strong> line to be a full URL with <code>https://</code>, while keeping <code>www.</code> when it appears in the input.</p>
    <p><strong>What it sets:</strong> Same cleaning/filtering/compact as Edge preset, but <strong>Strip www</strong> off · all three output lists on.</p>
    <p><strong>Final List:</strong> Same rows as <strong>With Scheme</strong> — every entry is <code>https://…</code>, including hosts without an explicit port.</p>
  `,
  domains: `
    <p><strong>When to use:</strong> Workflows that only need the bare <strong>No Scheme</strong> column (e.g. domain allowlists, some validators).</p>
    <p><strong>What it sets:</strong> Same cleaning/filtering/compact as Edge preset · <strong>No Scheme</strong> on · <strong>With Scheme</strong> and <strong>Ports Only</strong> off.</p>
    <p><strong>Final List:</strong> Same Edge-style rule as the first preset: bare when possible, <code>https://</code> only when a port is present (so port URLs stay valid).</p>
  `,
};

function initPresetDetailPanels() {
  document.querySelectorAll('.preset-detail-popover').forEach(pop => {
    const id = pop.id.replace(/^preset-tooltip-/, '');
    const html = PRESET_DETAILS[id];
    if (html) pop.innerHTML = html.trim();
  });
}

/** Touch / coarse pointers: popovers are toggled open until dismissed. */
function closeAllPresetPopoverPins() {
  document.querySelectorAll('.preset-info-wrap--open').forEach(w => {
    w.classList.remove('preset-info-wrap--open');
    const btn = w.querySelector('.preset-info-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

function initPresetPopoverTouch() {
  if (!window.matchMedia('(hover: none)').matches) return;

  document.querySelectorAll('.preset-info-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest('.preset-info-wrap');
      if (!wrap) return;
      const wasOpen = wrap.classList.contains('preset-info-wrap--open');
      closeAllPresetPopoverPins();
      if (!wasOpen) {
        wrap.classList.add('preset-info-wrap--open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.preset-info-wrap')) closeAllPresetPopoverPins();
  });
}

function setPresetHint(presetId) {
  const el = document.getElementById('preset-hint');
  if (!el) return;
  el.innerHTML = PRESET_HINTS[presetId] || PRESET_HINTS.edge;
}

function setPresetButtonsActive(presetId) {
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === presetId);
  });
  document.querySelectorAll('.preset-card').forEach(card => {
    card.classList.toggle('preset-card-active', card.dataset.preset === presetId);
  });
}

/**
 * True while a preset (or programmatic reset) is updating checkboxes.
 * Suppresses clearing the active preset highlight on synthetic change events.
 */
let _applyingPreset = false;

/** Every processing-options checkbox (cleaning, filtering, outputs, compact). */
const ALL_OPTION_CHECKBOX_IDS = [
  'opt-strip-wildcards',
  'opt-strip-www',
  'opt-fix-schemes',
  'opt-add-scheme',
  'opt-dedup',
  'opt-filter-non-http',
  'opt-drop-incomplete-query',
  'opt-strip-paths',
  'opt-out-with-scheme',
  'opt-out-no-scheme',
  'opt-out-ports',
  'opt-compact',
];

/** Cleaning + filtering + compact shared by all quick presets (same as Reset to defaults). */
const PRESET_SHARED_CLEANING = {
  'opt-strip-wildcards': true,
  'opt-fix-schemes': true,
  'opt-add-scheme': true,
  'opt-dedup': true,
  'opt-filter-non-http': true,
  'opt-drop-incomplete-query': true,
  'opt-strip-paths': false,
  'opt-compact': true,
};

/**
 * Set checkbox from script. Dispatches input/change so custom switch CSS stays in sync.
 */
function setOptionCheckbox(inputId, checked) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.checked = checked;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Applies full preset: shared cleaning/filtering/compact, then strip-www + output lists. */
function applyOutputPreset(presetId) {
  const id =
    presetId === 'full-https' || presetId === 'domains' ? presetId : 'edge';

  closeAllPresetPopoverPins();

  _applyingPreset = true;
  try {
    for (const [inputId, checked] of Object.entries(PRESET_SHARED_CLEANING)) {
      setOptionCheckbox(inputId, checked);
    }
    if (id === 'full-https') {
      setOptionCheckbox('opt-strip-www', false);
      setOptionCheckbox('opt-out-with-scheme', true);
      setOptionCheckbox('opt-out-no-scheme', true);
      setOptionCheckbox('opt-out-ports', true);
    } else if (id === 'domains') {
      setOptionCheckbox('opt-strip-www', true);
      setOptionCheckbox('opt-out-with-scheme', false);
      setOptionCheckbox('opt-out-no-scheme', true);
      setOptionCheckbox('opt-out-ports', false);
    } else {
      setOptionCheckbox('opt-strip-www', true);
      setOptionCheckbox('opt-out-with-scheme', true);
      setOptionCheckbox('opt-out-no-scheme', true);
      setOptionCheckbox('opt-out-ports', true);
    }
    setPresetButtonsActive(id);
    setPresetHint(id);
  } finally {
    _applyingPreset = false;
  }
}

function clearPresetSelection() {
  if (_applyingPreset) return;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('preset-card-active'));
}

const PRESET_CUSTOM_HINT =
  'Custom mix — toggles were changed manually; no preset is selected. Pick a quick preset below to apply that layout and highlight it.';

/** Sync card + hint from the button that has .active in HTML (first load). */
function initPresetSelectionState() {
  const active = document.querySelector('.preset-btn.active');
  if (active && ['edge', 'full-https', 'domains'].includes(active.dataset.preset)) {
    const id = active.dataset.preset;
    setPresetButtonsActive(id);
    setPresetHint(id);
  } else {
    clearPresetSelection();
    const el = document.getElementById('preset-hint');
    if (el) el.innerHTML = PRESET_CUSTOM_HINT;
  }
}

/**
 * Any manual change to an option clears the preset highlight until a preset is chosen again.
 */
function onAnyOptionCheckboxChange() {
  if (_applyingPreset) return;
  clearPresetSelection();
  const el = document.getElementById('preset-hint');
  if (el) el.innerHTML = PRESET_CUSTOM_HINT;
}

function setDefaultOpts() {
  applyOutputPreset('edge');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg || 'Copied!';
  toast.classList.remove('hidden');
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 220);
  }, 1800);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap all case-insensitive occurrences of q in <mark> */
function highlightHtml(text, q) {
  const t = String(text);
  if (!q) return escapeHtml(t);
  const lower = t.toLowerCase();
  const qLower = q.toLowerCase();
  const ql = qLower.length;
  let out = '';
  let i = 0;
  while (i < t.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx === -1) {
      out += escapeHtml(t.slice(i));
      break;
    }
    out += escapeHtml(t.slice(i, idx));
    out += '<mark class="search-hit">' + escapeHtml(t.slice(idx, idx + ql)) + '</mark>';
    i = idx + ql;
  }
  return out;
}

function getActiveTabName() {
  const t = document.querySelector('#output-tabs .tab.active');
  return t ? t.dataset.tab : 'final-list';
}

function hasPortInUrl(u) {
  return /https?:\/\/[^/?#]+:\d+/i.test(String(u));
}

function setOutputSearchEnabled(on) {
  const input = document.getElementById('output-search-input');
  const hint  = document.getElementById('output-search-hint');
  input.disabled = !on;
  hint.classList.toggle('hidden', on);
  if (!on) {
    input.value = '';
    document.getElementById('output-search-clear').classList.add('hidden');
    document.getElementById('output-search-count').classList.add('hidden');
    const filteredEl = document.getElementById('output-search-filtered');
    filteredEl.classList.add('hidden');
    filteredEl.innerHTML = '';
    const tab = getActiveTabName();
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('active', p.id === 'panel-' + tab));
  }
}

/** Rebuild filtered list or restore tab panels based on output search text */
function refreshOutputSearch() {
  const q = document.getElementById('output-search-input').value.trim();
  const countEl = document.getElementById('output-search-count');
  const clearBtn = document.getElementById('output-search-clear');
  const filteredEl = document.getElementById('output-search-filtered');
  const tab = getActiveTabName();
  const items = lastOutputArrays[tab] || [];

  if (!q) {
    filteredEl.classList.add('hidden');
    filteredEl.innerHTML = '';
    countEl.classList.add('hidden');
    clearBtn.classList.add('hidden');
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('active', p.id === 'panel-' + tab));
    return;
  }

  clearBtn.classList.remove('hidden');
  const qLower = q.toLowerCase();
  const filtered = items.filter(u => String(u).toLowerCase().includes(qLower));
  countEl.textContent = `${filtered.length} / ${items.length} shown`;
  countEl.classList.remove('hidden');

  filteredEl.classList.remove('hidden');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

  if (filtered.length === 0) {
    filteredEl.innerHTML = '<div class="fv-empty">No matches in this tab.</div>';
    return;
  }

  let html = '';
  for (const u of filtered) {
    const portCls = hasPortInUrl(u) ? ' fv-row-port' : '';
    html += `<div class="fv-row${portCls}">${highlightHtml(u, q)}</div>`;
  }
  html += '<div class="fv-footer">Copy / Download use the full list for this tab, not the filter.</div>';
  filteredEl.innerHTML = html;
}

function updateInputSearch() {
  const wrap = document.getElementById('input-search-wrap');
  const filteredEl = document.getElementById('input-search-filtered');

  if (wrap.classList.contains('hidden')) {
    filteredEl.classList.add('hidden');
    filteredEl.innerHTML = '';
    return;
  }

  const q = document.getElementById('input-search-input').value.trim();
  const countEl = document.getElementById('input-search-count');
  const clearBtn = document.getElementById('input-search-clear');
  const text = document.getElementById('url-input').value;
  const fmt = document.querySelector('input[name="input-format"]:checked');
  const hint = fmt ? fmt.value : 'auto';

  let entries = [];
  try {
    entries = parseInput(text, hint);
  } catch {
    entries = [];
  }
  if (entries.length === 0 && text.trim()) {
    entries = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (entries.length === 0) entries = [text.trim()];
  }

  if (!q) {
    clearBtn.classList.add('hidden');
    filteredEl.classList.add('hidden');
    filteredEl.innerHTML = '';
    if (!text.trim()) {
      countEl.classList.add('hidden');
    } else if (entries.length > 0) {
      countEl.textContent = `${entries.length} parsed entries — type to filter the list below`;
      countEl.classList.remove('hidden');
    } else {
      countEl.textContent = 'Could not parse — try another format';
      countEl.classList.remove('hidden');
    }
    return;
  }

  clearBtn.classList.remove('hidden');
  const qLower = q.toLowerCase();
  const matches = entries.filter(e => String(e).toLowerCase().includes(qLower));
  countEl.textContent = `${matches.length} of ${entries.length} entries match — shown in the list below (full paste unchanged)`;
  countEl.classList.remove('hidden');

  filteredEl.classList.remove('hidden');
  if (matches.length === 0) {
    filteredEl.innerHTML =
      '<div class="fv-empty">No entries match. Try another term or input format.</div>';
    return;
  }

  let html = '';
  for (const u of matches) {
    html += `<div class="fv-row">${highlightHtml(String(u), q)}</div>`;
  }
  html +=
    '<div class="fv-footer">The text box below still contains your full paste. <strong>Process URLs</strong> uses everything in that box, not only this list.</div>';
  filteredEl.innerHTML = html;
}

function switchTab(tabName) {
  document.querySelectorAll('#output-tabs .tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tabName));
  refreshOutputSearch();
}

function downloadJson(content, filename) {
  const blob = new Blob([content], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function refreshFinalListDescription(presetId, entryCount) {
  const block = document.getElementById('final-list-descblock');
  if (!block) return;

  const legendFull = `<span class="final-legend"><span class="legend-dot legend-dot-plain"></span> <code>https://</code> without <code>:port</code> &nbsp; <span class="legend-dot legend-dot-port"></span> includes <code>:port</code></span>`;
  const legendEdge = `<span class="final-legend"><span class="legend-dot legend-dot-plain"></span> Bare domain/path &nbsp; <span class="legend-dot legend-dot-port"></span> <code>https://</code> (port detected)</span>`;

  if (!entryCount) {
    block.innerHTML =
      `<strong>Final List.</strong> Output shape follows your <strong>Quick preset</strong> below. Run <strong>Process URLs</strong> to generate. ${legendEdge}`;
    return;
  }

  if (presetId === 'full-https') {
    block.innerHTML =
      `<strong>Final List (Full URLs preset).</strong> Every entry is <code>https://…</code> (aligned with the With Scheme list). ${legendFull}`;
  } else {
    const label = presetId === 'domains' ? 'Domains' : 'Edge';
    block.innerHTML =
      `<strong>Final List (${label} preset).</strong> Bare host/path when possible — <code>https://</code> only when a port is present (Edge policy). ${legendEdge}`;
  }
}

/* ══════════════════════════════════════════════
   MAIN RUN
   ══════════════════════════════════════════════ */

function run() {
  const inputText = document.getElementById('url-input').value;
  if (!inputText.trim()) {
    document.getElementById('process-hint').textContent = 'Please paste some URLs first.';
    return;
  }
  document.getElementById('process-hint').textContent = '';

  const opts    = getOpts();
  const results = process(inputText, opts);
  const compact = opts.compact;

  const jsonFinal  = toJson(results.finalList, compact);
  const iosFinal   = toIosManagedAppConfigArray(results.finalList);
  const jsonWith   = toJson(results.withScheme, compact);
  const jsonNo     = toJson(results.noScheme, compact);
  const jsonPorts  = toJson(results.portsOnly, compact);
  const jsonSkip   = results.skipped.join('\n');
  const wildcardText =
    results.wildcardNotes.length > 0
      ? WILDCARD_LOG_TSV_HEADER + '\n' + results.wildcardNotes.join('\n')
      : '— No wildcard or glob normalization in this run. —';

  // Populate outputs
  document.getElementById('out-final-list').value     = jsonFinal;
  document.getElementById('out-final-list-ios').value = iosFinal;
  document.getElementById('out-with-scheme').value    = jsonWith;
  document.getElementById('out-no-scheme').value      = jsonNo;
  document.getElementById('out-ports-only').value     = jsonPorts;
  document.getElementById('out-wildcard-log').value   = wildcardText;
  document.getElementById('out-skipped-list').value   = jsonSkip;

  // Final list summary + description (preset-aware)
  refreshFinalListDescription(opts.finalListPreset, results.finalList.length);

  const plainCount = results.finalList.length - results.finalPortCount;
  let summaryInner = '';
  if (results.finalList.length > 0) {
    if (opts.finalListPreset === 'full-https') {
      summaryInner =
        `<span class="fs-item">All <span class="fs-count">${results.finalList.length}</span> use <code>https://</code></span>` +
        (results.finalPortCount > 0
          ? `<span class="fs-item"><span class="fs-count fs-count-port">${results.finalPortCount}</span> include an explicit port</span>`
          : '') +
        `<span class="fs-item">Total: <span class="fs-count">${results.finalList.length}</span> entries</span>`;
    } else {
      summaryInner =
        `<span class="fs-item"><span class="fs-count fs-count-plain">${plainCount}</span> bare domain entries</span>` +
        (results.finalPortCount > 0
          ? `<span class="fs-item"><span class="fs-count fs-count-port">${results.finalPortCount}</span> port-based (<code>https://</code>)</span>`
          : '') +
        `<span class="fs-item">Total: <span class="fs-count">${results.finalList.length}</span> entries</span>`;
    }
  }
  document.getElementById('final-summary').innerHTML = summaryInner;

  // Badges
  document.getElementById('badge-final-list').textContent     = results.finalList.length;
  document.getElementById('badge-final-list-ios').textContent = results.finalList.length;
  document.getElementById('badge-with-scheme').textContent    = results.withScheme.length;
  document.getElementById('badge-no-scheme').textContent   = results.noScheme.length;
  document.getElementById('badge-ports-only').textContent  = results.portsOnly.length;
  document.getElementById('badge-wildcard-log').textContent  = results.wildcardNotes.length;
  document.getElementById('badge-skipped').textContent     = results.skipped.length;

  // Stats — validCount is independent of which output tabs are enabled
  document.getElementById('stat-total').textContent   = results.totalInput;
  document.getElementById('stat-valid').textContent   = results.validCount;
  document.getElementById('stat-dedup').textContent   = results.dupesRemoved;
  document.getElementById('stat-skipped').textContent = results.skipped.length;
  document.getElementById('stat-ports').textContent   = results.portsOnly.length;

  // Show
  document.getElementById('stats-bar').classList.remove('hidden');
  document.getElementById('output-card').classList.remove('hidden');

  lastOutputArrays['final-list']     = results.finalList.slice();
  lastOutputArrays['final-list-ios'] = results.finalList.slice();
  lastOutputArrays['with-scheme']    = results.withScheme.slice();
  lastOutputArrays['no-scheme']    = results.noScheme.slice();
  lastOutputArrays['ports-only']   = results.portsOnly.slice();
  lastOutputArrays['wildcard-log'] = results.wildcardNotes.slice();
  lastOutputArrays['skipped-list'] = results.skipped.slice();

  setOutputSearchEnabled(true);
  document.getElementById('output-search-input').value = '';

  // Auto-switch to Final List if it has entries, otherwise first populated tab
  if (results.finalList.length > 0)       switchTab('final-list');
  else if (results.withScheme.length > 0) switchTab('with-scheme');
  else if (results.noScheme.length > 0)   switchTab('no-scheme');
  else if (results.portsOnly.length > 0)  switchTab('ports-only');
  else if (results.wildcardNotes.length > 0) switchTab('wildcard-log');
  else                                    switchTab('skipped-list');
}

/* ══════════════════════════════════════════════
   EVENT LISTENERS
   ══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  const verEl = document.getElementById('app-version');
  if (verEl) verEl.textContent = 'v' + APP_VERSION;

  // Process
  document.getElementById('process-btn').addEventListener('click', run);

  // Ctrl/Cmd + Enter shortcut
  document.getElementById('url-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
  });

  // Clear input
  document.getElementById('clear-btn').addEventListener('click', () => {
    document.getElementById('url-input').value = '';
    document.getElementById('stats-bar').classList.add('hidden');
    document.getElementById('output-card').classList.add('hidden');
    document.getElementById('process-hint').textContent = '';
    setOutputSearchEnabled(false);
    document.getElementById('input-search-input').value = '';
    document.getElementById('input-search-count').classList.add('hidden');
    document.getElementById('input-search-clear').classList.add('hidden');
    updateInputSearch();
  });

  // Reset options
  document.getElementById('reset-options-btn').addEventListener('click', setDefaultOpts);

  initPresetDetailPanels();
  initPresetPopoverTouch();

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyOutputPreset(btn.dataset.preset));
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllPresetPopoverPins();
  });

  ALL_OPTION_CHECKBOX_IDS.forEach(id => {
    document.getElementById(id).addEventListener('change', onAnyOptionCheckboxChange);
  });

  // File upload
  document.getElementById('file-upload').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      document.getElementById('url-input').value = evt.target.result;
      updateInputSearch();
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  });

  // Tab switching (output only)
  document.querySelectorAll('#output-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.getElementById('input-search-toggle').addEventListener('click', () => {
    const wrap = document.getElementById('input-search-wrap');
    const btn = document.getElementById('input-search-toggle');
    wrap.classList.toggle('hidden');
    const visible = !wrap.classList.contains('hidden');
    btn.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (visible) document.getElementById('input-search-input').focus();
    updateInputSearch();
  });

  document.getElementById('input-search-input').addEventListener('input', updateInputSearch);
  document.getElementById('input-search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      updateInputSearch();
      const panel = document.getElementById('input-search-filtered');
      if (!panel.classList.contains('hidden') && panel.innerHTML) {
        panel.scrollTop = 0;
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  });
  document.getElementById('input-search-clear').addEventListener('click', () => {
    document.getElementById('input-search-input').value = '';
    updateInputSearch();
    document.getElementById('input-search-input').focus();
  });

  document.getElementById('url-input').addEventListener('input', updateInputSearch);

  document.querySelectorAll('input[name="input-format"]').forEach(r => {
    r.addEventListener('change', updateInputSearch);
  });

  document.getElementById('output-search-input').addEventListener('input', refreshOutputSearch);
  document.getElementById('output-search-clear').addEventListener('click', () => {
    document.getElementById('output-search-input').value = '';
    refreshOutputSearch();
    document.getElementById('output-search-input').focus();
  });

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = {
        'final-list':     'out-final-list',
        'final-list-ios': 'out-final-list-ios',
        'with-scheme':    'out-with-scheme',
        'no-scheme':      'out-no-scheme',
        'ports-only':     'out-ports-only',
        'wildcard-log':   'out-wildcard-log',
        'skipped-list':   'out-skipped-list',
      }[btn.dataset.copy];
      const text = document.getElementById(id).value;
      navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!'));
    });
  });

  // Download buttons
  document.querySelectorAll('[data-download]').forEach(btn => {
    btn.addEventListener('click', () => {
      const map = {
        'final-list':     { id: 'out-final-list',     name: 'urls-final-list.json',     kind: 'json' },
        'final-list-ios': { id: 'out-final-list-ios', name: 'urls-final-list-ios.txt', kind: 'text' },
        'with-scheme':    { id: 'out-with-scheme',    name: 'urls-with-scheme.json',    kind: 'json' },
        'no-scheme':      { id: 'out-no-scheme',      name: 'urls-no-scheme.json',      kind: 'json' },
        'ports-only':     { id: 'out-ports-only',     name: 'urls-ports-only.json',     kind: 'json' },
        'wildcard-log':   { id: 'out-wildcard-log',   name: 'urls-wildcard-log.txt',    kind: 'text' },
      };
      const cfg = map[btn.dataset.download];
      if (!cfg) return;
      const content = document.getElementById(cfg.id).value;
      if (cfg.kind === 'text') downloadText(content, cfg.name);
      else downloadJson(content, cfg.name);
    });
  });

  updateInputSearch();
  initPresetSelectionState();
});
