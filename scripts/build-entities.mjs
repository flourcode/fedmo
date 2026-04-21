// ============================================================================
// build-entities.mjs
// ----------------------------------------------------------------------------
// Pulls the canonical list of federal agencies and subagencies from USASpending
// and writes entities.json — a searchable dictionary v2's resolver uses to
// turn colloquial user input ("crane", "disa", "aflcmc") into the exact names
// USASpending's filter API actually recognizes.
//
// Run me manually from VS Code's terminal:
//
//     node scripts/build-entities.mjs
//
// See scripts/README.md for a step-by-step walkthrough.
// ----------------------------------------------------------------------------
// Why this exists:
//   USASpending's filter API wants names like "Defense Information Systems
//   Agency" — not "DISA", not "disa", not "Def Info Sys Agency". When a user
//   types "DISA", we need to map it. Hand-maintaining that list goes stale.
//   This script grabs the current names direct from USASpending every time
//   you run it, so the dictionary is always current.
//
// What it does:
//   1. Fetches the list of ~160 toptier agencies (DoD, HHS, VA, etc.)
//   2. For each toptier, fetches all its subtiers (DISA, CBP, NIH, etc.)
//   3. Writes entities.json keyed by searchable lowercase strings
//
// Run time: ~30 seconds.
// Output size: ~300 KB (~1500 entities).
// Re-run frequency: once a quarter is plenty. Agency org charts don't shift
// much — this is the opposite of chasing stock prices.
// ============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'entities.json');
const API_BASE = 'https://api.usaspending.gov/api/v2';

// ─── helpers ───────────────────────────────────────────────────────────

// Pretty-print progress so you can see the script working
const log = (msg) => console.log(`[build-entities] ${msg}`);
const warn = (msg) => console.warn(`[build-entities] WARN: ${msg}`);

// Fetch with retries + timeout. Public API sometimes blips briefly.
async function fetchJson(url, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'fedmo-build-entities/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      warn(`${url} failed (attempt ${attempt}/${retries}): ${err.message}. retrying...`);
      // Simple linear backoff
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// Sleep a bit between batched calls so we don't hammer the API
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Normalize a string into a searchable key. We lowercase, strip punctuation
// that varies across sources ("U.S." vs "US"), and collapse whitespace.
function searchKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build several search keys for a single entity so the resolver can find it
// by common variations. For "U.S. Special Operations Command" we index:
//   - "u.s. special operations command" (raw lowercase)
//   - "us special operations command" (dots stripped)
//   - "special operations command" (leading "U.S." removed)
// Plus the abbreviation if present.
function buildSearchKeys(name, abbreviation) {
  const keys = new Set();
  if (name) {
    keys.add(searchKey(name));
    // Variant without leading "U.S." / "United States"
    const stripped = name.replace(/^(U\.?S\.?|United States)\s+/i, '').trim();
    if (stripped && stripped !== name) keys.add(searchKey(stripped));
  }
  if (abbreviation) {
    keys.add(searchKey(abbreviation));
  }
  return [...keys].filter(k => k && k.length >= 2);
}

// ─── main ──────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  log(`fetching toptier agencies from ${API_BASE}/references/toptier_agencies/`);
  const toptierResponse = await fetchJson(`${API_BASE}/references/toptier_agencies/`);
  const toptiers = toptierResponse.results || [];
  log(`got ${toptiers.length} toptier agencies`);

  // Build the output dictionary. Each search key maps to an array because
  // multiple entities can share the same key (e.g., several agencies have
  // an "Office of Inspector General" subtier). The resolver will handle
  // the multi-match case by surfacing a "Did you mean?" prompt.
  const entities = {};

  // Push a single entity into the dictionary under all its search keys
  function pushEntity(entity) {
    for (const key of entity._keys) {
      if (!entities[key]) entities[key] = [];
      // Dedupe: skip if we already have an identical entity under this key.
      // Happens when the same name variant hits the same abbreviation.
      const already = entities[key].some(e =>
        e.tier === entity.tier &&
        e.name === entity.name &&
        e.toptier_name === entity.toptier_name
      );
      if (!already) {
        // Store without the internal _keys field
        const { _keys, ...pub } = entity;
        entities[key].push(pub);
      }
    }
  }

  // 1. Index toptier agencies directly
  for (const t of toptiers) {
    const name = t.agency_name;
    const abbr = t.abbreviation || '';
    if (!name) continue;
    pushEntity({
      tier: 'toptier',
      name,
      abbreviation: abbr,
      toptier_code: t.toptier_code || '',
      toptier_name: name,
      _keys: buildSearchKeys(name, abbr),
    });
  }
  log(`indexed ${toptiers.length} toptier agencies into dictionary`);

  // 2. For each toptier, fetch its subtier agencies
  log(`fetching subtiers for ${toptiers.length} toptiers (this is the slow part)...`);
  let subtierCount = 0;
  let failedToptiers = 0;
  for (let i = 0; i < toptiers.length; i++) {
    const t = toptiers[i];
    const code = t.toptier_code;
    if (!code) continue;

    try {
      const subResp = await fetchJson(
        `${API_BASE}/agency/${code}/sub_agency/?limit=500`
      );
      const subs = subResp.results || [];
      for (const s of subs) {
        const subName = s.name;
        const subAbbr = s.abbreviation || '';
        if (!subName) continue;
        pushEntity({
          tier: 'subtier',
          name: subName,
          abbreviation: subAbbr,
          toptier_code: code,
          toptier_name: t.agency_name,
          _keys: buildSearchKeys(subName, subAbbr),
        });
        subtierCount++;
      }
    } catch (err) {
      warn(`failed to fetch subtiers for ${t.agency_name} (${code}): ${err.message}`);
      failedToptiers++;
    }

    // Progress indicator every 10 toptiers
    if ((i + 1) % 10 === 0 || i + 1 === toptiers.length) {
      log(`  progress: ${i + 1}/${toptiers.length} toptiers processed, ${subtierCount} subtiers so far`);
    }

    // Small courtesy delay between calls — keeps us polite on the public API
    await sleep(50);
  }

  // 3. Build final output
  //
  // Header meta on top of the dictionary tells future-us when this was built
  // and what version of the script produced it. Useful when debugging stale
  // data months later.
  const output = {
    _meta: {
      generated_at: new Date().toISOString(),
      source: `${API_BASE}/references/toptier_agencies/ + /agency/{code}/sub_agency/`,
      toptier_count: toptiers.length,
      subtier_count: subtierCount,
      unique_search_keys: Object.keys(entities).length,
      failed_toptiers: failedToptiers,
      script_version: '1.0',
    },
    entities,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`✓ wrote ${OUTPUT_PATH}`);
  log(`  ${toptiers.length} toptiers + ${subtierCount} subtiers`);
  log(`  ${Object.keys(entities).length} unique search keys`);
  log(`  ${failedToptiers} toptier(s) failed (usually transient)`);
  log(`  took ${elapsedS}s`);

  // Spot-check: did we catch a few known tricky cases?
  const spotChecks = ['disa', 'crane', 'aflcmc', 'cbp', 'nih', 'socom', 'va'];
  log(``);
  log(`spot-check (these should all return at least one match):`);
  for (const term of spotChecks) {
    const hits = entities[term] || [];
    if (hits.length === 0) {
      warn(`  "${term}" → no matches (may need a manual alias later)`);
    } else {
      log(`  "${term}" → ${hits.length} match(es): ${hits[0].name}${hits.length > 1 ? ' + others' : ''}`);
    }
  }
}

main().catch(err => {
  console.error('[build-entities] FATAL:', err);
  process.exit(1);
});
