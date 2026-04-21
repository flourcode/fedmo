// ============================================================================
// mo-stream-client.v2.js — Browser-side streaming + <data> tag handling
// ============================================================================
//
// This module implements the two-shot streaming pattern for Mo v2:
//
//   1. First pass: user's question goes to /mo_stream. Mo writes prose,
//      optionally emitting a <data ... /> tag. Browser parses the tag
//      mid-stream, aborts Mo, resolves natural names via resolver.js,
//      fires USASpending, renders a card.
//
//   2. Second pass: browser calls /mo_stream again with the original
//      history + a payload_summary system injection. Mo's second stream
//      is her interpretation, grounded in the real data.
//
// If Mo's first pass finishes without a <data> tag, this is a coaching
// or conversational response — no second pass, no data card. Just prose.
//
// Design: the module exposes ONE function — askMo() — that takes a user
// question, a history array, and a set of DOM/render callbacks, and
// orchestrates the whole turn. Integration into mo_mock is just: call
// this function and wire the callbacks.
//
// Usage:
//   import { askMo } from './mo-stream-client.v2.js';
//
//   await askMo({
//     question: "who's winning at SOCOM",
//     history: [...],
//     activeCardSummary: App.state.activeCardSummary || null,
//     endpoint: AI_ENDPOINT,
//     render: {
//       streamPose: (partialHtml) => {...},           // render/update prose
//       showDataCardLoading: () => dataSlotEl,        // return slot for card
//       renderDataCard: (slot, rows, filter) => {...},// render the card
//       renderError: (msg) => {...},
//     },
//   });
//
// The render callbacks are the integration points. Everything else is
// internal state-machine plumbing.
// ============================================================================

import { resolve, applyPostFilters } from './resolver.js';

// ─────────────────────────────────────────────────────────────────────
// vendor_categories.json — category-aware fallback dictionary
// ─────────────────────────────────────────────────────────────────────
//
// When a user pitches a vendor at an agency and the direct pull comes
// back empty, the browser checks this file to decide how to fall back.
//
//   - Vendor IS in the file (e.g., "sentinelone" → endpoint_security)
//     → refire at the SAME agency using the category's keyword set,
//       so the seller sees their actual competitive market (CrowdStrike,
//       Defender, Trellix) rather than unrelated agency top-100 data
//       (border walls, ship construction).
//
//   - Vendor is NOT in the file → DON'T refire automatically. Return
//     'needs_qualifier' mode so Mo can ask the user what the product
//     does. A MyPillow or niche-vendor pitch deserves a conversation,
//     not a blind agency-wide fallback.
//
// The file shape is { categories: {...}, vendors: {...} } where vendors
// reference categories by key. This module denormalizes on lookup so
// downstream callers get a flat {categoryName, keywords, competitors}
// shape regardless of how the file is structured.
//
// Best-effort load — if the file is missing or malformed, we skip the
// category branch entirely and fall through to the "needs qualifier"
// path. That's a clean degradation: the tool asks more questions
// instead of showing wrong data.
// ─────────────────────────────────────────────────────────────────────

let _categoriesMap = {};    // category_key → { display_name, keywords }
let _vendorsMap = {};       // vendor_key → { canonical, category, competitors }
let _vendorCategoriesLoaded = false;

export const vendorCategoriesReady = (async () => {
  try {
    const url = new URL('./vendor_categories.json', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[stream-client] vendor_categories.json fetch failed: HTTP ${res.status}. Category-aware fallback disabled.`);
      _vendorCategoriesLoaded = true;
      return;
    }
    const data = await res.json();
    if (data && typeof data.vendors === 'object' && typeof data.categories === 'object') {
      _categoriesMap = data.categories;
      _vendorsMap = data.vendors;
      _vendorCategoriesLoaded = true;
    } else {
      console.warn('[stream-client] vendor_categories.json has unexpected shape (expected { categories, vendors }). Category-aware fallback disabled.');
      _vendorCategoriesLoaded = true;
    }
  } catch (err) {
    console.warn('[stream-client] vendor_categories.json load error:', err.message);
    _vendorCategoriesLoaded = true;
  }
})();

// Normalize a vendor name for category lookup. Same rules as the file
// keys — lowercase, trimmed, punctuation stripped, legal suffixes removed.
// Not the same as the resolver's norm() because we want "AWS, Inc." and
// "Amazon Web Services" to resolve to their category.
function normalizeVendorForCategory(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|incorporated|llc|corp|corporation|co|ltd|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolve a vendor name → {category, keywords, competitors} or null.
// Denormalizes across the categories and vendors maps so callers get a
// single flat object. Returns null for unknown vendors OR if the vendor's
// category key is missing from the categories map (shouldn't happen in
// practice because the JSON has referential integrity, but we guard
// against it so a bad file doesn't crash).
function lookupVendorCategory(vendorName) {
  if (!_vendorCategoriesLoaded) return null;
  const key = normalizeVendorForCategory(vendorName);
  const vendor = _vendorsMap[key];
  if (!vendor) return null;
  const category = _categoriesMap[vendor.category];
  if (!category) {
    console.warn(`[stream-client] vendor "${key}" references missing category "${vendor.category}"`);
    return null;
  }
  return {
    vendorCanonical: vendor.canonical,
    category: category.display_name || vendor.category,
    categoryKey: vendor.category,
    keywords: category.keywords || [],
    competitors: vendor.competitors || [],
  };
}

// ─────────────────────────────────────────────────────────────────────
// <data> tag parser
// ─────────────────────────────────────────────────────────────────────

// Matches: <data key="value" key="value" />  or  <data ... ></data>
// Captures the attribute text so we can parse individual key=value pairs.
const DATA_TAG_RE = /<data\s+([^>]+?)\/>|<data\s+([^>]*?)><\/data>/i;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

// Returns { match, attrs, index, length } if a complete <data> tag is
// found in the accumulated text. Returns null if no tag or tag is still
// being streamed (we see `<data` but not `/>` yet).
export function findDataTag(text) {
  const m = DATA_TAG_RE.exec(text);
  if (!m) {
    // Check for a partial tag — <data with no closer yet. If present,
    // caller should pause rendering until more chunks arrive.
    const partialIdx = text.lastIndexOf('<data');
    if (partialIdx >= 0) {
      const tail = text.slice(partialIdx);
      if (!/\/>/.test(tail) && !/<\/data>/i.test(tail)) {
        return { pending: true, partialIndex: partialIdx };
      }
    }
    return null;
  }

  const attrText = m[1] || m[2] || '';
  const attrs = {};
  for (const [, k, v] of attrText.matchAll(ATTR_RE)) attrs[k] = v;

  return {
    match: m[0],
    attrs,
    index: m.index,
    length: m[0].length,
  };
}

// Convert <data> tag attributes into resolver input shape.
// Handles type coercion: "true" → true, "5000000" → 5_000_000, etc.
export function dataAttrsToResolverInput(attrs) {
  const input = {};
  if (attrs.vendor) input.vendor = attrs.vendor;
  if (attrs.vendors) input.vendors = attrs.vendors; // resolver splits comma-sep strings
  if (attrs.agency) input.agency = attrs.agency;
  if (attrs.topic) input.topic = attrs.topic;
  if (attrs.naics) input.naics = attrs.naics;
  if (attrs.psc) input.psc = attrs.psc;
  if (attrs.expiring_only === 'true') input.expiring_only = true;
  if (attrs.min_amount) {
    const n = Number(attrs.min_amount);
    if (!isNaN(n)) input.min_amount = n;
  }
  if (attrs.max_amount) {
    const n = Number(attrs.max_amount);
    if (!isNaN(n)) input.max_amount = n;
  }
  // Competitor mode: if Mo emits competitors="true", the browser will call
  // mo_competitors first to get a vendor's head-to-head competitors, then
  // expand input.vendors to include the original vendor + its competitors
  // before fetching USASpending. The resulting card shows the competitive
  // landscape in one view.
  if (attrs.competitors === 'true') input._competitors = true;
  // Subaward mode: when Mo emits subawards="true", the browser fetches from
  // USASpending's subaward endpoint instead of prime. The card is a different
  // shape (prime → sub relationships, not primes alone) so we route this
  // through a different fetch + render path in askMo.
  if (attrs.subawards === 'true') input._subawards = true;
  return input;
}

// Fetch head-to-head federal competitors for a vendor via the Lambda
// endpoint. Returns { vendor, category, competitors: [...] } or throws.
// Called by askMo() when a <data> tag has competitors="true".
// ─────────────────────────────────────────────────────────────────────
// fetchCompetitors — figure out who competes head-to-head with the seller
// ─────────────────────────────────────────────────────────────────────
//
// Two-tier lookup:
//
//  1. FILE FIRST. If the vendor is in vendor_categories.json, return the
//     curated competitor list directly. No network call. No failure mode.
//     Deterministic — same vendor always returns same list. This is how
//     we handle AWS, Microsoft, SentinelOne, Datadog, Akamai, Sonatype,
//     etc. — all the vendors we've hand-curated for known federal
//     categories.
//
//  2. GEMINI FALLBACK. For unknown vendors (niche products, new entrants,
//     anything not in the file), call the Lambda's mo_competitors
//     endpoint, which asks Gemini for a competitor list. This path has
//     failure modes (Gemini 500, malformed JSON, timeout) and the caller
//     must handle them — see askMo()'s try/catch around fetchCompetitors.
//
// Why file-first matters: Gemini's competitor lookup can silently fail
// (API error, timeout, malformed response), and when it does, Mo
// fills the gap with invented competitor names from training data. For
// known vendors we shouldn't tolerate that risk. File-first eliminates
// the failure surface for ~70-80% of competitor queries.
// ─────────────────────────────────────────────────────────────────────
export async function fetchCompetitors(vendorName, endpoint) {
  // Tier 1: hand-curated file lookup
  const catInfo = lookupVendorCategory(vendorName);
  if (catInfo && Array.isArray(catInfo.competitors) && catInfo.competitors.length > 0) {
    return {
      vendor: catInfo.vendorCanonical || vendorName,
      category: catInfo.category || '',
      competitors: catInfo.competitors,
      _source: 'file',
    };
  }

  // Tier 2: Gemini fallback for unknown vendors
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_type: 'mo_competitors',
      vendor: vendorName,
    }),
  });
  if (!res.ok) throw new Error(`competitors API ${res.status}`);
  const body = await res.json();
  if (!body?.competitors || !Array.isArray(body.competitors)) {
    throw new Error('competitors response bad shape');
  }
  body._source = 'gemini';
  return body;
}

// ─────────────────────────────────────────────────────────────────────
// USASpending fetch via the proxy. Builds the full filter object
// (time_period + award_type_codes + whatever the resolver returned),
// calls the proxy, applies post-filters, returns cleaned rows.
// ─────────────────────────────────────────────────────────────────────

const CONTRACT_TYPES = ['A', 'B', 'C', 'D'];
const AWARD_FIELDS = [
  'Award ID', 'Recipient Name', 'Awarding Agency', 'Awarding Sub Agency',
  'Awarding Office', 'Award Amount', 'Description', 'generated_internal_id',
  'Start Date', 'End Date', 'NAICS', 'PSC',
  'Contract Award Type', 'Type of Set Aside',
];
// Subawards endpoint returns different fields — prime+sub relationships,
// not prime contracts alone. Same URL, different shape.
const SUBAWARD_FIELDS = [
  'Sub-Award ID', 'Sub-Awardee Name', 'Sub-Award Amount', 'Sub-Award Date',
  'Prime Award ID', 'Prime Recipient Name',
  'Awarding Agency', 'Awarding Sub Agency',
  'prime_award_generated_internal_id', 'Description', 'NAICS',
];

function trailing12Mo() {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return [{ start_date: fmt(start), end_date: fmt(end) }];
}

export async function fetchUsaspending(resolverInput, endpoint) {
  const { filters: resolvedFilters, postFilters } = resolve(resolverInput);
  const filters = {
    time_period: trailing12Mo(),
    award_type_codes: CONTRACT_TYPES,
    ...resolvedFilters,
  };

  const payload = { filters, fields: AWARD_FIELDS, limit: 100, sort: 'Award Amount', order: 'desc' };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_type: 'usaspending_proxy',
      endpoint: '/search/spending_by_award/',
      payload,
    }),
  });

  if (!res.ok) {
    // 4xx responses from USASpending usually mean the filter shape is
    // invalid — e.g. a keyword that's too short, a mismatched agency
    // name, or a combination the API rejects. 5xx means USASpending
    // itself is having trouble. The error surface downstream renders
    // this message; keep it short and user-readable, not developer-y.
    if (res.status >= 400 && res.status < 500) {
      throw new Error("The search terms didn't match USASpending's filter rules. Try rephrasing — be more specific about the vendor, agency, or product.");
    }
    throw new Error('USASpending is having trouble right now. Give it a minute and try again.');
  }
  const body = await res.json();
  const raw = Array.isArray(body.results) ? body.results : [];

  // Data grooming. Two things happen here that the render path downstream
  // assumes have already run:
  //
  // 1. _endTs for expiring-window filters
  // 2. For DoD contracts, swap in the sub-agency name as the Awarding Agency
  //    so the treemap breaks into Navy/Army/Air Force instead of showing one
  //    undifferentiated "Department of Defense" block. Ported from v1.
  for (const r of raw) {
    r._endTs = r['End Date'] ? new Date(r['End Date']).getTime() : 0;
    const topAgency = String(r['Awarding Agency'] || '').toUpperCase();
    if (topAgency.includes('DEFENSE') && r['Awarding Sub Agency']) {
      r['Awarding Agency'] = r['Awarding Sub Agency'];
    }
  }

  // Apply post-filters (vendor scope, agency scope, amount bounds, expiring)
  return applyPostFilters(raw, postFilters);
}

// ─────────────────────────────────────────────────────────────────────
// fetchSubawards — pull prime→sub relationships from USASpending
// ─────────────────────────────────────────────────────────────────────
//
// Same URL as fetchUsaspending (/search/spending_by_award/), but the payload
// has `subawards: true` at the top level which flips USASpending into
// subaward mode — it returns sub-tier records with Prime Recipient Name +
// Sub-Awardee Name instead of prime contracts.
//
// Returns an array of { prime, sub, amount, agency, desc, date, link } objects
// ready for the subaward card renderer. No post-filtering is applied here
// (subaward data is already narrow) — the filter just scopes the result set.
// ─────────────────────────────────────────────────────────────────────
export async function fetchSubawards(resolverInput, endpoint) {
  const { filters: resolvedFilters } = resolve(resolverInput);
  const filters = {
    time_period: trailing12Mo(),
    award_type_codes: CONTRACT_TYPES,
    ...resolvedFilters,
  };

  const payload = {
    subawards: true,
    filters,
    fields: SUBAWARD_FIELDS,
    limit: 100,
    sort: 'Sub-Award Amount',
    order: 'desc',
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_type: 'usaspending_proxy',
      endpoint: '/search/spending_by_award/',
      payload,
    }),
  });

  if (!res.ok) throw new Error(`subawards API ${res.status}`);
  const body = await res.json();
  const raw = Array.isArray(body.results) ? body.results : [];

  // Shape for the subaward card renderer. Pulled from govhoo's structure
  // so the existing buildSubawardTurn can consume these without changes.
  let rows = raw.map(s => ({
    prime: s['Prime Recipient Name'] || 'Unknown Prime',
    sub: s['Sub-Awardee Name'] || 'Unknown Sub',
    amount: parseFloat(s['Sub-Award Amount']) || 0,
    agency: s['Awarding Sub Agency'] || s['Awarding Agency'] || '',
    desc: s['Description'] || '',
    date: s['Sub-Award Date'] || '',
    primeAwardId: s['prime_award_generated_internal_id'] || '',
    subAwardId: s['Sub-Award ID'] || '',
    naics: s['NAICS'] || '',
    _raw: s,
  }));

  // ── Subaward direction post-filter ───────────────────────────────
  //
  // USASpending's subaward keyword-match scans BOTH the Prime Recipient
  // Name field AND the Sub-Awardee Name field. When a seller asks
  // "who's subbing to SAIC", they want rows where SAIC is the PRIME
  // (so they can see SAIC's subs — the firms the seller could displace
  // or join). But the API returns both directions mixed, and for a big
  // firm like SAIC the "SAIC-as-sub" rows (TekSynap → SAIC, Corner
  // Alliance → SAIC) often dominate, because SAIC is big enough to show
  // up as a sub to many other primes.
  //
  // Fix: if the query had a vendor keyword, post-filter to rows where
  // the vendor matches Prime Recipient Name. This gives the seller what
  // they actually wanted — the subs UNDER their target prime.
  //
  // Zero-row fallback: if filtering by prime produces no rows, the
  // vendor genuinely shows up only as a sub in this slice. Return the
  // unfiltered rows so the user sees SOMETHING real rather than an
  // empty card. Log the direction so Mo's payload summary can frame
  // the data honestly ("here's where SAIC shows up as a sub").
  const vendorInput = resolverInput?.vendor
    || (Array.isArray(resolverInput?.vendors) ? resolverInput.vendors[0] : null);
  if (vendorInput && rows.length > 0) {
    const needle = String(vendorInput).toUpperCase();
    const asPrimeRows = rows.filter(r => (r.prime || '').toUpperCase().includes(needle));
    if (asPrimeRows.length > 0) {
      rows = asPrimeRows;
      rows._subawardDirection = 'as_prime';
    } else {
      // Fallback: vendor only shows up as a sub in this dataset
      rows._subawardDirection = 'as_sub';
    }
  }

  return rows;
}

// Compact payload summary for Mo's grounded second-pass call when she
// pulled subawards. Tells her who's moving sub work, top primes by
// sub spend, top subs by take.
export function summarizeSubawardsForMo(subs, resolverInput) {
  if (!subs || subs.length === 0) {
    return `No subaward records returned. Tell the user subaward data is sparse for this slice and suggest they look at the prime-level recompete signals instead.`;
  }
  const total = subs.reduce((s, r) => s + (r.amount || 0), 0);

  // Top primes (who's handing out the sub work)
  const primeMap = new Map();
  for (const s of subs) {
    primeMap.set(s.prime, (primeMap.get(s.prime) || 0) + s.amount);
  }
  const topPrimes = [...primeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, a]) => `${n} ($${(a / 1_000_000).toFixed(1)}M in sub work given out)`);

  // Top subs (who's taking it)
  const subMap = new Map();
  for (const s of subs) {
    subMap.set(s.sub, (subMap.get(s.sub) || 0) + s.amount);
  }
  const topSubs = [...subMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, a]) => `${n} ($${(a / 1_000_000).toFixed(1)}M in sub work received)`);

  // Subs working with multiple primes = the leverage players
  const subPrimes = new Map();
  for (const s of subs) {
    if (!subPrimes.has(s.sub)) subPrimes.set(s.sub, new Set());
    subPrimes.get(s.sub).add(s.prime);
  }
  const multiPrimeSubs = [...subPrimes.entries()]
    .filter(([, primes]) => primes.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5)
    .map(([sub, primes]) => `${sub} (works with ${primes.size} primes)`);

  const queryDesc = Object.entries(resolverInput)
    .filter(([k, v]) => v != null && v !== '' && !k.startsWith('_'))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
    .join(', ');

  // Direction framing: the post-filter in fetchSubawards stamps
  // _subawardDirection on the rows array when there's a vendor input.
  // 'as_prime' (default) means the vendor IS the prime and these are
  // their subs — what the seller almost always wants. 'as_sub' means
  // the vendor-as-prime filter came back empty and we fell back to the
  // unfiltered set — the vendor only appears here as a sub to other
  // primes. Mo needs to know which slice this is so her coaching
  // targets the right audience.
  const direction = subs._subawardDirection;
  const vendorName = resolverInput?.vendor
    || (Array.isArray(resolverInput?.vendors) ? resolverInput.vendors[0] : null);

  let directionBlock = '';
  if (direction === 'as_prime' && vendorName) {
    directionBlock = `
DIRECTION: ${vendorName} is the prime. These subawards show who ${vendorName} is awarding sub-work TO. The seller wants to know these subs so they can (a) displace a weak incumbent sub, or (b) partner with an established sub who's already in ${vendorName}'s delivery chain. Coach them accordingly.`;
  } else if (direction === 'as_sub' && vendorName) {
    directionBlock = `
DIRECTION: ${vendorName} does NOT appear as a prime on any subawards in this slice. These rows show ${vendorName} appearing as a SUB to other primes. Tell the seller honestly that ${vendorName} isn't running sub teams in this agency — they're the hands on someone else's contract. The coaching shifts: if the seller wants to team with or displace ${vendorName}'s position, they need to target ${vendorName}'s prime customers (the top primes listed below) instead.`;
  }

  return `Query: ${queryDesc || '(no filters)'} (SUBAWARD CUT)${directionBlock}
Total sub work (top ${subs.length} subs, last 12mo): $${(total / 1_000_000).toFixed(1)}M
Unique primes giving out sub work: ${primeMap.size}
Unique subs receiving work: ${subMap.size}

Top primes by sub work disbursed:
${topPrimes.map(p => '  - ' + p).join('\n')}

Top subs by work received:
${topSubs.map(s => '  - ' + s).join('\n')}

Subs with leverage (working for multiple primes):
${multiPrimeSubs.length > 0 ? multiPrimeSubs.map(s => '  - ' + s).join('\n') : '  (none — subs here are locked to single primes)'}

Your job: tell the seller who's REALLY doing the work behind the primes. Call out leverage plays (subs working multiple primes are free agents worth pursuing). If a sub is taking a huge share, that's who actually delivers the capability. The prime is the contract vehicle; the sub is the hands.`;
}

// ─────────────────────────────────────────────────────────────────────
// Build a payload summary for Mo's second (grounded) call
// ─────────────────────────────────────────────────────────────────────
//
// We don't pass the raw 100 rows back to Gemini — that's too verbose and
// wasteful. Instead, compact to the signals Mo needs for interpretation:
// total dollars, top 5 primes, agency breakdown, expiring count.
// ─────────────────────────────────────────────────────────────────────

export function summarizePayloadForMo(rows, resolverInput, opts = {}) {
  if (!rows || rows.length === 0) {
    return `No contracts matched the query. Tell the user the data came back empty and suggest a different angle.`;
  }

  const total = rows.reduce((s, r) => s + (parseFloat(r['Award Amount']) || 0), 0);

  // Top primes by spend
  const primeMap = new Map();
  for (const r of rows) {
    const name = r['Recipient Name'] || 'Unknown';
    const amt = parseFloat(r['Award Amount']) || 0;
    primeMap.set(name, (primeMap.get(name) || 0) + amt);
  }
  const topPrimes = [...primeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, a]) => `${n} ($${(a / 1_000_000).toFixed(1)}M)`);

  // ── Channel-partner vs competitor classification ─────────────────
  //
  // When a seller pitches (e.g., AWS at VA), the top primes in the
  // card include THREE kinds of vendors:
  //   1. Direct    — the seller themselves (Amazon Web Services, Inc.)
  //   2. Channel   — VARs reselling the seller (Four Points reselling
  //                  AWS, Thundercat reselling CrowdStrike Falcon).
  //                  Detectable: contract description names the seller's
  //                  product.
  //   3. Competitor — a different vendor in the same category (Microsoft
  //                  selling Azure in an AWS competitor pull).
  //
  // Mo's coaching is radically different across these three. Attacking
  // a channel partner who's reselling your product is shooting yourself
  // in the foot — you want to DEFEND and STRENGTHEN that relationship.
  // Competitors are the ones you attack. Without this distinction, Mo
  // lumps Four Points in with Microsoft and the seller walks away with
  // confused advice.
  //
  // Classification only runs when there's a seller in context. Returns
  // a map { primeName: 'direct' | 'channel' | 'competitor' } passed to
  // Mo's payload summary so her prose can use it.
  const seller = resolverInput?._sellerName
    || resolverInput?.vendor
    || (Array.isArray(resolverInput?.vendors) ? resolverInput.vendors[0] : null);

  const vendorRelations = new Map();
  if (seller) {
    // Build the set of name-forms USASpending might use for this seller.
    // Contract descriptions are inconsistent: they'll say "AWS" in one
    // field, "AMAZON WEB SERVICES" in another, "Amazon Web Services,
    // Inc." in a third. If we only match on the user's input ("aws"),
    // we miss the legal-name references and wrongly classify Four Points
    // (reselling AWS, description says "AMAZON WEB SERVICES") as a
    // competitor. Look up the category record to get the canonical form
    // and include both.
    const sellerForms = new Set();
    const sellerRaw = String(seller).toUpperCase().trim();
    if (sellerRaw.length >= 3) sellerForms.add(sellerRaw);
    const cat = lookupVendorCategory(seller);
    if (cat && cat.vendorCanonical) {
      const canon = String(cat.vendorCanonical).toUpperCase().trim();
      if (canon.length >= 3) sellerForms.add(canon);
    }
    // If neither form produced a usable match key, skip classification
    // entirely — better to leave primes untagged than to tag them wrong.
    if (sellerForms.size === 0) {
      // No classification possible. topPrimesAnnotated below will render
      // plain "Name ($M)" entries without relation tags.
    } else {
      // Build per-prime description corpus — concatenate every description
      // that prime shows up on. If ANY of their contracts name ANY form
      // of the seller, they're a channel partner. Empty description →
      // assume competitor (safer default — better to attack a "competitor"
      // who is actually a partner than to defend a "partner" who is
      // actually a competitor, because the seller at least won't damage
      // their own distribution).
      const primeDescs = new Map();
      for (const r of rows) {
        const name = r['Recipient Name'] || 'Unknown';
        const desc = [
          r['Description'] || '',
          r['Award Description'] || '',
          r['transaction_description'] || '',
        ].join(' ').toUpperCase();
        if (!primeDescs.has(name)) primeDescs.set(name, '');
        primeDescs.set(name, primeDescs.get(name) + ' ' + desc);
      }
      // Matcher: true if any of the seller name-forms appears in haystack.
      const sellerHit = (haystack) => {
        for (const form of sellerForms) {
          if (haystack.includes(form)) return true;
        }
        return false;
      };
      for (const [name, corpus] of primeDescs.entries()) {
        const nameUpper = name.toUpperCase();
        if (sellerHit(nameUpper)) {
          // Recipient name is the seller (or one of their forms —
          // "Amazon Web Services, INC." contains "AMAZON WEB SERVICES").
          vendorRelations.set(name, 'direct');
        } else if (sellerHit(corpus)) {
          // Recipient is some other firm, but their contracts reference
          // the seller's product in the description. Channel partner
          // reselling for the seller.
          vendorRelations.set(name, 'channel');
        } else {
          // Neither name nor description names the seller. This is a
          // different vendor in the same cut — competitor in a
          // competitor-mode pull, or an unrelated prime in an agency-
          // wide pull.
          vendorRelations.set(name, 'competitor');
        }
      }
    }
  }

  // Build the relation-annotated prime list for Mo's summary. Same top
  // 5 by spend as topPrimes, but each one tagged so Mo knows how to
  // coach against it.
  const topPrimesAnnotated = [...primeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, a]) => {
      const rel = vendorRelations.get(n);
      const tag = rel === 'direct' ? ' [THE SELLER]'
        : rel === 'channel' ? ' [CHANNEL PARTNER reselling ' + seller + ']'
        : rel === 'competitor' ? ' [COMPETITOR]'
        : '';
      return `${n} ($${(a / 1_000_000).toFixed(1)}M)${tag}`;
    });

  // Agency breakdown
  const agencyMap = new Map();
  for (const r of rows) {
    const a = r['Awarding Sub Agency'] || r['Awarding Agency'] || 'Unknown';
    const amt = parseFloat(r['Award Amount']) || 0;
    agencyMap.set(a, (agencyMap.get(a) || 0) + amt);
  }
  const topAgencies = [...agencyMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n, a]) => `${n} ($${(a / 1_000_000).toFixed(1)}M)`);

  // Expiring count (next 90 days)
  const now = Date.now(), in90 = now + 90 * 86400_000;
  const expiring = rows.filter(r => r._endTs > now && r._endTs <= in90);
  const expiringVal = expiring.reduce((s, r) => s + (parseFloat(r['Award Amount']) || 0), 0);

  // Top 3 concentration
  const top3Sum = [...primeMap.values()].sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
  const top3Pct = total > 0 ? Math.round((top3Sum / total) * 100) : 0;

  // Build a user-visible query description from the resolver input, but
  // skip internal plumbing fields (anything starting with underscore) so
  // they don't leak into Mo's system context as weird key=value noise.
  const queryDesc = Object.entries(resolverInput)
    .filter(([k, v]) => v != null && v !== '' && !k.startsWith('_'))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
    .join(', ');

  // Competitor-mode framing: if the caller flagged this as a competitor
  // cut, tell Mo explicitly. Otherwise Mo's second-pass prose will read
  // the card as a generic multi-vendor pull and miss the "you vs. them"
  // framing that's the whole point.
  let framing = '';
  if (resolverInput?._competitors && resolverInput?._competitorList) {
    // Use _sellerName stashed during competitor expansion. Falls back to
    // the first entry in vendors[] if somehow that wasn't set.
    const sellerLabel = resolverInput._sellerName
      || (Array.isArray(resolverInput.vendors) ? resolverInput.vendors[0] : '')
      || '';
    const category = resolverInput._competitorCategory || '';
    framing = `
THIS IS A COMPETITOR CUT.
Seller: ${sellerLabel}
Category: ${category}
Competitors in this pull: ${resolverInput._competitorList.join(', ')}
Your job: tell the seller who's winning and losing in THEIR category. Identify which vendors in the top primes are the seller (${sellerLabel}) vs. their competitors. Call out share, positioning, and where each player is strongest. If the seller isn't in the top primes, say so honestly and describe the competitive landscape they're trying to break into.`;
  } else if (resolverInput?._competitors && resolverInput?._competitorFetchFailed) {
    // Degraded path: the user asked for competitors, but the lookup
    // service errored out, so we're rendering the seller's own footprint
    // instead of a real competitor view. Tell Mo the truth — don't let
    // her hallucinate competitor names from training data when the data
    // in the card is just the seller's own contracts.
    const sellerLabel = resolverInput._sellerName || '';
    framing = `
COMPETITOR LOOKUP FAILED.
The user asked about ${sellerLabel}'s competitors, but the competitor expansion service returned an error. The rows below are ${sellerLabel}'s OWN footprint, not a real competitor view.
Your job: tell the user honestly that you couldn't pull the competitive landscape this turn, show them ${sellerLabel}'s current position based on the rows below, and suggest they try again in a moment. DO NOT name specific competitors from memory — the data doesn't support those claims. It's fine to say "CrowdStrike and Microsoft Defender are typical competitors in this category" as general category knowledge, but do NOT claim anything about their specific federal footprint that isn't visible in the rows.`;
  }

  // Reframed-on-empty framing: the user pitched a vendor+agency combo, but
  // the direct pull came back empty, so the browser refired the query
  // without the vendor filter. The card now shows the agency-wide market,
  // not the seller's literal footprint. Mo MUST explain this — leading
  // with honesty ("your product isn't here directly") before walking the
  // market picture. Otherwise she'll read the card as proof of a presence
  // the seller doesn't actually have, which is a trust disaster.
  if (opts.reframed && resolverInput?._reframedFromVendor) {
    const pitched = resolverInput._reframedFromVendor;
    const category = resolverInput?._categoryName || null;
    if (category) {
      framing += `
THIS IS A CATEGORY-REFRAMED PULL.
The user pitched "${pitched}" at this agency, but ${pitched} has no direct top-100 footprint here.
Rather than dead-end, the browser refired the query using keywords for ${pitched}'s CATEGORY (${category}). The rows below show the actual competitive landscape for ${category} at this agency — where the seller's real opportunity is.
Your job:
 1. Lead with honesty: "${pitched} doesn't show up directly at [agency]" — first sentence.
 2. Pivot to the category view: "but here's the ${category} market at [agency]" — the rows below ARE the seller's competitive landscape.
 3. Identify where ${pitched} fits: which competitors hold the work, where the gaps are, which expiring contracts are targets.
 4. End with a Monday-morning action grounded in specific rows.
Do NOT pretend the rows represent ${pitched}'s presence. They represent the CATEGORY competition — that's what a seller wants to see.`;
    } else {
      framing += `
THIS IS A REFRAMED PULL.
The user pitched "${pitched}" at this agency, but ${pitched} has no direct footprint in the top 100 contracts here.
Rather than dead-end the user, the browser pulled the broader agency market so you can tell them what IS here.
Your job:
 1. Lead with honesty: "${pitched} doesn't show up directly at [agency]" — acknowledge the absence in the first sentence.
 2. Then pivot: "but here's the market you'd be entering" — describe the agency's actual spending patterns based on the top primes and sub-agencies below.
 3. Identify the adjacency: where does ${pitched}'s category fit? Who's holding that work? Is it a greenfield for the seller, or is there an incumbent to displace?
 4. End with a concrete Monday-morning action tied to what's actually in the data.
Do NOT pretend the rows below represent ${pitched}'s presence. They don't. They represent the market context around ${pitched}'s absence.`;
    }
  }

  return `Query: ${queryDesc || '(no filters)'}${framing}
Total (top ${rows.length} contracts, last 12mo): $${(total / 1_000_000).toFixed(1)}M
Unique primes in slice: ${primeMap.size}
Top 3 concentration: ${top3Pct}%
Top primes:
${topPrimesAnnotated.map(p => '  - ' + p).join('\n')}
Top awarding agencies:
${topAgencies.map(a => '  - ' + a).join('\n')}
Expiring within 90 days: ${expiring.length} contracts, $${(expiringVal / 1_000_000).toFixed(1)}M`;
}

// ─────────────────────────────────────────────────────────────────────
// streamOnce — one call to /mo_stream with abort support
// ─────────────────────────────────────────────────────────────────────
//
// Returns the full accumulated text when the stream ends. Calls
// onChunk(accumulatedText) on every incoming chunk so the caller can
// incrementally render.
// ─────────────────────────────────────────────────────────────────────

export async function streamOnce({ endpoint, history, activeCardSummary, payloadSummary, abortController, onChunk }) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_type: 'mo_stream',
      history,
      active_card_summary: activeCardSummary || null,
      payload_summary: payloadSummary || null,
    }),
    signal: abortController?.signal,
  });

  if (!res.ok) throw new Error(`stream ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      try {
        const msg = JSON.parse(raw);
        if (msg.t === 'chunk' && msg.text) {
          accumulated += msg.text;
          onChunk(accumulated);
        } else if (msg.t === 'done') {
          return accumulated;
        } else if (msg.t === 'error') {
          throw new Error(msg.msg || 'Mo encountered an error.');
        }
      } catch (e) {
        if (e.message?.startsWith('Mo ')) throw e;
        // otherwise skip malformed SSE line
      }
    }
  }

  return accumulated;
}

// ─────────────────────────────────────────────────────────────────────
// askMo — top-level orchestrator for one user turn
// ─────────────────────────────────────────────────────────────────────
//
// Handles both paths:
//   - Coaching/chat: Mo writes prose, no <data> tag, single stream
//   - Data-backed: Mo emits <data>, browser pauses, fetches, renders card,
//     fires second grounded stream
//
// render callbacks:
//   streamPreTagProse(text)  — called with progressively-accumulating text
//                              BEFORE a <data> tag is detected. Caller
//                              renders markdown inline.
//   onDataTag(resolverInput) — called when a <data> tag is detected but
//                              before the fetch fires. Caller should show
//                              a loading card. Return a reference that
//                              renderDataCard() will use.
//   renderDataCard(cardRef, rows, input)  — called with the fetched rows.
//                                            Caller renders the actual card.
//   streamPostTagProse(text) — called with Mo's grounded second pass prose.
//   renderError(msg)         — called on any failure.
//   complete()               — called when the whole turn is done.
// ─────────────────────────────────────────────────────────────────────

export async function askMo({ question, history, activeCardSummary, endpoint, render }) {
  const abort = new AbortController();
  let cardRef = null;
  let dataTagSeen = false;
  let preTagText = ''; // text before the <data> tag (final, clean)

  // Debug trace — captured progressively through the turn so callers can
  // inspect exactly what Mo emitted, what attrs came out, what resolver
  // input was built, what USASpending returned, and which fallbacks fired.
  // Attached to every return shape. Turns no-op in production UI but the
  // logger panel in mo_mock.html reads it for per-turn inspection.
  const debug = {
    question,
    firstPassRaw: '',        // full raw text from Mo's first stream
    tagMatch: null,          // { raw: '<data ... />', attrs: {...} } once parsed
    resolverInput: null,     // INITIAL resolver input from the tag (before mutations)
    resolverInputFinal: null, // FINAL resolver input that actually queried USASpending
                             // (competitor expansion adds _sellerName, _competitorList,
                             // replaces vendor with vendors array; subaward path sets
                             // _subawards). This is what lets you verify that the
                             // file-first fetchCompetitors ran successfully.
    rowCountDirect: null,    // rows returned from the direct pull (before any fallback)
    fallbackType: null,      // 'category' | 'needs_qualifier' | 'no_data' | null
    rowCountFinal: null,     // rows after any fallback
    mode: null,              // final returned mode
  };

  // History must include the user's current question at the end
  const fullHistory = [...history, { role: 'user', content: question }];

  try {
    // ── First pass ──────────────────────────────────────────────
    const firstPassFull = await streamOnce({
      endpoint,
      history: fullHistory,
      activeCardSummary,
      payloadSummary: null,
      abortController: abort,
      onChunk: (accumulated) => {
        // Always keep the latest accumulated text in debug so even if
        // Mo never emits a tag (coaching response), we still have the
        // full raw output.
        debug.firstPassRaw = accumulated;

        if (dataTagSeen) return; // already handled, ignore further chunks

        const tagInfo = findDataTag(accumulated);

        if (tagInfo && !tagInfo.pending) {
          // Full <data> tag detected — pause, pull data, fire second call
          dataTagSeen = true;
          preTagText = accumulated.slice(0, tagInfo.index).trim();

          // Render everything up to the tag as final prose
          render.streamPreTagProse(preTagText);

          // Stash the exact tag text + parsed attrs for debug inspection.
          // The raw field lets us diff "what Mo emitted" vs "what we
          // interpreted" when something weird happens.
          debug.tagMatch = {
            raw: tagInfo.match,
            attrs: { ...tagInfo.attrs },
          };

          // Kick off the data fetch asynchronously; we'll await it below
          // after aborting the first stream
          const resolverInput = dataAttrsToResolverInput(tagInfo.attrs);
          debug.resolverInput = { ...resolverInput };
          cardRef = render.onDataTag(resolverInput);

          // Abort the first stream — we don't want Mo's speculative
          // post-tag prose. We'll get grounded prose from the second call.
          abort.abort();

          // Stash resolverInput on cardRef for the later fetch
          if (cardRef) cardRef._resolverInput = resolverInput;
        } else if (tagInfo && tagInfo.pending) {
          // Partial tag — render only text before the partial start.
          // Avoids flashing "<data" to the user mid-stream.
          render.streamPreTagProse(accumulated.slice(0, tagInfo.partialIndex).trim());
        } else {
          // No tag yet — render everything we have
          render.streamPreTagProse(accumulated);
        }
      },
    }).catch(err => {
      // If we aborted intentionally (data tag seen), that's expected
      if (dataTagSeen && err.name === 'AbortError') return null;
      throw err;
    });

    if (!dataTagSeen) {
      // Coaching / conversational path — first pass WAS the whole answer
      // firstPassFull is the final text; render.streamPreTagProse already
      // got the cumulative version as it arrived
      render.complete();
      debug.firstPassRaw = firstPassFull || preTagText;
      debug.mode = 'prose';
      return { mode: 'prose', text: firstPassFull || preTagText, debug };
    }

    // ── Data pull + second pass ─────────────────────────────────
    const resolverInput = cardRef._resolverInput;

    // Competitor mode: before fetching USASpending, call mo_competitors to
    // get the head-to-head competitors of the original vendor, then expand
    // resolverInput.vendors to [originalVendor, ...competitors]. The card
    // renders the combined footprint — seller + competitors in one view —
    // which is what the seller actually wants to see for "who are my
    // competitors" questions.
    let competitorInfo = null;
    if (resolverInput?._competitors && resolverInput?.vendor) {
      // Stash _sellerName up-front — we need it regardless of whether
      // the competitor lookup succeeds. Without this, a failed lookup
      // leaves downstream code with no seller reference, which breaks
      // the channel-partner classifier and the card's sellerLens label.
      resolverInput._sellerName = resolverInput.vendor;
      try {
        competitorInfo = await fetchCompetitors(resolverInput.vendor, endpoint);
        // Cap the query-expansion list at 6 competitors (seller + up to 6 =
        // up to 7 OR-keywords). More than that and USASpending starts to
        // timeout/500 on the combined query, and the resulting card turns
        // into a noisy grab-bag instead of a real head-to-head view. The
        // curated file lists stay under 6 naturally; Gemini fallback
        // sometimes returns 10-13 entries for fuzzy vendors (e.g. VARs
        // and resellers), which is where this cap matters.
        const allCompetitors = Array.isArray(competitorInfo.competitors) ? competitorInfo.competitors : [];
        const queryCompetitors = allCompetitors.slice(0, 6);
        // Build multi-vendor input: keep the original vendor AND add the
        // capped competitor set. Drop the singular `vendor` field in
        // favor of the array so the resolver ORs them all together as
        // keywords for USASpending.
        const combined = [resolverInput.vendor, ...queryCompetitors];
        delete resolverInput.vendor;
        resolverInput.vendors = combined;
        // Stash the FULL competitor metadata (not the capped list) so
        // Mo's prose can reference any of them, even the ones not in
        // the query itself.
        resolverInput._competitorCategory = competitorInfo.category;
        resolverInput._competitorList = allCompetitors;
        resolverInput._competitorSource = competitorInfo._source || 'unknown';
      } catch (compErr) {
        console.warn('[askMo] competitor lookup failed, falling back to single-vendor card:', compErr.message);
        // Fall through with the original single-vendor input + _sellerName
        // already set above. Flag the failure so the payload summary can
        // tell Mo "this is a degraded competitor view — don't invent
        // competitor names the data doesn't show."
        resolverInput._competitorFetchFailed = true;
      }
    }

    // Snapshot the resolver input AFTER competitor expansion and any
    // other mutations. This is the shape that actually went to
    // USASpending, so it's what developers need to see in the debug
    // panel to verify the right path fired (file-first vs Gemini,
    // competitor expansion successful vs degraded, etc.).
    debug.resolverInputFinal = JSON.parse(JSON.stringify(resolverInput));

    // ── Subaward branch ───────────────────────────────────────────
    // If Mo emitted subawards="true", we short-circuit the normal prime
    // fetch and instead hit USASpending's subaward mode. Different card,
    // different payload summary, different render path. Returns early
    // with its own second stream — none of the prime-path logic below
    // runs for subaward turns.
    if (resolverInput?._subawards) {
      let subs;
      try {
        subs = await fetchSubawards(resolverInput, endpoint);
      } catch (subErr) {
        console.error('[askMo] subaward fetch failed:', subErr);
        render.renderError(`Couldn't pull subaward data. ${subErr.message || ''}`.trim());
        debug.mode = 'error';
        return { mode: 'error', error: subErr.message, debug };
      }

      debug.rowCountDirect = subs ? subs.length : 0;

      if (!subs || subs.length === 0) {
        // Subaward data is legitimately sparse in federal. Not every
        // contract has visible sub-tier reporting. Tell the user honestly
        // instead of rendering an empty card.
        render.renderError(`I don't see subaward data for that slice. Federal subaward reporting is patchy — smaller task orders and some vehicles don't require it. Try a different agency or a broader vendor filter.`);
        debug.mode = 'no_subaward_data';
        debug.fallbackType = 'no_data';
        debug.rowCountFinal = 0;
        return { mode: 'no_subaward_data', resolverInput, debug };
      }

      // Render the subaward card
      render.renderSubawardCard(cardRef, subs, resolverInput);
      debug.rowCountFinal = subs.length;

      // Build subaward-specific payload summary
      const subSummary = summarizeSubawardsForMo(subs, resolverInput);

      const historyForSecondCall = [
        ...fullHistory,
        { role: 'model', content: preTagText + '\n\n[subaward data pulled; see card]' },
      ];

      const secondAbort = new AbortController();
      const secondPassFull = await streamOnce({
        endpoint,
        history: historyForSecondCall,
        activeCardSummary,
        payloadSummary: subSummary,
        abortController: secondAbort,
        onChunk: (accumulated) => {
          render.streamPostTagProse(accumulated);
        },
      });

      render.complete();
      debug.mode = 'subaward';
      return {
        mode: 'subaward',
        preTagText,
        subs,
        resolverInput,
        postTagText: secondPassFull,
        debug,
      };
    }

    let rows;
    try {
      rows = await fetchUsaspending(resolverInput, endpoint);
    } catch (fetchErr) {
      console.error('[askMo] USASpending fetch failed:', fetchErr);
      render.renderError(`Couldn't pull that data. ${fetchErr.message || ''}`.trim());
      debug.mode = 'error';
      return { mode: 'error', error: fetchErr.message, debug };
    }

    debug.rowCountDirect = rows.length;

    // Diagnostic: capture field values from the top-spend row so the
    // debug trace shows exactly what USASpending returned for Awarding
    // Agency / Sub Agency / Office. Without this we can only guess at
    // the shape, which has burned us during bucketing logic work.
    if (rows.length > 0) {
      const topRow = rows.slice().sort((a, b) =>
        (parseFloat(b['Award Amount']) || 0) - (parseFloat(a['Award Amount']) || 0)
      )[0];
      debug.sampleRowFields = {
        'Awarding Agency': topRow['Awarding Agency'] || null,
        'Awarding Sub Agency': topRow['Awarding Sub Agency'] || null,
        'Awarding Office': topRow['Awarding Office'] || null,
        'Recipient Name': topRow['Recipient Name'] || null,
      };
    }

    // ── Competitor-mode category filter ───────────────────────────
    //
    // When the pull is a competitor cut (user asked "who are my
    // competitors"), the vendor list includes the seller + head-to-head
    // competitors. USASpending keyword-matches that list across
    // description/recipient/award-title, which sometimes pulls in wildly
    // off-topic rows because competitor product names collide with
    // unrelated words in contract descriptions.
    //
    // Real example: SentinelOne's competitor expansion includes
    // CrowdStrike, whose product is called "Falcon". USASpending then
    // surfaces $1.2B in Bahrain F-16 "Hamad's Falcons" production
    // contracts — clearly not endpoint security work. A seller reading
    // that card would walk away thinking CrowdStrike has a billion-
    // dollar Air Force contract to displace. That's false and
    // trust-damaging.
    //
    // Fix: if the seller is in a known category, require each surviving
    // row to contain at least one category keyword somewhere in
    // description, recipient name, or award title. Rows with nothing
    // category-related get dropped. The filter is deliberately broad
    // (any-of-many keywords) so we keep bundled contracts like "IT
    // modernization with endpoint protection" alongside direct-product
    // rows like "CrowdStrike Falcon license".
    //
    // Only fires for competitor mode. Direct single-vendor pulls don't
    // need this — a user asking about "SentinelOne at DHS" expects the
    // 2-row Thundercat cut, not a category-filtered view of all
    // endpoint work.
    const isCompetitorMode = !!(resolverInput?._competitors || resolverInput?._sellerName);
    const sellerForCategoryFilter = resolverInput?._sellerName
      || (Array.isArray(resolverInput?.vendors) ? resolverInput.vendors[0] : null);

    if (isCompetitorMode && sellerForCategoryFilter && rows.length > 0) {
      const sellerCategory = lookupVendorCategory(sellerForCategoryFilter);
      if (sellerCategory && sellerCategory.keywords && sellerCategory.keywords.length > 0) {
        const beforeCount = rows.length;
        // Build the filter signal set: category keywords (e.g., ENDPOINT,
        // EDR) PLUS the canonical names of the seller and every known
        // competitor in the same category. We need the vendor-name leg
        // because descriptions often name the product without the
        // category word — "CROWDSTRIKE FALCON LICENSES" is clearly
        // endpoint work even though the word ENDPOINT doesn't appear.
        // Adding the competitor list is what keeps those rows alive
        // while still dropping Bahrain F-16 contracts.
        const signalSet = new Set();
        for (const k of sellerCategory.keywords) signalSet.add(k.toUpperCase());
        // Include seller + competitor canonical names as signals.
        if (sellerCategory.vendorCanonical) signalSet.add(sellerCategory.vendorCanonical.toUpperCase());
        for (const c of sellerCategory.competitors || []) {
          // Split multi-word competitor names into whole-name matches;
          // don't split into words because "Microsoft" alone would
          // match too much. Keep the full name as a single signal.
          signalSet.add(c.toUpperCase());
        }
        const signals = [...signalSet];
        const signalMatches = (row) => {
          const haystack = [
            row['Description'] || '',
            row['Recipient Name'] || '',
            row['Award Description'] || '',
            row['transaction_description'] || '',
          ].join(' | ').toUpperCase();
          return signals.some(s => haystack.includes(s));
        };
        rows = rows.filter(signalMatches);
        debug.competitorCategoryFilter = {
          category: sellerCategory.category,
          signals,
          beforeCount,
          afterCount: rows.length,
          droppedCount: beforeCount - rows.length,
        };
      }
    }

    // ── Empty-state recovery: category-aware fallback + qualifier ──
    //
    // The direct vendor-scoped pull came back empty. The seller pitched
    // their product at an agency where it has no top-100 footprint.
    //
    // Strategy depends on WHAT they pitched:
    //
    //   (a) Known tech vendor in vendor_categories.json (AWS, SentinelOne,
    //       Splunk, etc.) → we know the category. Refire the pull at the
    //       SAME agency using category keywords. Seller sees the real
    //       competitive market they're trying to enter.
    //
    //   (b) Unknown vendor (niche product, commodity, zinger like "MyPillow
    //       to DoD" or "mules to Army") → we CAN'T guess the category. The
    //       right move is not a blind agency-wide fallback — that got us
    //       the SentinelOne/border-wall embarrassment. Instead, bail out
    //       with mode='needs_qualifier' so Mo can ask the user what their
    //       product actually does. Better a useful question than wrong data.
    //
    //   (c) No vendor pitched, or vendor pitched federally (no agency) →
    //       current "truly empty" path. Nothing to fall back to.
    //
    // One retry max. If the category refire also returns empty, we fall
    // through to the qualifier path — can't recover further.
    let reframed = false;
    let categoryInfo = null;
    const originalSeller = resolverInput._sellerName
      || resolverInput.vendor
      || (Array.isArray(resolverInput.vendors) ? resolverInput.vendors[0] : '');
    const hadVendorFilter = !!originalSeller;

    if (rows.length === 0 && hadVendorFilter && resolverInput.agency) {
      categoryInfo = lookupVendorCategory(originalSeller);

      if (categoryInfo) {
        // ── Path (a): Category-aware refire ─────────────────────
        // Keep the agency. Drop the vendor. Inject category keywords so
        // the pull targets the seller's real competitive market at this
        // agency. Mark the input so the card and Mo's prompt know this
        // is a category reframe, not a generic one.
        const categoryInput = { ...resolverInput };
        delete categoryInput.vendor;
        delete categoryInput.vendors;
        delete categoryInput._sellerName;
        delete categoryInput._competitorCategory;
        delete categoryInput._competitorList;
        categoryInput._reframedFromVendor = originalSeller;
        categoryInput._categoryName = categoryInfo.category;
        categoryInput._categoryKeywords = categoryInfo.keywords;
        // Merge the category's keywords into the query's keyword set.
        // USASpending's keyword filter OR's these together, so we're
        // asking "any contract whose description mentions ANY of these
        // category terms at this agency."
        const existingKeywords = Array.isArray(categoryInput.keywords)
          ? categoryInput.keywords
          : (categoryInput.topic ? [categoryInput.topic] : []);
        categoryInput.keywords = [...new Set([...existingKeywords, ...categoryInfo.keywords])];
        delete categoryInput.topic; // consolidated into keywords

        try {
          const retryRows = await fetchUsaspending(categoryInput, endpoint);
          if (retryRows.length > 0) {
            rows = retryRows;
            reframed = true;
            Object.assign(resolverInput, categoryInput);
            debug.fallbackType = 'category';
          }
        } catch (retryErr) {
          console.warn('[askMo] category fallback retry failed:', retryErr.message);
          // Fall through to needs_qualifier below
        }
      }

      // ── Path (b): Unknown vendor → ask a qualifier ───────────
      // If the vendor wasn't in the categories file, OR the category
      // retry also came back empty, don't render a misleading card.
      // Return needs_qualifier so the UI can prompt Mo to ask the user
      // what their product does.
      if (!reframed) {
        debug.mode = 'needs_qualifier';
        debug.fallbackType = 'needs_qualifier';
        debug.rowCountFinal = 0;
        return {
          mode: 'needs_qualifier',
          resolverInput,
          originalSeller,
          agency: resolverInput.agency,
          vendorWasKnown: !!categoryInfo,
          debug,
        };
      }
    }

    if (rows.length === 0) {
      // Path (c): no vendor filter to fall back from, or the pitch was
      // federal-wide. Tell the user plainly and hand them escape chips.
      render.renderError(`I couldn't find anything matching that. Try a different agency, or tell me more about what you're looking for.`);
      debug.mode = 'no_data';
      debug.fallbackType = 'no_data';
      debug.rowCountFinal = 0;
      return { mode: 'no_data', resolverInput, debug };
    }

    debug.rowCountFinal = rows.length;

    // Render the real card
    render.renderDataCard(cardRef, rows, resolverInput);

    // Build a payload summary for Mo's grounded interpretation. The
    // `reframed` flag tells Mo that the pull she's about to interpret
    // isn't the literal vendor pull the user asked for — it's the
    // agency-wide fallback. She reads _reframedFromVendor to know what
    // the user originally pitched.
    const summary = summarizePayloadForMo(rows, resolverInput, { reframed });

    // Build history for second call: include Mo's first-pass prose so
    // conversational continuity is preserved. We truncate to the part
    // before the tag so Mo doesn't see her own tag in history.
    const historyForSecondCall = [
      ...fullHistory,
      { role: 'model', content: preTagText + '\n\n[data pulled; see card]' },
    ];

    // Fire second stream — grounded interpretation
    const secondAbort = new AbortController();
    const secondPassFull = await streamOnce({
      endpoint,
      history: historyForSecondCall,
      activeCardSummary,
      payloadSummary: summary,
      abortController: secondAbort,
      onChunk: (accumulated) => {
        render.streamPostTagProse(accumulated);
      },
    });

    render.complete();
    debug.mode = 'data';
    return {
      mode: 'data',
      preTagText,
      rows,
      resolverInput,
      postTagText: secondPassFull,
      debug,
    };
  } catch (err) {
    console.error('[askMo] fatal:', err);
    render.renderError(err.message || 'Something went sideways.');
    debug.mode = 'error';
    return { mode: 'error', error: err.message, debug };
  }
}
