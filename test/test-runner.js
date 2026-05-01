// ============================================================================
// test-runner.js — runs scenarios against the live Lambda + USASpending
// ============================================================================
//
// Duplicates a slim version of minimo's resolver shape so the harness can
// run independently of the rendered UI. If minimo's resolver behavior
// drifts from this, tests will catch it as a difference between Mo's
// emitted tag and what the resolver would do — which is exactly what we
// want to surface.

import { SCENARIOS } from './test-scenarios.js';

const LAMBDA_URL = 'https://4gxuwrrugc4s6zqcxsos2exg5y0sjcrc.lambda-url.us-east-1.on.aws/';
const USASPENDING_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

// ── Tag parser (copied verbatim from minimo) ─────────────────────────────
const TAG_RE = /<\s*data\b([^>]{1,600}?)\/>/i;

function findDataTag(text) {
  const m = TAG_RE.exec(text);
  if (!m) return null;
  const inside = m[1];
  if (/\n/.test(inside)) return null;
  const attrs = {};
  const attrRe = /(\w+)\s*=\s*("([^">\n]*)"|'([^'>\n]*)')/g;
  let am;
  while ((am = attrRe.exec(inside))) attrs[am[1]] = am[3] !== undefined ? am[3] : am[4];
  return { match: m[0], start: m.index, end: m.index + m[0].length, attrs };
}

// ── Lambda call ───────────────────────────────────────────────────────────
// Returns { tagAttrs, proseBefore, proseAfter, rawText, lambdaMs, error }
async function callLambda(question, history = []) {
  const t0 = performance.now();
  const fullHistory = [...history, { role: 'user', parts: [{ text: question }] }];
  let rawText = '';
  let tagAttrs = null;
  let proseBefore = '';
  let proseAfter = '';
  let error = null;

  try {
    const res = await fetch(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: fullHistory }),
    });
    if (!res.ok) throw new Error(`Lambda HTTP ${res.status}`);
    if (!res.body) throw new Error('Lambda returned no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tagSpan = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      rawText += decoder.decode(value, { stream: true });
      if (!tagSpan) {
        const tag = findDataTag(rawText);
        if (tag) {
          tagSpan = { start: tag.start, end: tag.end };
          tagAttrs = tag.attrs;
        }
      }
    }

    if (tagSpan) {
      proseBefore = rawText.slice(0, tagSpan.start).trim();
      proseAfter = rawText.slice(tagSpan.end).trim();
    } else {
      proseBefore = rawText.trim();
    }
  } catch (e) {
    error = e.message;
  }

  return { tagAttrs, proseBefore, proseAfter, rawText, lambdaMs: Math.round(performance.now() - t0), error };
}

// ── Recipient resolution (mirrors production VENDOR_LEGAL_NAMES) ──────────
// Production's resolveRecipient maps shorthand like "SAIC" to the full USASpending
// legal entity name before hitting recipient_search_text. The test runner must
// do the same — using the short acronym as a keyword needle hits description text
// and returns 0 rows for vendors whose descriptions use the long form.
const VENDOR_LEGAL_NAMES = {
  'aws':                    'AMAZON WEB SERVICES',
  'amazon':                 'AMAZON WEB SERVICES',
  'saic':                   'SCIENCE APPLICATIONS INTERNATIONAL CORPORATION',
  'gdit':                   'GENERAL DYNAMICS INFORMATION TECHNOLOGY',
  'bah':                    'BOOZ ALLEN HAMILTON',
  'booz':                   'BOOZ ALLEN HAMILTON',
  'rtx':                    'RAYTHEON',
  'ibm':                    'INTERNATIONAL BUSINESS MACHINES',
  'msft':                   'MICROSOFT CORPORATION',
  'hpe':                    'HEWLETT PACKARD ENTERPRISE',
  // Microsoft product aliases
  'm365':                   'MICROSOFT CORPORATION',
  'microsoft 365':          'MICROSOFT CORPORATION',
  'office 365':             'MICROSOFT CORPORATION',
  'azure':                  'MICROSOFT CORPORATION',
  'microsoft azure':        'MICROSOFT CORPORATION',
  'defender':               'MICROSOFT CORPORATION',
  'microsoft defender':     'MICROSOFT CORPORATION',
  'microsoft sentinel':     'MICROSOFT CORPORATION',
  // Cybersecurity vendors
  'sentinelone':            'SENTINELONE',
  'sentinel one':           'SENTINELONE',
  'crowdstrike':            'CROWDSTRIKE',
  'akamai':                 'AKAMAI TECHNOLOGIES',
  'guardicore':             'AKAMAI TECHNOLOGIES',
  // Atlassian — reseller-only play
  'atlassian':              'ATLASSIAN',
  'jira':                   'ATLASSIAN',
  'confluence':             'ATLASSIAN',
};

// ── USASpending pull ──────────────────────────────────────────────────────
// Mirrors minimo's resolver: takes Mo's tag attrs, builds the right
// USASpending payload, fetches rows. Slim version — doesn't do all the
// fallback logic (cascading agency drop, date-broadening) since tests
// want to see the FIRST attempt's results, not the recovery path.

const FIELDS = [
  'Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
  'Awarding Sub Agency', 'Awarding Office', 'Description',
  'Period of Performance Start Date', 'Period of Performance Current End Date',
  'Place of Performance State Code', 'recipient_id', 'generated_internal_id',
];

const AWARD_TYPES = ['A', 'B', 'C', 'D'];

async function pullUSASpending(attrs) {
  const t0 = performance.now();

  const filters = { award_type_codes: AWARD_TYPES };

  // Resolve short agency names/abbreviations to full names USASpending recognizes
  const AGENCY_FULL_NAMES = {
    'hhs':   'Department of Health and Human Services',
    'dod':   'Department of Defense',
    'dhs':   'Department of Homeland Security',
    'va':    'Department of Veterans Affairs',
    'gsa':   'General Services Administration',
    'nasa':  'National Aeronautics and Space Administration',
    'doj':   'Department of Justice',
    'doe':   'Department of Energy',
    'dot':   'Department of Transportation',
    'dos':   'Department of State',
    'usda':  'Department of Agriculture',
    'doi':   'Department of the Interior',
    'doc':   'Department of Commerce',
    'ssa':   'Social Security Administration',
    'epa':   'Environmental Protection Agency',
    'cisa':  'Cybersecurity and Infrastructure Security Agency',
    'disa':  'Defense Information Systems Agency',
    'darpa': 'Defense Advanced Research Projects Agency',
  };

  // IC agencies that return 0 rows on both tiers in USASpending
  const IC_AGENCIES = new Set([
    'national security agency', 'central intelligence agency',
    'nsa', 'cia', 'ic', 'intelligence community', 'dia',
    'defense intelligence agency', 'nro', 'nga (geospatial)',
  ]);

  if (attrs.agency) {
    const agencyLower = attrs.agency.toLowerCase().trim();
    const resolvedName = AGENCY_FULL_NAMES[agencyLower] || attrs.agency;

    // Check if this is a known IC agency (returns 0 legitimately)
    const isIC = IC_AGENCIES.has(agencyLower);

    // Military branches and known subtiers
    const subtierAgencies = [
      'department of the navy', 'department of the army', 'department of the air force',
      'united states space force', 'u.s. cyber command', 'defense information systems agency',
      'defense advanced research projects agency', 'defense health agency',
      'cybersecurity and infrastructure security agency',
    ];
    const resolvedLower = resolvedName.toLowerCase();
    const tier = subtierAgencies.some(s => resolvedLower.includes(s.split(' ').slice(-2).join(' '))) ? 'subtier' : 'toptier';
    filters.agencies = [{ tier, name: resolvedName, type: 'awarding' }];
    filters._isIC = isIC;  // flag for agencyDropped simulation
  }

  if (attrs.naics) {
    filters.naics_codes = String(attrs.naics).split(',').map(s => s.trim()).filter(Boolean);
  }

  if (attrs.psc) {
    // Match minimo's PSC handling — only D, R, 7, 1
    const allowed = String(attrs.psc).split(',').map(s => s.trim()).filter(p => /^[DR71]/.test(p));
    if (allowed.length) filters.psc_codes = allowed;
  }

  if (attrs.keywords) {
    // Comma-split into separate keyword needles (USASpending OR's them)
    filters.keywords = String(attrs.keywords).split(',').map(s => s.trim()).filter(Boolean);
  }

  if (attrs.recipient) {
    // Resolve shorthand names to full legal names and use recipient_search_text —
    // the same mechanism production uses. Keyword search hits description text,
    // which doesn't contain legal entity names like "SCIENCE APPLICATIONS INTERNATIONAL
    // CORPORATION". recipient_search_text does entity-level matching.
    const lookupKey = String(attrs.recipient).toLowerCase().trim();
    const resolvedName = VENDOR_LEGAL_NAMES[lookupKey] || attrs.recipient;
    filters.recipient_search_text = [resolvedName];
    // aliases go into keywords (reseller description-text matching)
    if (attrs.aliases) {
      filters.keywords = filters.keywords || [];
      String(attrs.aliases).split(',').map(s => s.trim()).filter(Boolean).forEach(a => filters.keywords.push(a));
    }
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (DATE_RE.test(attrs.since || '') || DATE_RE.test(attrs.until || '')) {
    const period = { date_type: 'action_date' };
    if (DATE_RE.test(attrs.since || '')) period.start_date = attrs.since;
    if (DATE_RE.test(attrs.until || '')) period.end_date = attrs.until;
    filters.time_period = [period];
  }

  const payload = {
    filters,
    fields: FIELDS,
    page: 1,
    limit: 100,
    sort: 'Award Amount',
    order: 'desc',
  };

  let rows = [];
  let total = 0;
  let error = null;
  let keywordsDropped = false;

  const doFetch = async (p) => {
    const res = await fetch(USASPENDING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    if (!res.ok) throw new Error(`USASpending HTTP ${res.status}`);
    const body = await res.json();
    return body.results || [];
  };

  let agencyDropped = false;
  const isIC = filters._isIC || false;
  delete filters._isIC;

  try {
    rows = await doFetch(payload);
    total = rows.reduce((s, r) => s + (Number(r['Award Amount']) || 0), 0);

    // If IC agency returns 0, simulate agencyDropped (production does this for NSA/CIA)
    if (rows.length === 0 && isIC) agencyDropped = true;

    // Keyword-drop fallback: if agency + keywords = 0, retry agency-only
    if (rows.length === 0 && filters.keywords?.length && filters.agencies?.length && !filters.recipient_search_text) {
      const filtersNoKw = { ...filters };
      delete filtersNoKw.keywords;
      const retryRows = await doFetch({ ...payload, filters: filtersNoKw });
      if (retryRows.length > 0) {
        rows = retryRows;
        total = rows.reduce((s, r) => s + (Number(r['Award Amount']) || 0), 0);
        keywordsDropped = true;
      }
    }
  } catch (e) {
    error = e.message;
  }

  return { rows, total, error, usaspendingMs: Math.round(performance.now() - t0), payload, keywordsDropped, agencyDropped };
}

// ── Run a single scenario ─────────────────────────────────────────────────
async function runScenario(scenario) {
  const t0 = performance.now();

  const { tagAttrs, proseBefore, proseAfter, rawText, lambdaMs, error: lambdaErr } =
    await callLambda(scenario.question, scenario.history || []);

  let pullResult = { rows: [], total: 0, error: null, usaspendingMs: 0, payload: null };
  if (tagAttrs && Object.keys(tagAttrs).length > 0 && !lambdaErr) {
    pullResult = await pullUSASpending(tagAttrs);
  }

  const snapshot = {
    question: scenario.question,
    tagAttrs,
    proseBefore,
    proseAfter,
    rawText,
    rows: pullResult.rows,
    rowCount: pullResult.rows.length,
    total: pullResult.total,
    payload: pullResult.payload,
    keywordsDropped: pullResult.keywordsDropped || false,
    resolved: { agencyDropped: pullResult.agencyDropped || false },
    error: lambdaErr || pullResult.error,
    timings: {
      lambdaMs,
      usaspendingMs: pullResult.usaspendingMs,
      totalMs: Math.round(performance.now() - t0),
    },
  };

  // Run assertions
  const results = scenario.assertions.map(a => {
    let passed = false;
    let err = null;
    try {
      passed = a.check(snapshot);
    } catch (e) {
      err = e.message;
    }
    return { kind: a.kind, msg: a.msg, passed, err };
  });

  const hardFails = results.filter(r => r.kind === 'hard' && !r.passed).length;
  const softFails = results.filter(r => r.kind === 'soft' && !r.passed).length;

  return {
    name: scenario.name,
    tags: scenario.tags || [],
    snapshot,
    results,
    hardFails,
    softFails,
    status: hardFails > 0 ? 'fail' : softFails > 0 ? 'warn' : 'pass',
  };
}

// ── Reproducibility comparison ────────────────────────────────────────────
// For scenarios with reproduce: true, runs twice and compares.
function compareRuns(run1, run2) {
  const issues = [];

  // Compare tag attrs
  const keys = new Set([
    ...Object.keys(run1.snapshot.tagAttrs || {}),
    ...Object.keys(run2.snapshot.tagAttrs || {}),
  ]);
  for (const k of keys) {
    const v1 = run1.snapshot.tagAttrs?.[k];
    const v2 = run2.snapshot.tagAttrs?.[k];
    if (v1 !== v2) {
      issues.push(`tag.${k} drifted: "${v1}" vs "${v2}"`);
    }
  }

  // Compare row count and total (allow some slop on row count, none on total)
  if (run1.snapshot.rowCount !== run2.snapshot.rowCount) {
    issues.push(`rowCount drifted: ${run1.snapshot.rowCount} vs ${run2.snapshot.rowCount}`);
  }
  // Allow $0.01 slop on totals (USASpending returns floats with rounding noise)
  if (Math.abs(run1.snapshot.total - run2.snapshot.total) > 0.01) {
    const fmt = (n) => `$${(n / 1e6).toFixed(2)}M`;
    issues.push(`total drifted: ${fmt(run1.snapshot.total)} vs ${fmt(run2.snapshot.total)}`);
  }

  return issues;
}

// ── Main runner ───────────────────────────────────────────────────────────
// Yields a result for each scenario as it completes (so the UI can update live).
export async function* runAll(scenarios = SCENARIOS, opts = {}) {
  const { filterTag = null, abortSignal = null } = opts;
  const filtered = filterTag
    ? scenarios.filter(s => (s.tags || []).includes(filterTag))
    : scenarios;

  for (const scenario of filtered) {
    if (abortSignal?.aborted) return;

    if (scenario.reproduce) {
      // Run twice in fresh contexts (no shared history)
      const run1 = await runScenario(scenario);
      if (abortSignal?.aborted) return;
      const run2 = await runScenario(scenario);

      const reproIssues = compareRuns(run1, run2);
      const combined = {
        name: scenario.name + ' (×2)',
        tags: scenario.tags || [],
        snapshot: run1.snapshot,
        snapshot2: run2.snapshot,
        results: [
          ...run1.results.map(r => ({ ...r, msg: '[run1] ' + r.msg })),
          ...run2.results.map(r => ({ ...r, msg: '[run2] ' + r.msg })),
          ...reproIssues.map(issue => ({ kind: 'hard', msg: '[repro] ' + issue, passed: false })),
        ],
        hardFails: run1.hardFails + run2.hardFails + reproIssues.length,
        softFails: run1.softFails + run2.softFails,
      };
      combined.status = combined.hardFails > 0 ? 'fail' : combined.softFails > 0 ? 'warn' : 'pass';
      yield combined;
    } else {
      const result = await runScenario(scenario);
      yield result;
    }
  }
}

// Expose for console-poking
window.testRunner = { runAll, runScenario, callLambda, pullUSASpending, SCENARIOS };
