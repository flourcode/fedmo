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
  return input;
}

// Fetch head-to-head federal competitors for a vendor via the Lambda
// endpoint. Returns { vendor, category, competitors: [...] } or throws.
// Called by askMo() when a <data> tag has competitors="true".
export async function fetchCompetitors(vendorName, endpoint) {
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

  if (!res.ok) throw new Error(`API ${res.status}`);
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
// Build a payload summary for Mo's second (grounded) call
// ─────────────────────────────────────────────────────────────────────
//
// We don't pass the raw 100 rows back to Gemini — that's too verbose and
// wasteful. Instead, compact to the signals Mo needs for interpretation:
// total dollars, top 5 primes, agency breakdown, expiring count.
// ─────────────────────────────────────────────────────────────────────

export function summarizePayloadForMo(rows, resolverInput) {
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
    const sellerName = (resolverInput._competitorList?.length ? null : null);
    const seller = (resolverInput.vendors && Array.isArray(resolverInput.vendors))
      ? resolverInput.vendors[0] : '';
    const category = resolverInput._competitorCategory || '';
    framing = `
THIS IS A COMPETITOR CUT.
Seller: ${seller}
Category: ${category}
Competitors in this pull: ${resolverInput._competitorList.join(', ')}
Your job: tell the seller who's winning and losing in THEIR category. Identify which vendors in the top primes are the seller (${seller}) vs. their competitors. Call out share, positioning, and where each player is strongest. If the seller isn't in the top primes, say so honestly and describe the competitive landscape they're trying to break into.`;
  }

  return `Query: ${queryDesc || '(no filters)'}${framing}
Total (top ${rows.length} contracts, last 12mo): $${(total / 1_000_000).toFixed(1)}M
Unique primes in slice: ${primeMap.size}
Top 3 concentration: ${top3Pct}%
Top primes:
${topPrimes.map(p => '  - ' + p).join('\n')}
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
        if (dataTagSeen) return; // already handled, ignore further chunks

        const tagInfo = findDataTag(accumulated);

        if (tagInfo && !tagInfo.pending) {
          // Full <data> tag detected — pause, pull data, fire second call
          dataTagSeen = true;
          preTagText = accumulated.slice(0, tagInfo.index).trim();

          // Render everything up to the tag as final prose
          render.streamPreTagProse(preTagText);

          // Kick off the data fetch asynchronously; we'll await it below
          // after aborting the first stream
          const resolverInput = dataAttrsToResolverInput(tagInfo.attrs);
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
      return { mode: 'prose', text: firstPassFull || preTagText };
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
      try {
        competitorInfo = await fetchCompetitors(resolverInput.vendor, endpoint);
        // Build multi-vendor input: keep the original vendor AND add each
        // competitor. Drop the singular `vendor` field in favor of the array.
        const combined = [resolverInput.vendor, ...(competitorInfo.competitors || [])];
        delete resolverInput.vendor;
        resolverInput.vendors = combined;
        // Stash the competitor metadata so the renderer and payload
        // summarizer can label the card appropriately.
        resolverInput._competitorCategory = competitorInfo.category;
        resolverInput._competitorList = competitorInfo.competitors;
      } catch (compErr) {
        console.warn('[askMo] competitor lookup failed, falling back to single-vendor card:', compErr.message);
        // Fall through with the original single-vendor input. The card
        // will still render, just without competitors.
      }
    }

    let rows;
    try {
      rows = await fetchUsaspending(resolverInput, endpoint);
    } catch (fetchErr) {
      console.error('[askMo] USASpending fetch failed:', fetchErr);
      render.renderError(`Couldn't pull that data. ${fetchErr.message || ''}`.trim());
      return { mode: 'error', error: fetchErr.message };
    }

    // Render the real card
    render.renderDataCard(cardRef, rows, resolverInput);

    // Build a payload summary for Mo's grounded interpretation
    const summary = summarizePayloadForMo(rows, resolverInput);

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
    return {
      mode: 'data',
      preTagText,
      rows,
      resolverInput,
      postTagText: secondPassFull,
    };
  } catch (err) {
    console.error('[askMo] fatal:', err);
    render.renderError(err.message || 'Something went sideways.');
    return { mode: 'error', error: err.message };
  }
}
