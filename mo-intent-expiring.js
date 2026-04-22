// ============================================================================
// Mo Intent — Expiring ("What's expiring?")
// ============================================================================
//
// Input: parsed query { agency, vendor, topic, window }
//   where window is '90d' | '180d' | '12mo' (default '12mo')
//
// Output: MoResponse
//
// Data flow:
//   1. Build USASpending /search/spending_by_award query for awards with
//      Period of Performance End Date in the window
//   2. Compute classification from vendor concentration
//   3. Compute confidence from row count + signal strength
//   4. Assemble the 6-section response
//
// This file is the template. The other nine intents follow the same pattern:
//   fetch → classify → score → assemble → return.
// ============================================================================

import { classifyMarket, scoreConfidence, money, daysUntil } from './mo-intents.js';

/**
 * Build the response for the Expiring intent.
 *
 * @param {object} query
 * @param {string} [query.agency]       Agency name, already resolved
 * @param {string} [query.vendor]       Vendor name, already resolved
 * @param {string} [query.topic]        Topic keyword (e.g. "cyber")
 * @param {'90d'|'180d'|'12mo'} [query.window='12mo']
 * @param {object} context
 * @param {function} context.fetchAwards  Client for USASpending awards search
 * @returns {Promise<MoResponse>}
 */
export async function runExpiringIntent(query, { fetchAwards }) {
  const window = query.window || '12mo';
  const label = buildSliceLabel(query);
  const windowLabel = WINDOW_LABELS[window];

  // Pull expiring awards in the window. We need more than enough rows to
  // classify (100 is plenty for any single agency+topic slice).
  const { rows, rowCount } = await fetchAwards({
    agency: query.agency,
    vendor: query.vendor,
    topic: query.topic,
    endAfter: 'today',
    endBefore: windowEndDate(window),
    limit: 100,
    sortBy: 'award_amount_desc',
  });

  // Empty-state — no data for this slice
  if (rowCount === 0) {
    return emptyResponse(label, windowLabel, query);
  }

  // Bucket by window — 90d, 90-180d, 180-365d
  const now = Date.now();
  const day = 86400_000;
  const in90 = rows.filter(r => daysUntil(r.endDate) !== null && daysUntil(r.endDate) <= 90);
  const in180 = rows.filter(r => {
    const d = daysUntil(r.endDate);
    return d !== null && d > 90 && d <= 180;
  });
  const in365 = rows.filter(r => {
    const d = daysUntil(r.endDate);
    return d !== null && d > 180 && d <= 365;
  });

  // Aggregate vendor share across ALL expiring rows in the window
  const vendorMap = new Map();
  for (const r of rows) {
    const name = r.vendor || 'Unknown';
    vendorMap.set(name, (vendorMap.get(name) || 0) + (r.amount || 0));
  }
  const vendors = [...vendorMap.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
  const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);

  // Office concentration
  const officeMap = new Map();
  for (const r of rows) {
    const name = r.office || r.subAgency || 'Unknown';
    const cur = officeMap.get(name) || { amount: 0, count: 0 };
    cur.amount += (r.amount || 0);
    cur.count += 1;
    officeMap.set(name, cur);
  }
  const topOffice = [...officeMap.entries()]
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => b.amount - a.amount)[0];

  const classification = classifyMarket(vendors, totalAmount);
  const hasClearRecompete = in180.length >= 2 || in365.length >= 3;
  const confidence = scoreConfidence({
    rowCount,
    expiringCount: rows.length,
    classification,
    hasClearRecompete,
  });

  // ── Assemble the response ──────────────────────────────────────────

  // 1. Takeaway — one line, signal-dense
  const takeaway = buildTakeaway({
    totalAmount,
    rowCount: rows.length,
    windowLabel,
    label,
    in90Count: in90.length,
    in90Amount: in90.reduce((s, r) => s + (r.amount || 0), 0),
  });

  // 2. Facts — 4-6 scannable bullets
  const facts = buildFacts({
    in90, in180, in365,
    vendors,
    topOffice,
    totalAmount,
  });

  // 3. Items — top 3 expiring in the nearest window that has content
  const items = buildItems({ in90, in180, in365 });

  // 4. Meaning — classification + verification
  const meaning = buildMeaning({ classification, query });

  // 5. Actions — 1 if high confidence, 3 otherwise, ordered by time horizon
  const actions = buildActions({
    confidence,
    in90, in180, in365,
    vendors,
    classification,
    label,
  });

  // 6. Refine — exactly 3 chips, each a complete editable query
  const refine = buildRefine({ query, label });

  return {
    intent: 'expiring',
    takeaway,
    facts,
    items,
    meaning,
    actions,
    refine,
    confidence,
  };
}

// ============================================================================
// Section builders
// ============================================================================

function buildTakeaway({ totalAmount, rowCount, windowLabel, label, in90Count, in90Amount }) {
  if (in90Count > 0) {
    return `${money(totalAmount)} in ${label} is turning over in the ${windowLabel} across ${rowCount} contracts. ${money(in90Amount)} hits in the next 90 days.`;
  }
  return `${money(totalAmount)} in ${label} is turning over in the ${windowLabel} across ${rowCount} contracts. Nothing hits in the next 90 days — this is a position-now market.`;
}

function buildFacts({ in90, in180, in365, vendors, topOffice, totalAmount }) {
  const facts = [];
  const in90Amt = in90.reduce((s, r) => s + (r.amount || 0), 0);
  const in180Amt = in180.reduce((s, r) => s + (r.amount || 0), 0);
  const in365Amt = in365.reduce((s, r) => s + (r.amount || 0), 0);

  if (in90.length > 0) facts.push(`${in90.length} contracts (${money(in90Amt)}) expire in the next 90 days`);
  if (in180.length > 0) facts.push(`${in180.length} contracts (${money(in180Amt)}) expire in 90 to 180 days`);
  if (in365.length > 0) facts.push(`${in365.length} contracts (${money(in365Amt)}) expire in 6 to 12 months`);

  const top3 = vendors.slice(0, 3);
  if (top3.length >= 2) {
    const formatted = top3.map(v => `${prettyName(v.name)} (${money(v.amount)})`).join(', ');
    facts.push(`Top incumbents: ${formatted}`);
  }

  if (topOffice && topOffice.count >= 3) {
    const officePct = Math.round((topOffice.amount / totalAmount) * 100);
    facts.push(`${prettyName(topOffice.name)} controls ${money(topOffice.amount)} across ${topOffice.count} expiring contracts (${officePct}% of expiring value)`);
  }

  return facts;
}

function buildItems({ in90, in180, in365 }) {
  // Show top 3 from the nearest non-empty bucket. That's the most urgent
  // thing the seller should see first.
  let pool = in90.length > 0 ? in90 : (in180.length > 0 ? in180 : in365);
  pool = [...pool].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 3);

  return pool.map(r => ({
    primary: prettyName(r.vendor || 'Unknown'),
    amount: money(r.amount || 0),
    context: prettyName(r.office || r.subAgency || ''),
    timing: formatTiming(r),
    scope: (r.scope || '').slice(0, 120).replace(/\s+/g, ' ').trim(),
    awardId: r.awardId || '',
  }));
}

function buildMeaning({ classification, query }) {
  // Classification paragraph — one decisive read of how the market behaves.
  let classText;
  switch (classification.label) {
    case 'Locked-in market':
      classText = `Locked-in market. The top vendors hold the work and it does not turn. Direct displacement almost never works; your entry is through the incumbents, not against them.`;
      break;
    case 'Entrenched, recompete-driven market':
      classText = `Entrenched, recompete-driven market. Top vendors hold meaningful share but not enough to lock it. Real movement happens on recompetes, where programs can run full competitions instead of bridge extensions.`;
      break;
    case 'Fragmented market':
      classText = `Fragmented market. No single vendor dominates. This is your highest-probability entry — task orders here are smaller and more competitive.`;
      break;
    default:
      classText = `Mixed market. Some concentration at the top but real room underneath. Pick your entry by office, not by going after the biggest incumbent.`;
  }

  // Verification layer — what the seller must confirm themselves.
  const verify = [
    'Do you have access to the contract vehicle?',
    'Do you have a relationship with the program office?',
    'Is there active demand behind the recompete?',
  ];

  return {
    classification: classText,
    verify,
    closer: `If not, this is not pipeline yet. It's a target list.`,
  };
}

function buildActions({ confidence, in90, in180, in365, vendors, classification, label }) {
  // High confidence: one decisive call.
  if (confidence === 'high') {
    const target = in180[0] || in365[0];
    if (target) {
      return [
        `Target ${prettyName(target.vendor)} ${money(target.amount)} at ${prettyName(target.office || target.subAgency)}. ${daysUntil(target.endDate)} days out — you have time to influence the recompete.`,
      ];
    }
  }

  // Mixed/low: three actions, ordered by time horizon.
  const actions = [];

  // Action 1: this quarter
  if (in90.length === 0) {
    actions.push(`Skip the next 90 days. Nothing here is workable that fast.`);
  } else {
    actions.push(`Ignore the 90-day window unless you already have access. Those are closing or bridging — you're late.`);
  }

  // Action 2: 6-12 months (the real window)
  const recompeteTargets = [...in180, ...in365].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 2);
  if (recompeteTargets.length >= 2) {
    const names = recompeteTargets.map(r => {
      const office = prettyName(r.office || r.subAgency || '');
      return `${prettyName(r.vendor)} ${money(r.amount)}${office ? ' at ' + office : ''}`;
    }).join(' and ');
    actions.push(`Focus on the 6 to 12 month contracts. Start with ${names}. These have time to influence.`);
  } else if (recompeteTargets.length === 1) {
    const r = recompeteTargets[0];
    actions.push(`Focus on ${prettyName(r.vendor)} ${money(r.amount)} at ${prettyName(r.office || r.subAgency)}. That's the one real recompete window.`);
  } else {
    actions.push(`No real recompete targets in the 6-12 month window. Work adjacent slices.`);
  }

  // Action 3: structural — the partner/vehicle move
  const top3Names = vendors.slice(0, 3).map(v => prettyName(v.name)).join(', ');
  if (classification.label === 'Fragmented market') {
    actions.push(`Go direct. This market is fragmented enough that partnering through a prime dilutes your margin without improving your win rate.`);
  } else {
    actions.push(`Lock a partner with vehicle access now. ${top3Names} already control most of it. Pick one by past performance at your target office.`);
  }

  return actions;
}

function buildRefine({ query, label }) {
  const chips = [];
  const base = [
    query.topic,
    query.agency && !query.agency.toLowerCase().includes('cisa') ? 'CISA' : null,
  ].filter(Boolean).join(' ');

  // Chip 1: narrower agency/office — swap to a specific sub-agency if we have one
  if (query.agency && query.agency.toLowerCase() === 'dhs') {
    chips.push(`${query.topic || 'contracts'} at CISA expiring next 12 months`);
  } else if (query.agency && query.agency.toLowerCase() === 'dod') {
    chips.push(`${query.topic || 'contracts'} at DISA expiring next 12 months`);
  } else {
    chips.push(`${label} expiring in next 90 days`);
  }

  // Chip 2: size filter
  chips.push(`${label} expiring under $50M`);

  // Chip 3: winner focus
  chips.push(`who's winning recompetes in ${label}`);

  return chips.slice(0, 3);
}

// ============================================================================
// Empty state
// ============================================================================

function emptyResponse(label, windowLabel, query) {
  return {
    intent: 'expiring',
    takeaway: `Nothing in ${label} is showing expiration in the ${windowLabel}.`,
    facts: [
      `Zero contracts matched your slice`,
      `The query pulled from USASpending with end-date in the ${windowLabel}`,
    ],
    items: [],
    meaning: {
      classification: `No expiring activity here. That either means the market doesn't turn often, your slice is too narrow, or USASpending hasn't caught up to recent modifications.`,
      verify: [
        'Is your agency filter correct?',
        'Is your topic keyword matching how the contracts are described?',
        'Have you checked the broader agency (drop the topic filter)?',
      ],
      closer: null,
    },
    actions: [
      `Broaden the query. Drop the topic or open up the agency filter.`,
    ],
    refine: [
      query.topic ? `${label.replace(query.topic, '').trim()} expiring next 12 months` : `who's winning in ${label}`,
      query.agency ? `${query.topic || 'contracts'} across federal expiring next 12 months` : `${label} expiring in next 18 months`,
      `who's winning in ${label}`,
    ].slice(0, 3),
    confidence: 'low',
  };
}

// ============================================================================
// Small utilities
// ============================================================================

const WINDOW_LABELS = {
  '90d': 'next 90 days',
  '180d': 'next 6 months',
  '12mo': 'next 12 months',
};

function windowEndDate(window) {
  const now = new Date();
  const days = window === '90d' ? 90 : window === '180d' ? 180 : 365;
  const end = new Date(now.getTime() + days * 86400_000);
  return end.toISOString().slice(0, 10);
}

function buildSliceLabel(query) {
  const parts = [];
  if (query.agency) parts.push(query.agency);
  if (query.topic) parts.push(query.topic);
  if (query.vendor) parts.push(query.vendor);
  return parts.length ? parts.join(' ') : 'federal contracts';
}

function prettyName(raw) {
  if (!raw) return '';
  // Collapse ALLCAPS vendor names to Title Case — USASpending returns them
  // in all caps which looks like yelling. Keep acronyms intact (2-4 letters).
  const words = String(raw).split(/\s+/);
  return words.map(w => {
    if (w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
    if (/^(LLC|INC|CORP|CO|LP|LTD)\.?$/i.test(w)) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    if (w === w.toUpperCase()) return w.charAt(0) + w.slice(1).toLowerCase();
    return w;
  }).join(' ');
}

function formatTiming(r) {
  const d = daysUntil(r.endDate);
  if (d === null) return '';
  if (d === 0) return 'ends today';
  if (d === 1) return '1 day';
  if (d < 90) return `${d} days`;
  if (d < 180) return `${Math.round(d / 30)} months`;
  return `~${Math.round(d / 30)} months`;
}
