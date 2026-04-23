// ============================================================================
// mo-stream-client.v2.js. Browser-side streaming + <data> tag handling
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
// or conversational response, no second pass, no data card. Just prose.
//
// Design: the module exposes ONE function, askMo(), that takes a user
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
// vendor_categories.json, category-aware fallback dictionary
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
// Best-effort load, if the file is missing or malformed, we skip the
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

// ─────────────────────────────────────────────────────────────────────
// offices.json, award-ID-prefix → office-name lookup
// ─────────────────────────────────────────────────────────────────────
//
// USASpending's spending_by_award endpoint does not reliably return the
// Awarding Office field, for many large DoD contracts, that field is
// null. But the Award ID itself encodes the office as a prefix (N00024,
// N00019, W52P1J, etc.). This file maps those prefixes to human names
// so we can enrich rows post-fetch and get a real command-level
// breakdown (NAVSEA / NAVAIR / NIWC / etc.) in the card treemap.
//
// Best-effort load. If offices.json is missing or malformed, we skip
// the enrichment and the treemap falls back to subtier-level data
// (one block for Navy, which is visually underwhelming but correct).
// ─────────────────────────────────────────────────────────────────────

let _offices = {};            // prefix → "OFFICE NAME"
let _officesLoaded = false;

export const officesReady = (async () => {
  try {
    const url = new URL('./offices.json', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[stream-client] offices.json fetch failed: HTTP ${res.status}. Office enrichment disabled.`);
      _officesLoaded = true;
      return;
    }
    const data = await res.json();
    if (data && typeof data === 'object') {
      _offices = data;
      _officesLoaded = true;
    } else {
      console.warn('[stream-client] offices.json has unexpected shape. Office enrichment disabled.');
      _officesLoaded = true;
    }
  } catch (err) {
    console.warn('[stream-client] offices.json load error:', err.message);
    _officesLoaded = true;
  }
})();

// Try progressive prefix matching, 6 chars first, then 5, then 4.
// Returns the decoded office name, or null if no match. Takes the
// full Award ID string. Defensive on null/undefined.
function officeFromAwardId(awardId) {
  if (!awardId || typeof awardId !== 'string') return null;
  const id = awardId.toUpperCase();
  return _offices[id.substring(0, 6)]
    || _offices[id.substring(0, 5)]
    || _offices[id.substring(0, 4)]
    || null;
}

// Normalize a vendor name for category lookup. Same rules as the file
// keys, lowercase, trimmed, punctuation stripped, legal suffixes removed.
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
    // Check for a partial tag, <data with no closer yet. If present,
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

// Defensive: strip any <data ... /> tags from prose text. Used on the
// second-pass stream because Mo occasionally echoes the original data
// tag in her grounded prose despite the prompt forbidding it. Without
// this, the raw markup leaks into the rendered post-card prose and the
// user literally sees "<data agency=..." in their card. Also handles
// the partial-tag case mid-stream, if the chunk ends with "<da", we
// hold back the partial fragment until the next chunk completes it.
//
// Returns { cleaned, hasPartial }, caller should NOT render if
// hasPartial is true (wait for next chunk to disambiguate). On
// completed chunks, fully-formed tags are removed and the surrounding
// whitespace is collapsed so we don't leave double-newlines where a
// tag was.
export function stripDataTags(text) {
  if (!text) return { cleaned: '', hasPartial: false };
  // Detect any partial trailing tag, if we see "<data" without a closer
  // anywhere AFTER it, hold off rendering. Also catch shorter prefixes
  // like "<d", "<da", "<dat" that occur when a stream chunk lands
  // mid-tag, we don't want to flash "Some prose <da" to the user.
  const partialIdx = text.lastIndexOf('<data');
  let hasPartial = false;
  if (partialIdx >= 0) {
    const tail = text.slice(partialIdx);
    if (!/\/>/.test(tail) && !/<\/data>/i.test(tail)) {
      hasPartial = true;
      // Don't render the partial, return only the safe prefix
      const safe = text.slice(0, partialIdx);
      return { cleaned: safe.replace(/<data\b[^>]*\/>/gi, '').replace(/\n{3,}/g, '\n\n').trim(), hasPartial };
    }
  } else {
    // Check for shorter prefixes of "<data" at the very end of the chunk:
    //   "...something <"        → hold (could be anything)
    //   "...something <d"       → hold (could become <data)
    //   "...something <da"      → hold
    //   "...something <dat"     → hold
    // Only trigger when the trailing "<x..." is at the very end and is
    // a valid prefix of "<data". Other "<" usage (like "<5%") falls
    // through normally because there's prose after the "<".
    const partialPrefixMatch = text.match(/<(?:d(?:a(?:t)?)?)?$/i);
    if (partialPrefixMatch) {
      hasPartial = true;
      const safe = text.slice(0, partialPrefixMatch.index);
      return { cleaned: safe.replace(/<data\b[^>]*\/>/gi, '').replace(/\n{3,}/g, '\n\n').trim(), hasPartial };
    }
  }
  // Strip all complete tags + collapse leftover whitespace
  const cleaned = text.replace(/<data\b[^>]*\/>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleaned, hasPartial: false };
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
  // Subaward direction: Mo emits subaward_dir="to" for Direction B (subs
  // the queried vendor is hiring to deliver their prime contracts) and
  // subaward_dir="from" for Direction A (primes hiring the queried
  // vendor as a sub). Default is "to" when the attribute is absent,
  // preserving existing Direction B behavior. Both are useful depending
  // on context: "to" is great for integrator-primes who farm work out
  // to SaaS vendors; "from" is often the only data available for big
  // defense primes (Northrop, Lockheed) where as-prime subawards aren't
  // reported but as-sub relationships are.
  if (attrs.subaward_dir === 'from') {
    input._subawardDir = 'from';
  } else if (input._subawards) {
    input._subawardDir = 'to';
  }
  return input;
}

// Fetch head-to-head federal competitors for a vendor via the Lambda
// endpoint. Returns { vendor, category, competitors: [...] } or throws.
// Called by askMo() when a <data> tag has competitors="true".
// ─────────────────────────────────────────────────────────────────────
// fetchCompetitors, figure out who competes head-to-head with the seller
// ─────────────────────────────────────────────────────────────────────
//
// Two-tier lookup:
//
//  1. FILE FIRST. If the vendor is in vendor_categories.json, return the
//     curated competitor list directly. No network call. No failure mode.
//     Deterministic, same vendor always returns same list. This is how
//     we handle AWS, Microsoft, SentinelOne, Datadog, Akamai, Sonatype,
//     etc., all the vendors we've hand-curated for known federal
//     categories.
//
//  2. GEMINI FALLBACK. For unknown vendors (niche products, new entrants,
//     anything not in the file), call the Lambda's mo_competitors
//     endpoint, which asks Gemini for a competitor list. This path has
//     failure modes (Gemini 500, malformed JSON, timeout) and the caller
//     must handle them, see askMo()'s try/catch around fetchCompetitors.
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
// Subawards endpoint returns different fields, prime+sub relationships,
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

// Build a keyword-fallback retry payload for a resolver input whose
// direct subtier filter returned zero rows. This handles the USASpending
// quirk that CISA, USCG, STRATCOM, Marines, Space Force, Secret Service,
// JSOC, ATF, US Marshals, BOP, USPTO, and several combatant commands are
// real to federal sellers but aren't actual awarding agencies at USASpending
//, their contracts are awarded through the parent toptier (DHS HQ, DoD HQ,
// DOJ Offices/Boards/Divisions) and only mention the "agency" in the
// contract description. An agency-filter pull returns 0 rows. A keyword
// pull against the parent toptier with [acronym, canonical name] returns
// the actual contracts.
//
// Returns null if we can't build a sensible fallback (no resolved agency,
// or the agency was already a toptier).
function buildKeywordFallbackFilters(resolverInput, resolvedFilters) {
  const agencies = resolvedFilters.agencies;
  if (!Array.isArray(agencies) || agencies.length === 0) return null;
  const a = agencies[0];
  if (a.tier !== 'subtier' || !a.toptier_name) return null;

  // Pull the user's original agency term so we can use the acronym if they
  // typed one. Falls back to the canonical subtier name.
  const userTerm = String(resolverInput?.agency || '').trim();
  const keywords = [];
  if (userTerm && userTerm.length <= 20 && /^[A-Za-z][A-Za-z0-9\s.'&\-]*$/.test(userTerm)) {
    keywords.push(userTerm);
  }
  if (a.name && !keywords.some(k => k.toLowerCase() === a.name.toLowerCase())) {
    keywords.push(a.name);
  }
  if (keywords.length === 0) return null;

  return {
    agencies: [{ tier: 'toptier', name: a.toptier_name, type: 'awarding' }],
    keywords,
    _retriedFromSubtier: a.name,
    _retryParent: a.toptier_name,
  };
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
    // invalid, e.g. a keyword that's too short, a mismatched agency
    // name, or a combination the API rejects. 5xx means USASpending
    // itself is having trouble. The error surface downstream renders
    // this message; keep it short and user-readable, not developer-y.
    if (res.status >= 400 && res.status < 500) {
      throw new Error("The search terms didn't match USASpending's filter rules. Try rephrasing, be more specific about the vendor, agency, or product.");
    }
    throw new Error('USASpending is having trouble right now. Give it a minute and try again.');
  }
  const body = await res.json();
  let raw = Array.isArray(body.results) ? body.results : [];

  // ── Smart retry for mission-program subtiers ────────────────────
  //
  // USASpending treats entries like CISA, USCG, STRATCOM, Marines, Space
  // Force, Secret Service, JSOC, and several combatant commands as
  // mission concepts rather than awarding subtiers. Direct subtier
  // filters for these return 0 rows even though real contracts exist
  // under their parent toptier. The fedhoo / oldgovhoo apps handle this
  // by retrying as a keyword search when the direct pull is empty.
  // We adopt the same strategy here.
  //
  // Triggers when: zero rows returned, the resolver picked a subtier
  // agency, and the user didn't explicitly supply contradictory filters
  // (vendor/keywords) that would make a retry unproductive.
  let retriedFromSubtier = null;
  if (raw.length === 0) {
    const fallback = buildKeywordFallbackFilters(resolverInput, resolvedFilters);
    if (fallback) {
      // Merge user's existing topic keywords with the fallback's identity
      // keywords. For "cyber at CISA": fallback gives [CISA, ...full name]
      // and the user's topic already added cybersecurity keywords upstream.
      // Combine without duplicates.
      const mergedKeywords = [
        ...(resolvedFilters.keywords || []),
        ...fallback.keywords,
      ];
      const retryFilters = {
        time_period: trailing12Mo(),
        award_type_codes: CONTRACT_TYPES,
        agencies: fallback.agencies,
        keywords: [...new Set(mergedKeywords)],
      };
      // Preserve non-agency filters the resolver produced (PSC, NAICS,
      // recipient, date refinements, etc.), only swap the agency filter.
      for (const key of Object.keys(resolvedFilters)) {
        if (key !== 'agencies' && key !== 'keywords' && !retryFilters[key]) {
          retryFilters[key] = resolvedFilters[key];
        }
      }
      const retryPayload = { filters: retryFilters, fields: AWARD_FIELDS, limit: 100, sort: 'Award Amount', order: 'desc' };
      try {
        const retryRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_type: 'usaspending_proxy',
            endpoint: '/search/spending_by_award/',
            payload: retryPayload,
          }),
        });
        if (retryRes.ok) {
          const retryBody = await retryRes.json();
          const retryRaw = Array.isArray(retryBody.results) ? retryBody.results : [];
          if (retryRaw.length > 0) {
            raw = retryRaw;
            retriedFromSubtier = fallback._retriedFromSubtier;
            // Mark every row with a flag the caller can read if it wants
            // to render a note like "USASpending files CISA under DHS."
            for (const r of retryRaw) r._mission_fallback = true;
          }
        }
      } catch (retryErr) {
        // Swallow, the direct query already succeeded (with zero rows).
        // Retry is best-effort. Log for debugging.
        console.warn('[fetchUsaspending] mission-fallback retry failed:', retryErr.message);
      }
    }
  }

  // Data grooming. Three things happen here that the render path downstream
  // assumes have already run:
  //
  // 1. _endTs for expiring-window filters and pattern classification
  // 2. _startTs for pattern classification (duration-based branches need
  //    both timestamps; without _startTs every contract falls into the
  //    'adjacent' default bucket and no pattern pill renders)
  // 3. For DoD contracts, swap in the sub-agency name as the Awarding Agency
  //    so the treemap breaks into Navy/Army/Air Force instead of showing one
  //    undifferentiated "Department of Defense" block. Ported from v1.
  for (const r of raw) {
    r._endTs = r['End Date'] ? new Date(r['End Date']).getTime() : 0;
    r._startTs = r['Start Date'] ? new Date(r['Start Date']).getTime() : 0;
    const topAgency = String(r['Awarding Agency'] || '').toUpperCase();
    if (topAgency.includes('DEFENSE') && r['Awarding Sub Agency']) {
      r['Awarding Agency'] = r['Awarding Sub Agency'];
    }
    // USASpending often returns null Awarding Office even when the data
    // exists, the office is encoded in the Award ID prefix. Decode it
    // from offices.json so analyzeMarket's treemap bucketing gets real
    // command-level variation (NAVSEA vs NAVAIR vs NIWC) instead of
    // everything collapsing to "Department of the Navy".
    if (!r['Awarding Office']) {
      const decoded = officeFromAwardId(r['Award ID']);
      if (decoded) r['Awarding Office'] = decoded;
    }
  }

  // Apply post-filters (vendor scope, agency scope, amount bounds, expiring).
  // When we retried via mission-fallback, the post-filter's agency_scope
  // would block all rows (the returned rows are attributed to the toptier,
  // not the subtier). Skip that particular filter on fallback rows.
  const filteredPostFilters = retriedFromSubtier
    ? { ...postFilters, agency_scope: null, office_scope: null }
    : postFilters;
  const filtered = applyPostFilters(raw, filteredPostFilters);

  // Stamp the result with the fallback marker so the caller can surface
  // it in debug UI or add a one-liner to Mo's pre-tag prose.
  if (retriedFromSubtier) {
    filtered._retriedFromSubtier = retriedFromSubtier;
  }
  return filtered;
}

// ─────────────────────────────────────────────────────────────────────
// fetchSubawards, pull prime→sub relationships from USASpending
// ─────────────────────────────────────────────────────────────────────
//
// Same URL as fetchUsaspending (/search/spending_by_award/), but the payload
// has `subawards: true` at the top level which flips USASpending into
// subaward mode, it returns sub-tier records with Prime Recipient Name +
// Sub-Awardee Name instead of prime contracts.
//
// Returns an array of { prime, sub, amount, agency, desc, date, link } objects
// ready for the subaward card renderer. No post-filtering is applied here
// (subaward data is already narrow), the filter just scopes the result set.
// ─────────────────────────────────────────────────────────────────────
export async function fetchSubawards(resolverInput, endpoint) {
  const { filters: resolvedFilters, postFilters: resolvedPostFilters } = resolve(resolverInput);
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
  const shaped = raw.map(s => ({
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

  // ── Direction filter ──────────────────────────────────────────────
  //
  // USASpending's subaward keyword-match scans BOTH the Prime Recipient
  // Name AND the Sub-Awardee Name fields, then sorts by sub-amount. For
  // any big integrator or defense prime, the top 100 rows are dominated
  // by them-as-sub, because big-prime → big-sub relationships have the
  // largest dollar amounts (Lockheed → Northrop $443M is a bigger row
  // than any specific Northrop → [little sub] relationship).
  //
  // Two directions the user cares about:
  //   TO  (Direction B): vendor is the prime. Rows show vendor → subs
  //     it hires to deliver its prime contracts. Gold for SaaS sellers
  //     who want to see what work a big integrator is farming out.
  //   FROM (Direction A): vendor is the sub. Rows show primes → vendor
  //     relationships. The only available data for big defense primes
  //     (Northrop, Lockheed) whose as-prime subs aren't reported.
  //
  // Build the needle set (short + legal forms) for recipient matching.
  const vendorInput = resolverInput?.vendor
    || (Array.isArray(resolverInput?.vendors) ? resolverInput.vendors[0] : null);
  const needles = new Set();
  if (vendorInput) {
    const short = String(vendorInput || '').trim().toUpperCase();
    if (short.length >= 3) needles.add(short);
    if (Array.isArray(resolvedPostFilters?.vendor_legal_names)) {
      for (const legal of resolvedPostFilters.vendor_legal_names) {
        needles.add(String(legal).toUpperCase());
      }
    }
  }

  function filterByDirection(rows, direction) {
    if (!vendorInput || rows.length === 0) return rows;
    return rows.filter(r => {
      const field = direction === 'from'
        ? (r.sub || '').toUpperCase()    // Direction A: vendor-as-sub
        : (r.prime || '').toUpperCase(); // Direction B: vendor-as-prime
      for (const needle of needles) {
        if (field.includes(needle)) return true;
      }
      return false;
    });
  }

  // Default direction is 'to' (B) when unspecified — matches the most
  // common seller intent ("what is this prime farming out?") and
  // preserves backward compat with tags that don't set subaward_dir.
  const requestedDir = resolverInput?._subawardDir === 'from' ? 'from' : 'to';

  const rows = filterByDirection(shaped, requestedDir);
  rows._subawardDirection = requestedDir;

  // No auto-flip. If the user asks Direction B and there's nothing,
  // show nothing. Honest beats magical — a user who wants the other
  // direction can ask for it explicitly. Previously we silently
  // flipped B→A and stamped _autoFlipped, which misled users about
  // what they were looking at and added a confusing banner.

  return rows;
}

// Compact payload summary for Mo's grounded second-pass call when she
// pulled subawards. Tells her who's moving sub work, top primes by
// sub spend, top subs by take.
export function summarizeSubawardsForMo(subs, resolverInput) {
  if (!subs || subs.length === 0) {
    const vendor = resolverInput?.vendor || (resolverInput?.vendors && resolverInput.vendors[0]) || 'this vendor';
    const dir = resolverInput?._subawardDir === 'from' ? 'from' : 'to';
    const oppositeQuery = dir === 'to'
      ? `"who subawards to ${vendor}"`
      : `"who does ${vendor} subaward to"`;
    const directionExplainer = dir === 'to'
      ? `as a prime hiring subs`
      : `as a sub hired by primes`;
    return `No subaward records found for ${vendor} ${directionExplainer} in the last 12 months. USASpending subaward reporting is sparse (mandatory only above $30K, lags by months), and many defense/classified contracts don't report at all. Tell the seller this plainly in 1-2 sentences. Then offer two concrete next moves: (a) ask ${oppositeQuery} to see the opposite direction, (b) look at ${vendor}'s prime-level contracts for recompete signals. Don't pad or over-explain — short and useful beats long.`;
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

  // Direction framing: two possibilities now.
  //   TO  (B): vendor is the PRIME, rows show vendor → subs
  //   FROM (A): vendor is the SUB, rows show primes → vendor
  // Mo's coaching has to match the direction. A TO card with a FROM-style
  // coaching message ("pitch to their primes") would be confusing.
  const vendorName = resolverInput?.vendor
    || (Array.isArray(resolverInput?.vendors) ? resolverInput.vendors[0] : null);
  const direction = subs._subawardDirection === 'from' ? 'from' : 'to';

  let directionBlock = '';
  if (vendorName && direction === 'to') {
    directionBlock = `
DIRECTION: ${vendorName} is the PRIME. These subawards show who ${vendorName} is awarding sub-work TO (downstream). The seller wants to know these subs so they can (a) displace a weak incumbent sub with a better capability, (b) partner with an established sub who's already in ${vendorName}'s delivery chain, or (c) offer ${vendorName} an adjacent value-added service the current subs don't provide. Coach them accordingly.`;
  } else if (vendorName && direction === 'from') {
    directionBlock = `
DIRECTION: ${vendorName} is the SUB. These subawards show primes hiring ${vendorName} to help deliver their own contracts. The seller wants to know these primes so they can (a) team with ${vendorName}'s existing prime customers to reach similar work, (b) pitch those primes directly as an adjacent capability (if they're already buying ${vendorName}, they're buying in this category), or (c) understand ${vendorName}'s role in the delivery chain before trying to approach them.`;
  }

  return `Query: ${queryDesc || '(no filters)'} (SUBAWARD CUT, direction=${direction})${directionBlock}
Total sub work (top ${subs.length} subs, last 12mo): $${(total / 1_000_000).toFixed(1)}M
Unique primes giving out sub work: ${primeMap.size}
Unique subs receiving work: ${subMap.size}

Top primes by sub work disbursed:
${topPrimes.map(p => '  - ' + p).join('\n')}

Top subs by work received:
${topSubs.map(s => '  - ' + s).join('\n')}

Subs with leverage (working for multiple primes):
${multiPrimeSubs.length > 0 ? multiPrimeSubs.map(s => '  - ' + s).join('\n') : '  (none, subs here are locked to single primes)'}

Your job: tell the seller who's REALLY doing the work and where the leverage is. Match your coaching to the DIRECTION noted above, don't mix them up.`;
}

// ─────────────────────────────────────────────────────────────────────
// Build a payload summary for Mo's second (grounded) call
// ─────────────────────────────────────────────────────────────────────
//
// We don't pass the raw 100 rows back to Gemini, that's too verbose and
// wasteful. Instead, compact to the signals Mo needs for interpretation:
// total dollars, top 5 primes, agency breakdown, expiring count.
// ─────────────────────────────────────────────────────────────────────

export function summarizePayloadForMo(rows, resolverInput, opts = {}) {
  if (!rows || rows.length === 0) {
    return `No contracts matched the query. Tell the user the data came back empty and suggest a different angle.`;
  }

  // Mission-program fallback acknowledgment. When fetchUsaspending had to
  // retry as a keyword search against the parent toptier (because CISA,
  // USCG, STRATCOM, etc. aren't real USASpending subtiers), surface that
  // fact to Mo so she can acknowledge it in a short aside instead of
  // pretending the filter worked as typed.
  const missionFallback = opts.missionFallback || rows._retriedFromSubtier || null;

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
  //   1. Direct   , the seller themselves (Amazon Web Services, Inc.)
  //   2. Channel  , VARs reselling the seller (Four Points reselling
  //                  AWS, Thundercat reselling CrowdStrike Falcon).
  //                  Detectable: contract description names the seller's
  //                  product.
  //   3. Competitor, a different vendor in the same category (Microsoft
  //                  selling Azure in an AWS competitor pull).
  //
  // Mo's coaching is radically different across these three. Attacking
  // a channel partner who's reselling your product is shooting yourself
  // in the foot, you want to DEFEND and STRENGTHEN that relationship.
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
    // entirely, better to leave primes untagged than to tag them wrong.
    if (sellerForms.size === 0) {
      // No classification possible. topPrimesAnnotated below will render
      // plain "Name ($M)" entries without relation tags.
    } else {
      // Build per-prime description corpus, concatenate every description
      // that prime shows up on. If ANY of their contracts name ANY form
      // of the seller, they're a channel partner. Empty description →
      // assume competitor (safer default, better to attack a "competitor"
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
          // different vendor in the same cut, competitor in a
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

  // Expiring pipeline, 90 day and 12 month windows, with specific
  // contract records so Mo can produce govhoo-style recompete lists.
  //
  // Sellers asking "pipeline opps," "recompete targets," "what's expiring,"
  // or "[product]-ready opportunities" don't want aggregate numbers —
  // they want a list of specific contracts with IDs, full descriptions,
  // vendor names, end dates, and dollar values. Give Mo the raw material
  // to build that list in her prose. Without these records in context,
  // she can only work from summary stats and her answers devolve to
  // generic "$X is expiring, find out who holds them" advice.
  const now = Date.now(), in90 = now + 90 * 86400_000, in365 = now + 365 * 86400_000;
  const expiring = rows
    .filter(r => r._endTs > now && r._endTs <= in90)
    .sort((a, b) => a._endTs - b._endTs); // soonest first
  const expiringVal = expiring.reduce((s, r) => s + (parseFloat(r['Award Amount']) || 0), 0);
  const expiring12 = rows
    .filter(r => r._endTs > now && r._endTs <= in365)
    .sort((a, b) => b['Award Amount'] - a['Award Amount']); // highest value first
  const expiring12Val = expiring12.reduce((s, r) => s + (parseFloat(r['Award Amount']) || 0), 0);
  const daysOut = (ts) => Math.max(0, Math.round((ts - now) / 86400_000));
  const formatEndDate = (ts) => ts
    ? new Date(ts).toISOString().slice(0, 10)
    : 'unknown';

  // 90-day near-term targets (immediate pipeline), keep concise format
  const topExpiringDetail = expiring.slice(0, 5).map(r => {
    const vendor = r['Recipient Name'] || 'Unknown';
    const amt = parseFloat(r['Award Amount']) || 0;
    const office = r['Awarding Office']
      || r['Awarding Sub Agency']
      || r['Awarding Agency']
      || '';
    const desc = (r['Description'] || '').slice(0, 80).replace(/\s+/g, ' ').trim();
    return `${vendor}, $${(amt / 1_000_000).toFixed(1)}M at ${office}, ${daysOut(r._endTs)}d left${desc ? ', ' + desc : ''}`;
  });

  // 12-month recompete candidates (full records Mo can cite in bulleted
  // answers). Top 10 by dollar value, rich detail. This is what lets
  // her produce govhoo-quality contract-by-contract pipeline answers.
  const recompeteList = expiring12.slice(0, 10).map(r => {
    const vendor = r['Recipient Name'] || 'Unknown';
    const amt = parseFloat(r['Award Amount']) || 0;
    const office = r['Awarding Office']
      || r['Awarding Sub Agency']
      || r['Awarding Agency']
      || '';
    const awardId = r['Award ID'] || '';
    const desc = (r['Description'] || '').slice(0, 160).replace(/\s+/g, ' ').trim();
    const endDate = formatEndDate(r._endTs);
    const parts = [
      `  • ${vendor}`,
      `    Contract: ${awardId}`,
      `    Value: $${(amt / 1_000_000).toFixed(1)}M`,
      `    Ends: ${endDate} (${daysOut(r._endTs)}d)`,
      `    Office: ${office}`,
    ];
    if (desc) parts.push(`    Scope: ${desc}`);
    return parts.join('\n');
  });

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
    // instead of a real competitor view. Tell Mo the truth, don't let
    // her hallucinate competitor names from training data when the data
    // in the card is just the seller's own contracts.
    const sellerLabel = resolverInput._sellerName || '';
    framing = `
COMPETITOR LOOKUP FAILED.
The user asked about ${sellerLabel}'s competitors, but the competitor expansion service returned an error. The rows below are ${sellerLabel}'s OWN footprint, not a real competitor view.
Your job: tell the user honestly that you couldn't pull the competitive landscape this turn, show them ${sellerLabel}'s current position based on the rows below, and suggest they try again in a moment. DO NOT name specific competitors from memory, the data doesn't support those claims. It's fine to say "CrowdStrike and Microsoft Defender are typical competitors in this category" as general category knowledge, but do NOT claim anything about their specific federal footprint that isn't visible in the rows.`;
  }

  // Reframed-on-empty framing: the user pitched a vendor+agency combo, but
  // the direct pull came back empty, so the browser refired the query
  // without the vendor filter. The card now shows the agency-wide market,
  // not the seller's literal footprint. Mo MUST explain this, leading
  // with honesty ("your product isn't here directly") before walking the
  // market picture. Otherwise she'll read the card as proof of a presence
  // the seller doesn't actually have, which is a trust disaster.
  if (opts.reframed && resolverInput?._reframedFromVendor) {
    const pitched = resolverInput._reframedFromVendor;
    const category = resolverInput?._categoryName || null;
    const agencyName = resolverInput?.agency || 'this agency';
    if (category) {
      framing += `
⚠️ CRITICAL FRAMING RULE, read before writing anything.

Your FIRST sentence must be, exactly in spirit: "${pitched} doesn't show up directly at ${agencyName}."

WHY: the user pitched ${pitched} at ${agencyName}, but ${pitched} has no direct top-100 footprint there. The rows below are NOT ${pitched}'s contracts. They are the competitive ${category} market at ${agencyName}, pulled as a reframe so the seller can see where their product would fit.

Your response structure:
 1. FIRST SENTENCE: "${pitched} doesn't show up directly at ${agencyName}." No preamble. No softening.
 2. SECOND SENTENCE: "Here's the ${category} market there instead" or similar pivot.
 3. THIRD SENTENCE: name the top 1-2 competitors from the rows and what that means for ${pitched}.

Do NOT cite Award IDs, dollar amounts, or end dates as if they belong to ${pitched}. They belong to the competitors. Use them only to describe the competitive landscape ${pitched} would enter.`;
    } else {
      framing += `
⚠️ CRITICAL FRAMING RULE, read before writing anything.

Your FIRST sentence must be, exactly in spirit: "${pitched} doesn't show up directly at ${agencyName}."

WHY: the user pitched ${pitched} at ${agencyName}, but ${pitched} has no direct top-100 footprint there. The rows below are the agency's broader spending, NOT ${pitched}'s contracts.

Your response structure:
 1. FIRST SENTENCE: "${pitched} doesn't show up directly at ${agencyName}." No preamble.
 2. SECOND SENTENCE: describe what the agency IS spending on, based on the top primes.
 3. THIRD SENTENCE: a concrete next step, which sub-agency, which prime, which adjacency.

Do NOT pretend the rows represent ${pitched}'s presence. They don't.`;
    }
  }

  const missionFallbackNote = missionFallback
    ? `\n\n⚠️ DATA NOTE: The user asked about "${missionFallback}," but USASpending doesn't file "${missionFallback}" as an awarding agency, contracts for this mission flow through the parent department. The rows below came from the parent toptier with "${missionFallback}" as a keyword filter, which surfaces the real market. In your prose, include ONE short acknowledgment like "USASpending files ${missionFallback} contracts under the parent department, so these are the real ones." Don't belabor it. Then continue with the normal analysis.`
    : '';

  return `Query: ${queryDesc || '(no filters)'}${framing}${missionFallbackNote}
Total (top ${rows.length} contracts, last 12mo): $${(total / 1_000_000).toFixed(1)}M
Unique primes in slice: ${primeMap.size}
Top 3 concentration: ${top3Pct}%
Top primes:
${topPrimesAnnotated.map(p => '  - ' + p).join('\n')}
Top awarding agencies:
${topAgencies.map(a => '  - ' + a).join('\n')}
Pipeline, expiring in next 90 days: ${expiring.length} contracts, $${(expiringVal / 1_000_000).toFixed(1)}M total
${topExpiringDetail.length > 0 ? 'Top near-term targets:\n' + topExpiringDetail.map(t => '  - ' + t).join('\n') : '  (nothing expiring soon)'}
Pipeline, 12-month outlook: ${expiring12.length} contracts, $${(expiring12Val / 1_000_000).toFixed(1)}M total
${recompeteList.length > 0 ? 'Top recompete candidates (next 12 months, full records for citing in prose):\n' + recompeteList.join('\n\n') : ''}`;
}

// ─────────────────────────────────────────────────────────────────────
// streamOnce, one call to /mo_stream with abort support
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
// Pipeline-list generation (govhoo pattern)
// ─────────────────────────────────────────────────────────────────────
//
// User asks "give me 5 salesforce-ready pipeline opps" or "top 10
// recompetes at DHS", this is a structured-list request where each
// item is a real contract with specific fields (vendor, Award ID,
// amount, end date, office). Without guardrails, Flash Lite fabricates
// these fields. With this path, the fields come from real rows and the
// LLM only writes the per-item insight text.
//
// Flow:
//   1. Detect pipeline-list intent from the user message (count + lens)
//   2. Select top N records from the rows deterministically (by
//      expiring-soon priority + dollar value)
//   3. Shape each record into the payload expected by the Lambda
//   4. Call fedmo_pipeline_insights, returns insights keyed by awardId
//   5. Combine real records + insights into the final output
//   6. Client renders from real records; insights slot in per-card
//
// Fabrication is structurally impossible because the LLM never produces
// record fields, only insight text keyed to awardIds the client
// controls.
// ─────────────────────────────────────────────────────────────────────

// Detect whether the user message is asking for a structured pipeline
// list. Returns { count, lens } if matched, null otherwise.
//
// Matches:
//   "give me 5 opps"                    → { count: 5, lens: null }
//   "show me 10 pipeline opportunities" → { count: 10, lens: null }
//   "5 salesforce-ready pipeline opps"  → { count: 5, lens: "salesforce" }
//   "top 5 recompetes for DHS"          → { count: 5, lens: null }
//   "give me 5 splunk-fit opportunities" → { count: 5, lens: "splunk" }
//   "5 opps for AWS"                    → { count: 5, lens: "aws" }
//
// Does NOT match things that just contain a number and an unrelated word.
// Requires BOTH a count (1-20) AND a pipeline-intent keyword nearby.
export function detectPipelineListIntent(question) {
  if (!question || typeof question !== 'string') return null;
  const text = question.toLowerCase();

  // Pipeline intent keywords, must appear somewhere in the message.
  // Includes common truncations sellers type in flow ("5 pipe", "3 recomps").
  // Requires \b word boundaries to avoid matching inside larger words
  // (e.g., "plays" matches but "display" does not; "pipe" matches but
  // "piped" does not).
  const pipelineKeywords = /\b(opps?|opportunit(?:y|ies)|pipelines?|pipes?|recompetes?|recomps?|prospects?|targets?|leads?|plays?)\b/;
  const pipelineMatch = text.match(pipelineKeywords);
  if (!pipelineMatch) return null;
  const pipelineIdx = pipelineMatch.index;

  // Count extraction, accept "5", "top 5", "give me 5", "5-10" → 5
  const countMatch = text.match(/\b(?:top\s+|give\s+me\s+|show\s+(?:me\s+)?|list\s+(?:me\s+)?)?(\d{1,2})\b/);
  if (!countMatch) return null;
  const count = parseInt(countMatch[1], 10);
  if (count < 1 || count > 20) return null;
  const countIdx = countMatch.index;

  // ── Adjacency guard ─────────────────────────────────────────
  // The count and the pipeline keyword must be reasonably close. In a
  // sentence like "I read 5 articles about DHS opps last week," both a
  // count (5) and a pipeline keyword (opps) exist but are unrelated —
  // the user is not asking for a list. The request pattern is always
  // count-then-pipeline-keyword (or pipeline-keyword-then-count) with
  // at most a few words in between. Threshold of 25 chars catches the
  // false positives empirically observed (29-32 char gaps) while
  // allowing real compound asks like "5 salesforce-ready pipeline opps"
  // (gap 17-28 depending on phrasing).
  const gap = Math.abs(pipelineIdx - countIdx);
  if (gap > 25) return null;

  // Lens extraction, look for "[word]-ready", "[word]-fit", "[word]-friendly"
  // or "[word] opportunities" / "[word] opps" / "for [word]"
  let lens = null;
  const lensMatch1 = text.match(/\b([a-z][a-z0-9]+(?:\s[a-z][a-z0-9]+)?)-(?:ready|fit|friendly|focused)\b/);
  if (lensMatch1) {
    lens = lensMatch1[1];
  } else {
    // "5 opps for Salesforce" or "5 Splunk opps"
    const forMatch = text.match(/\bfor\s+([a-z][a-z0-9]+(?:\s+[a-z][a-z0-9]+)?)\s*(?:$|[?.!])/);
    if (forMatch) {
      const candidate = forMatch[1].trim();
      // Don't treat agency names as lenses, "5 opps for DHS" is a
      // scope, not a lens. The caller decides what to do with the
      // scope (pull fresh data).
      const commonAgencies = /^(dhs|dod|navy|army|air force|space force|hhs|va|treasury|doj|irs|nasa|usaf|dla|disa|dia|nsa|cia|state|doc|epa|fda|cms|nih|fbi|uscis|cbp|ice|tsa|uscg|occ)$/;
      if (!commonAgencies.test(candidate)) {
        lens = candidate;
      }
    }
  }

  return { count, lens };
}

// Select the top N records from the rows for the pipeline list. Priority:
//   1. Expiring within 90 days (urgency signal)
//   2. Expiring within 12 months (near-term recompetes)
//   3. Remaining top-value contracts if we still need more to hit N
// Sort within each tier by dollar value descending.
export function selectPipelineRecords(rows, count) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const now = Date.now();
  const in90 = now + 90 * 86400_000;
  const in365 = now + 365 * 86400_000;

  const tier1 = []; // expiring in 90d
  const tier2 = []; // expiring in 365d (excluding tier 1)
  const tier3 = []; // everything else, ranked by value

  for (const r of rows) {
    const amt = parseFloat(r['Award Amount']) || 0;
    const endTs = r._endTs;
    if (endTs > now && endTs <= in90) {
      tier1.push(r);
    } else if (endTs > in90 && endTs <= in365) {
      tier2.push(r);
    } else if (amt > 0) {
      tier3.push(r);
    }
  }

  // Sort each tier by dollar value descending
  const byValue = (a, b) => (parseFloat(b['Award Amount']) || 0) - (parseFloat(a['Award Amount']) || 0);
  tier1.sort(byValue);
  tier2.sort(byValue);
  tier3.sort(byValue);

  // Take from tier 1 first, then tier 2, then tier 3 to fill count
  const selected = [];
  for (const pool of [tier1, tier2, tier3]) {
    for (const r of pool) {
      if (selected.length >= count) break;
      selected.push(r);
    }
    if (selected.length >= count) break;
  }
  return selected;
}

// Shape a row into the record payload the Lambda expects.
function shapeRecordForInsights(r) {
  const now = Date.now();
  const endTs = r._endTs || 0;
  const daysLeft = endTs > now
    ? Math.max(0, Math.round((endTs - now) / 86400_000))
    : null;
  const endDate = endTs
    ? new Date(endTs).toISOString().slice(0, 10)
    : 'unknown';
  return {
    awardId: String(r['Award ID'] || ''),
    vendor: String(r['Recipient Name'] || 'Unknown'),
    amount: parseFloat(r['Award Amount']) || 0,
    endDate,
    daysLeft,
    office: String(
      r['Awarding Office']
      || r['Awarding Sub Agency']
      || r['Awarding Agency']
      || ''
    ),
    agency: String(r['Awarding Agency'] || ''),
    description: String(r['Description'] || '').slice(0, 240).replace(/\s+/g, ' ').trim(),
  };
}

// Call the Lambda for per-record insights. Real records in, insights
// keyed by Award ID out.
export async function fetchPipelineInsights({ records, lens, scope, endpoint }) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_type: 'fedmo_pipeline_insights',
      records,
      lens: lens || null,
      scope: scope || null,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Pipeline insights failed: ${res.status} ${body.slice(0, 120)}`);
  }
  return await res.json();
}

// Build the full pipeline-list output. Combines real records (from rows)
// with per-record insights (from Lambda) into a render-ready structure.
// This is what the browser actually displays.
export async function buildPipelineList({ rows, count, lens, scope, endpoint }) {
  const selected = selectPipelineRecords(rows, count);
  if (selected.length === 0) {
    return { items: [], intro: '', outro: '', noDataReason: 'no-rows' };
  }
  const records = selected.map(shapeRecordForInsights);

  let insights = {}, intro = '', outro = '', insightsFailed = false;
  try {
    const apiResult = await fetchPipelineInsights({ records, lens, scope, endpoint });
    insights = apiResult.insights || {};
    intro = apiResult.intro || '';
    outro = apiResult.outro || '';
  } catch (err) {
    console.warn('[pipeline] insight generation failed, using deterministic fallback:', err.message);
    insightsFailed = true;
    // Graceful degradation, when the Lambda insight call fails, produce
    // deterministic intro + outro text from the real records so the
    // seller still gets some framing instead of a raw list. Per-record
    // insights stay empty; the intro carries the load.
    const scopeLabel = scope || 'this slice';
    const hasLens = !!lens;
    const top = records[0];
    const expiringSoon = records.filter(r => r.daysLeft !== null && r.daysLeft <= 90).length;

    if (hasLens) {
      intro = `Alright, here's ${records.length} from ${scopeLabel}, screened for ${lens}. Expiring contracts first, then the heavy-dollar ones, that's where your time pays off.`;
    } else {
      intro = `Alright, here's ${records.length} from ${scopeLabel}. Expiring first, then biggest dollars. Work from the top.`;
    }

    if (top && expiringSoon > 0) {
      outro = `Start with #1, closest to recompete and the biggest move you can actually influence this quarter. Go.`;
    } else if (top) {
      outro = `Start with #1, biggest dollars on the page. Get in front of the PM before the recompete window opens.`;
    }
  }

  const items = records.map(r => ({
    record: r,
    insight: insights[r.awardId] || '', // empty string if Lambda didn't return one
  }));

  return { items, intro, outro, lens, scope, count: items.length, insightsFailed };
}

// ─────────────────────────────────────────────────────────────────────
// askMo, top-level orchestrator for one user turn
// ─────────────────────────────────────────────────────────────────────
//
// Handles both paths:
//   - Coaching/chat: Mo writes prose, no <data> tag, single stream
//   - Data-backed: Mo emits <data>, browser pauses, fetches, renders card,
//     fires second grounded stream
//
// render callbacks:
//   streamPreTagProse(text) , called with progressively-accumulating text
//                              BEFORE a <data> tag is detected. Caller
//                              renders markdown inline.
//   onDataTag(resolverInput), called when a <data> tag is detected but
//                              before the fetch fires. Caller should show
//                              a loading card. Return a reference that
//                              renderDataCard() will use.
//   renderDataCard(cardRef, rows, input) , called with the fetched rows.
//                                            Caller renders the actual card.
//   streamPostTagProse(text), called with Mo's grounded second pass prose.
//   renderError(msg)        , called on any failure.
//   complete()              , called when the whole turn is done.
// ─────────────────────────────────────────────────────────────────────

// Detect whether a user's current message is a TRUE refer-back to a
// prior turn (and therefore needs conversation history for context),
// vs a fresh, self-contained query that should run history-free.
//
// Why this matters: Flash Lite anchors HARD on conversation history.
// If a user spent 3 turns on Millennium subawards, then types "Show me
// CACI footprint at Navy", Flash Lite often emits a Millennium-subaward
// tag again because that's the dominant pattern in its context. The
// resulting tag ignores the user's actual fresh question.
//
// Sending history-free for fresh queries is the architectural fix:
// the model sees ONLY the user's current message and the system prompt,
// so it has nothing to anchor on but the message itself. For real
// refer-backs ("what about VA", "just Navy"), we still send history
// because the message would be unintelligible without it.
//
// Heuristic, returns true if the message looks like a refer-back:
//   - Short opener words: "what about", "how about", "and ", "just "
//   - Pronouns referring to prior context: "that", "those", "this", "them"
//   - Bare narrowing: just an agency/topic word, or starts with a comma/and
//   - Numeric refinement: "above $5M", "under 100K"
//
// Conservative on the false-positive side: when in doubt, treat as
// fresh. False negatives (treating a real follow-up as fresh) just mean
// Mo gets less context, she may ask for clarification. False positives
// (treating a fresh query as a follow-up) cause the bug we're fixing —
// Flash Lite anchors on stale context.
export function looksLikeFollowUp(question) {
  if (!question || typeof question !== 'string') return false;
  const q = question.trim().toLowerCase();
  if (q.length === 0) return false;

  // Pronoun reference patterns — strong refer-back signal at any length.
  // Check FIRST so short refer-backs like "show me their subs" are caught
  // before the verb-exemption branch returns false.
  if (/\b(their|those|that one|that prime|that vendor|that company|the same)\b/i.test(q)) {
    return true;
  }

  // Very short messages (< 5 words) without a verb are usually refer-backs:
  // "Navy", "VA", "expiring", "above $5M", "small business set-asides"
  const wordCount = q.split(/\s+/).length;
  if (wordCount <= 4) {
    // Exempt clear command verbs and identity/meta questions. "show me X",
    // "who subs for X", "who subawards to X", "who does X subaward to",
    // "who hires X", "who are you", "where are you", "help", "hi",
    // "thanks" are NOT refer-backs to prior data, they're fresh queries
    // (or conversational openers) that should not pull in stale context.
    // The subaward drill verbs ("who subawards", "who hires", "who does")
    // are specifically important: without them, 4-word subaward queries
    // like "who subawards to northrop" get misclassified as refer-backs,
    // which causes Mo to pull forward the previous turn's vendor and
    // emit a <data> tag for the wrong company entirely. Verified April
    // 2026 with the Northrop test case.
    if (/^(show|find|get|pull|tell|give|list|who's|whats|what's|i sell|i cover|i rep|i work|who subs|who subawards|who covers|who works|who competes|who hires|who does|who resells|who sells|who ships)/i.test(q)) {
      return false;
    }
    // Identity / meta / conversational greetings, all fresh
    if (/^(who are you|who made you|what are you|what can you do|where are you|how do you work|why|hi$|hello|hey$|thanks|thank you|help$|help me$|test|debug)/i.test(q)) {
      return false;
    }
    return true;
  }

  // Refer-back openers, first 1-3 words are the tell
  const referOpeners = [
    'what about', 'how about', 'and what', 'and how', 'and also',
    'same but', 'same with', 'same for', 'same thing',
    'that prime', 'that vendor', 'that agency', 'that one', 'that market',
    'those guys', 'those primes', 'these guys', 'this market',
    'just ', 'only ', 'narrow to', 'narrow it',
    'now show', 'now do', 'now pull', 'now tell',
    'instead', 'actually,', 'wait,',
    'back to', 'go back', 'switch to',
    'above $', 'under $', 'over $', 'below $',
    'expiring only', 'just expiring',
  ];
  for (const opener of referOpeners) {
    if (q.startsWith(opener)) return true;
  }

  // Otherwise, looks like a fresh, self-contained query
  return false;
}


export async function askMo({ question, history, activeCardSummary, endpoint, render }) {
  const abort = new AbortController();
  let cardRef = null;
  let dataTagSeen = false;
  let preTagText = ''; // text before the <data> tag (final, clean)

  // Debug trace, captured progressively through the turn so callers can
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

  // History decision: send conversation context ONLY when the user's
  // current message reads like a refer-back ("just Navy", "what about
  // VA", "those primes"). For fresh queries, full vendor+agency
  // statements, smart-pill clicks, new topics, send NO history. This
  // eliminates Flash Lite anchoring on prior tag patterns and dragging
  // forward stale vendor / topic / attribute values.
  //
  // Stash the decision in debug so the trace shows whether history was
  // sent or not, which makes anchoring failures diagnosable.
  const isFollowUp = looksLikeFollowUp(question);
  debug.historyMode = isFollowUp ? 'with-history' : 'fresh';
  const fullHistory = isFollowUp
    ? [...history, { role: 'user', content: question }]
    : [{ role: 'user', content: question }];

  // Prefetch window: the moment onChunk sees a complete <data> tag, we
  // can start the USASpending fetch in parallel with the stream-abort
  // handshake and any post-tag bookkeeping. This saves 100-300ms of
  // serialized wait on every straight-vendor/topic query.
  //
  // NOT safe to prefetch on:
  //   - competitors="true" turns. The fetch needs the expanded competitor
  //     list which comes from a separate Gemini call (fetchCompetitors).
  //     Pre-firing here would query the wrong slice.
  //   - subawards="true" turns. Different fetch (fetchSubawards), different
  //     URL, different payload shape. The prefetch function assumes prime-
  //     level queries.
  // On those paths, prefetchPromise stays null and the regular await at
  // the fetchUsaspending callsite runs as before.
  let prefetchPromise = null;
  let prefetchInput = null;

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
          // Full <data> tag detected, pause, pull data, fire second call
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

          // PARALLEL FETCH — start USASpending pull now, while the abort
          // handshake and downstream bookkeeping run. Only safe when the
          // tag doesn't require competitor expansion or subaward routing
          // (both need more work before the fetch can be issued). The
          // .catch here is defensive — we don't want an in-flight failure
          // to surface as an unhandled rejection before the main code
          // path reaches its try/catch. The real error handling happens
          // at the await site, which falls back to a fresh fetch if the
          // prefetch rejected.
          if (!resolverInput._competitors && !resolverInput._subawards) {
            prefetchInput = resolverInput;
            prefetchPromise = fetchUsaspending(resolverInput, endpoint)
              .catch(err => {
                // Store the error shape so the await site can re-throw it
                // consistently with the non-prefetch path.
                return { _prefetchError: err };
              });
          }

          // Abort the first stream, we don't want Mo's speculative
          // post-tag prose. We'll get grounded prose from the second call.
          abort.abort();

          // Stash resolverInput on cardRef for the later fetch
          if (cardRef) cardRef._resolverInput = resolverInput;
        } else if (tagInfo && tagInfo.pending) {
          // Partial tag, render only text before the partial start.
          // Avoids flashing "<data" to the user mid-stream.
          render.streamPreTagProse(accumulated.slice(0, tagInfo.partialIndex).trim());
        } else {
          // No tag yet, render everything we have
          render.streamPreTagProse(accumulated);
        }
      },
    }).catch(err => {
      // If we aborted intentionally (data tag seen), that's expected
      if (dataTagSeen && err.name === 'AbortError') return null;
      throw err;
    });

    if (!dataTagSeen) {
      // Coaching / conversational path, first pass WAS the whole answer
      // firstPassFull is the final text; render.streamPreTagProse already
      // got the cumulative version as it arrived
      render.complete(debug);
      debug.firstPassRaw = firstPassFull || preTagText;
      debug.mode = 'prose';

      // Fabrication check: in the prose-only path, Mo hasn't pulled any
      // data, so any Contract ID or specific dollar amount she cites is
      // fabricated. This is the exact failure mode where Mo produces
      // "5 DISA opportunities" with made-up Award IDs and values. Detect
      // and scrub. Federal sellers acting on fake contracts is a
      // catastrophic trust failure.
      const proseText = firstPassFull || preTagText || '';
      const idPattern = /\b[A-Z0-9]{10,20}\b/g;
      const suspiciousIds = [];
      let proseMatch;
      const seen = new Set();
      while ((proseMatch = idPattern.exec(proseText)) !== null) {
        const id = proseMatch[0].toUpperCase();
        if (seen.has(id)) continue;
        seen.add(id);
        // Must have both letters and digits to look like an Award ID
        if (!/\d/.test(id) || !/[A-Z]/.test(id)) continue;
        // Skip common non-award tokens (common words won't match 10+ chars all-caps)
        suspiciousIds.push(id);
      }

      if (suspiciousIds.length > 0) {
        console.warn('[askMo] Mo cited Award IDs in prose-only turn (no data pulled):', suspiciousIds);
        debug.fabricatedIds = suspiciousIds;
        debug.fabricatedProseOriginal = proseText;
        const correction = `To give you real contracts with real IDs and values, I need to pull the data. Tell me the scope, agency, vendor, topic, and I'll run it fresh. For instance: "5 DISA opps" becomes a scoped pull the moment you name the agency.`;
        debug.fabricationScrubbed = true;
        return { mode: 'prose', text: correction, debug };
      }

      return { mode: 'prose', text: proseText, debug };
    }

    // ── Data pull + second pass ─────────────────────────────────
    const resolverInput = cardRef._resolverInput;

    // Competitor mode: before fetching USASpending, call mo_competitors to
    // get the head-to-head competitors of the original vendor, then expand
    // resolverInput.vendors to [originalVendor, ...competitors]. The card
    // renders the combined footprint, seller + competitors in one view —
    // which is what the seller actually wants to see for "who are my
    // competitors" questions.
    let competitorInfo = null;
    if (resolverInput?._competitors && resolverInput?.vendor) {
      // Stash _sellerName up-front, we need it regardless of whether
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
        // tell Mo "this is a degraded competitor view, don't invent
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
    // with its own second stream, none of the prime-path logic below
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
        // Subaward data is legitimately sparse. Instead of rendering an
        // empty card and returning (which kills Mo's second-pass prose),
        // render a tiny "no data" state and let the second-pass fire
        // with the direction-aware summary so Mo can coach the user
        // toward the opposite direction or prime-level view.
        const vName = resolverInput?.vendor
          || (Array.isArray(resolverInput?.vendors) ? resolverInput.vendors[0] : null)
          || 'this vendor';
        const dir = resolverInput?._subawardDir === 'from' ? 'from' : 'to';
        const dirLabel = dir === 'to'
          ? `as a prime hiring subs`
          : `as a sub hired by primes`;
        // Render a simple "no data" panel in the card slot. Not an error,
        // not a scary banner — just honest framing plus a concrete next
        // move for the user. The flip-direction button uses the same
        // .mo-followup + data-ask pattern as inline followups so the
        // delegated click handler in oldmo.html picks it up for free.
        if (cardRef) {
          // Local HTML-escape helper. Stream-client rarely renders HTML
          // directly (oldmo.html owns that layer), so instead of adding
          // an import we keep this minimal escape inline.
          const esc = (s) => String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
          const flipAsk = dir === 'to'
            ? `Who subawards to ${vName}`
            : `Who does ${vName} subaward to`;
          const flipPrompt = dir === 'to'
            ? `primes hiring <strong>${esc(vName)}</strong> as a sub`
            : `the subs <strong>${esc(vName)}</strong> is hiring`;
          cardRef.innerHTML = `
            <div class="turn-mo-card" style="padding: 20px 22px;">
              <div class="mo-framing">
                No subaward records found for <strong>${esc(vName)}</strong> ${dirLabel} in the last 12 months. USASpending subaward reporting is sparse — mandatory only above $30K and lags the prime award by months, and classified contracts often don't report at all.
              </div>
              <div class="mo-direction-flip" style="margin-top:14px; padding:10px 12px; background:var(--surface-subtle, #f6f7f9); border-radius:8px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                <span style="font-size:13px; color:var(--text-body); line-height:1.4;">Want the other direction — ${flipPrompt}?</span>
                <button class="mo-followup" data-ask="${esc(flipAsk)}" style="font-size:13px; padding:6px 12px; flex-shrink:0;">Flip direction</button>
              </div>
            </div>
          `;
        }
        // (No chipData stash here — that's done by oldmo.html's turn
        // renderer for the happy path. For the no-data path, smart pills
        // still fire via the second-pass response; no manual stash
        // needed from this layer.)

        debug.mode = 'no_subaward_data';
        debug.fallbackType = 'no_data';
        debug.rowCountFinal = 0;

        // Fire Mo's second pass with the direction-aware summary so she
        // can add a sentence or two of strategic coaching beneath the
        // empty state. summarizeSubawardsForMo returns a direction-aware
        // instruction block when subs is empty.
        const noDataSummary = summarizeSubawardsForMo([], resolverInput);
        const historyForSecondCall = [
          ...fullHistory,
          { role: 'model', content: preTagText + '\n\n[no subaward data; see card]' },
        ];
        const secondAbort = new AbortController();
        await streamOnce({
          endpoint,
          history: historyForSecondCall,
          activeCardSummary,
          payloadSummary: noDataSummary,
          abortController: secondAbort,
          onChunk: (accumulated) => {
            const { cleaned, hasPartial } = stripDataTags(accumulated);
            if (hasPartial) return;
            render.streamPostTagProse(cleaned);
          },
        }).catch(err => {
          // Non-fatal; just skip the second pass if it errors out.
          console.warn('[askMo] second-pass on no_subaward_data failed:', err);
        });

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
          // Defensive: strip any <data> tags Mo may have echoed despite
          // the prompt forbidding it. Without this, raw markup leaks
          // into the rendered prose.
          const { cleaned, hasPartial } = stripDataTags(accumulated);
          if (hasPartial) return; // wait for next chunk to disambiguate
          render.streamPostTagProse(cleaned);
        },
      });

      render.complete(debug);
      debug.mode = 'subaward';
      return {
        mode: 'subaward',
        preTagText,
        subs,
        resolverInput,
        // Strip any leaked <data> tags from the historical record. The
        // raw stream is preserved in debug.secondPassRaw for diagnosis,
        // but Mo's conversation memory should reflect the cleaned prose
        // the user actually saw.
        postTagText: stripDataTags(secondPassFull).cleaned,
        debug,
      };
    }

    let rows;
    try {
      // If we pre-fired the fetch in onChunk (non-competitors, non-subawards
      // paths), reuse that in-flight promise instead of issuing a fresh
      // request. The prefetchPromise is guarded by resolverInput identity:
      // if competitor expansion mutated resolverInput after the prefetch
      // fired (which it shouldn't on this branch, but defensive), we fall
      // through to a fresh fetch.
      if (prefetchPromise && prefetchInput === resolverInput) {
        const prefetched = await prefetchPromise;
        if (prefetched && prefetched._prefetchError) {
          // Prefetch rejected, retry once with a fresh call. This preserves
          // the original error-reporting semantics.
          rows = await fetchUsaspending(resolverInput, endpoint);
        } else {
          rows = prefetched;
        }
      } else {
        rows = await fetchUsaspending(resolverInput, endpoint);
      }
    } catch (fetchErr) {
      console.error('[askMo] USASpending fetch failed:', fetchErr);
      render.renderError(`Couldn't pull that data. ${fetchErr.message || ''}`.trim());
      debug.mode = 'error';
      return { mode: 'error', error: fetchErr.message, debug };
    }

    debug.rowCountDirect = rows.length;

    // Expose mission-program fallback info so the UI trace and Mo's
    // second-pass prose can both reference it. "CISA" resolving to
    // "DHS toptier + CISA keyword" is real behavior, not an error —
    // USASpending files CISA under DHS OPO rather than as its own
    // awarding subtier. When the fallback fires, the user deserves a
    // one-line acknowledgment in prose ("USASpending files CISA
    // contracts under DHS.") instead of the illusion that we pulled
    // straight from an agency filter.
    if (rows._retriedFromSubtier) {
      debug.missionFallback = rows._retriedFromSubtier;
    }

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
    // contracts, clearly not endpoint security work. A seller reading
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
    // need this, a user asking about "SentinelOne at DHS" expects the
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
        // category word, "CROWDSTRIKE FALCON LICENSES" is clearly
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
    //       right move is not a blind agency-wide fallback, that got us
    //       the SentinelOne/border-wall embarrassment. Instead, bail out
    //       with mode='needs_qualifier' so Mo can ask the user what their
    //       product actually does. Better a useful question than wrong data.
    //
    //   (c) No vendor pitched, or vendor pitched federally (no agency) →
    //       current "truly empty" path. Nothing to fall back to.
    //
    // One retry max. If the category refire also returns empty, we fall
    // through to the qualifier path, can't recover further.
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
    // isn't the literal vendor pull the user asked for, it's the
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

    // Fire second stream, grounded interpretation
    const secondAbort = new AbortController();
    const secondPassFull = await streamOnce({
      endpoint,
      history: historyForSecondCall,
      activeCardSummary,
      payloadSummary: summary,
      abortController: secondAbort,
      onChunk: (accumulated) => {
        // Defensive: strip any <data> tags Mo may have echoed despite
        // the prompt forbidding it. Without this, raw markup leaks
        // into the rendered prose. See stripDataTags() for partial-tag
        // handling so the user never sees a half-rendered <da fragment.
        const { cleaned, hasPartial } = stripDataTags(accumulated);
        if (hasPartial) return; // wait for next chunk to disambiguate
        render.streamPostTagProse(cleaned);
      },
    });

    // Stash the raw second-pass for the trace panel. Debug readers need
    // to see BOTH the first-pass (that emitted the tag) AND the second-
    // pass (Mo's grounded prose on top of the card) to diagnose tone
    // drift or hallucination patterns.
    debug.secondPassRaw = secondPassFull || '';

    // ── Fabrication detection, multi-layered safety net ─────
    //
    // This is the last guard before Mo's prose reaches a beta partner.
    // It checks three failure modes:
    //
    //   (a) Award IDs cited that aren't in the real data
    //   (b) Dollar amounts cited that don't match any real row within 10%
    //       (also accepts the grand total and the top-3 aggregation)
    //   (c) Vendor-at-agency pairs cited that don't exist in the rows
    //       (skipped for now, too many false positives; revisit if beta
    //       users report it)
    //
    // Design principle: when a fabrication is caught, NEVER show a
    // confessional message ("I almost gave you fabricated data"). That
    // makes Mo sound broken in front of a skeptical federal seller.
    // Instead, substitute a short, professional observation that doesn't
    // reference the fabrication at all. The card speaks for itself.
    //
    // All real values come from the actual rows. The LLM-reported values
    // (in secondPassFull) are checked against these.
    const realAwardIds = new Set(
      rows.map(r => String(r['Award ID'] || '').toUpperCase()).filter(Boolean)
    );
    const realAmounts = rows.map(r => parseFloat(r['Award Amount']) || 0).filter(a => a > 0);
    const totalObligated = realAmounts.reduce((s, a) => s + a, 0);
    const top3Sum = realAmounts.slice().sort((a, b) => b - a).slice(0, 3).reduce((s, a) => s + a, 0);

    // Build a validated-amounts set with ±10% tolerance. Any prose-cited
    // amount within 10% of one of these is acceptable. This accounts for
    // Mo rounding ($249M Deloitte when the row shows $248.7M) and for
    // her citing aggregates like "the top three hold $420M."
    const validAmounts = [...realAmounts, totalObligated, top3Sum];

    // ── (a) Award ID check ─────────────────────────────────
    const idPattern = /\b[A-Z0-9]{10,20}\b/g;
    const citedIds = new Set();
    const fabricatedIds = [];
    let idMatch;
    while ((idMatch = idPattern.exec(secondPassFull || '')) !== null) {
      const id = idMatch[0].toUpperCase();
      if (citedIds.has(id)) continue;
      citedIds.add(id);
      if (!/\d/.test(id) || !/[A-Z]/.test(id)) continue;
      if (!realAwardIds.has(id)) {
        fabricatedIds.push(id);
      }
    }

    // ── (b) Dollar amount check ────────────────────────────
    // Match "$47M", "$47.5M", "$1.2B", "$850K", "$1,200,000", "$1.2 billion"
    // etc. Compare each to the real amounts with 10% tolerance.
    const dollarPattern = /\$\s?([\d,]+(?:\.\d+)?)\s*(billion|million|thousand|b|m|k)?\b/gi;
    const fabricatedAmounts = [];
    let dMatch;
    while ((dMatch = dollarPattern.exec(secondPassFull || '')) !== null) {
      const num = parseFloat(dMatch[1].replace(/,/g, ''));
      if (!Number.isFinite(num) || num === 0) continue;
      const unit = (dMatch[2] || '').toLowerCase();
      let value;
      if (unit === 'billion' || unit === 'b') value = num * 1e9;
      else if (unit === 'million' || unit === 'm') value = num * 1e6;
      else if (unit === 'thousand' || unit === 'k') value = num * 1e3;
      else if (num >= 1e6) value = num; // raw number, treat as dollars
      else continue; // too ambiguous (bare $5 could be anything); skip

      // Only flag amounts $100K and up. Anything smaller is either
      // colloquial ("$10 well spent") or below USASpending's signal.
      if (value < 100_000) continue;

      // Check against real amounts with 10% tolerance
      const tolerance = 0.10;
      const matched = validAmounts.some(real => {
        if (real === 0) return false;
        const diff = Math.abs(value - real) / real;
        return diff <= tolerance;
      });
      if (!matched) {
        fabricatedAmounts.push({ cited: dMatch[0], value });
      }
    }

    const anyFabrication = fabricatedIds.length > 0 || fabricatedAmounts.length > 0;

    if (anyFabrication) {
      console.warn('[askMo] Fabrication caught:', { ids: fabricatedIds, amounts: fabricatedAmounts });
      debug.fabricatedIds = fabricatedIds;
      debug.fabricatedAmounts = fabricatedAmounts;
      debug.fabricatedProseOriginal = secondPassFull;
      debug.fabricationScrubbed = true;

      // ── Silent scrub: substitute a short, professional observation ──
      //
      // The card already shows the real facts. Mo's second-pass prose
      // was supposed to add one non-obvious thing; she fabricated
      // instead. Replace her output with a tight deterministic line
      // that respects the user's intelligence and doesn't mention the
      // fabrication at all.
      //
      // The line is derived from real data: top prime + concentration.
      // No LLM, no second chance.
      const topVendorByAmt = [...rows]
        .sort((a, b) => (parseFloat(b['Award Amount']) || 0) - (parseFloat(a['Award Amount']) || 0))[0];
      const topName = topVendorByAmt?.['Recipient Name'] || null;
      const topShare = topVendorByAmt && totalObligated > 0
        ? Math.round(((parseFloat(topVendorByAmt['Award Amount']) || 0) / totalObligated) * 100)
        : 0;

      let scrubbed;
      if (topName && topShare >= 25) {
        scrubbed = `Look at the card, ${topName} is holding most of this. Your shortest path in is usually through them or the agency team they already work with. Going around an entrenched incumbent at this concentration gets expensive fast.`;
      } else if (topName) {
        scrubbed = `Good news on the card, no single dominant incumbent here, and that's rarer than you'd think. Means the door's actually open. Compete on capability rather than trying to displace a relationship.`;
      } else {
        scrubbed = `Card's in front of you. Pick the contract or office that matches what you sell and we'll go deeper on that one.`;
      }

      render.streamPostTagProse(scrubbed);
      render.complete(debug);
      debug.mode = 'data';
      return {
        mode: 'data',
        preTagText,
        rows,
        resolverInput,
        postTagText: scrubbed,
        debug,
      };
    }

    render.complete(debug);
    debug.mode = 'data';
    return {
      mode: 'data',
      preTagText,
      rows,
      resolverInput,
      // Strip any leaked <data> tags from the historical record. The
      // raw stream is preserved in debug.secondPassRaw for diagnosis,
      // but Mo's conversation memory should reflect the cleaned prose
      // the user actually saw.
      postTagText: stripDataTags(secondPassFull).cleaned,
      debug,
    };
  } catch (err) {
    console.error('[askMo] fatal:', err);
    render.renderError(err.message || 'Something went sideways.');
    debug.mode = 'error';
    return { mode: 'error', error: err.message, debug };
  }
}
