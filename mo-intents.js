// ============================================================================
// Mo Response Contract
// ============================================================================
//
// Every intent returns a response of this exact shape. The frontend renders
// every response identically regardless of which intent produced it — this is
// the "terminal for federal sales intelligence" discipline.
//
// The four visible sections are:
//   1. takeaway  — one-line call. Signal-dense, no hedging.
//   2. facts     — 3-6 scannable bullets of real USASpending data.
//   3. items     — OPTIONAL. When the intent has specific records to surface
//                  (contracts, vendors, offices), they appear here as a tight
//                  one-line-per-item list. Otherwise this is empty and the
//                  renderer skips the section.
//   4. meaning   — { classification, verify } — the interpretation layer.
//                  classification is a one-paragraph read of how the market
//                  behaves. verify is the "what you still need to verify"
//                  block — 2-4 bullet questions the seller must answer
//                  themselves before treating this as pipeline.
//   5. actions   — ordered by time horizon: now → 6-12mo → structural.
//                  1 action when signal is overwhelming, 3 when mixed.
//                  Every action starts with a verb. No "you could." No
//                  "consider." Direct calls only.
//   6. refine    — exactly 3 chips. Each is a complete editable query
//                  string. When the user clicks a chip, the input box is
//                  populated with the string — they can edit before
//                  submitting. No hidden state.
//
// Hidden control:
//   confidence: 'high' | 'mixed' | 'low'
//     High  → response.actions.length === 1 (one decisive call)
//     Mixed → response.actions.length === 3 (three plays)
//     Low   → response.actions.length === 3 but worded conditionally
//     The frontend never shows confidence; it just trusts action count.
//
// ============================================================================

/**
 * @typedef {object} MoResponse
 * @property {string} takeaway      One line. Signal-dense. The call.
 * @property {string[]} facts       Bullet points. Each is a complete clause.
 * @property {MoItem[]} [items]     Optional tight list of records.
 * @property {MoMeaning} meaning    Classification + verification layer.
 * @property {string[]} actions     1 or 3 actions, verb-first.
 * @property {string[]} refine      Exactly 3 chip queries. Editable strings.
 * @property {string} intent        Which intent produced this (for debug/analytics).
 * @property {'high'|'mixed'|'low'} confidence  Hidden tone driver.
 */

/**
 * @typedef {object} MoItem
 * One line per item. Kept tight on purpose — if seller wants more, they
 * drill in with a new query.
 * @property {string} primary       Bold lead. Usually vendor or agency name.
 * @property {string} amount        Formatted dollar string like "$15.6M".
 * @property {string} [context]     Office, location, or other middle context.
 * @property {string} [timing]      "10 days", "FY26 Q3", etc.
 * @property {string} [scope]       One-line scope summary.
 * @property {string} [awardId]     For linking to USASpending.
 */

/**
 * @typedef {object} MoMeaning
 * @property {string} classification   One paragraph. The market's behavior.
 * @property {string[]} verify         2-4 bullet questions the seller must
 *                                     answer themselves. Framed as "What you
 *                                     still need to verify:".
 * @property {string} [closer]         OPTIONAL one-line follow-up after the
 *                                     verify block. Often: "If not, this is
 *                                     not pipeline yet. It's a target list."
 */

// ============================================================================
// Intent registry
// ============================================================================
//
// The ten first-class intents. Every query routes to one of these. If none
// fits, Mo responds conversationally (falls back to prose).
// ============================================================================

export const INTENTS = {
  MARKET_SIZE:    'how-big',          // #1 How big is this market?
  WHO_WINNING:    'who-winning',      // #2 Who's winning?
  WHO_BUYS:       'who-buys',         // #3 Who actually writes the checks?
  EXPIRING:       'expiring',         // #4 What's expiring soon?
  EASY_ENTRIES:   'easy-entries',     // #5 Where are the easiest entries?
  DEAL_REAL:      'deal-real',        // #6 Is this a real opportunity?
  PARTNER_WITH:   'partner-with',     // #7 Who should I partner with?
  FOCUS_QUARTER:  'focus-quarter',    // #8 Where should I focus this quarter?
  WHY_LOSING:     'why-losing',       // #9 Why are we losing?
  WHAT_NEXT:      'what-next',        // #10 What should I do next?
};

// ============================================================================
// Classification rules — deterministic, applied after the data pull
// ============================================================================

/**
 * Classify a market's concentration from vendor share data.
 * Returns the exact label text that goes into meaning.classification's first sentence.
 *
 * @param {object[]} vendors  Array of { name, amount } sorted desc.
 * @param {number} totalAmount
 * @returns {{label: string, top3Share: number, vendorCount: number}}
 */
export function classifyMarket(vendors, totalAmount) {
  const n = vendors.length;
  const top3 = vendors.slice(0, 3).reduce((s, v) => s + (v.amount || 0), 0);
  const top3Share = totalAmount > 0 ? top3 / totalAmount : 0;
  const topSingle = vendors[0]?.amount || 0;
  const topShare = totalAmount > 0 ? topSingle / totalAmount : 0;

  let label;
  if (top3Share >= 0.70 || topShare >= 0.50) {
    label = 'Locked-in market';
  } else if (top3Share >= 0.45) {
    label = 'Entrenched, recompete-driven market';
  } else if (top3Share < 0.30 && n >= 20) {
    label = 'Fragmented market';
  } else {
    label = 'Mixed market';
  }
  return { label, top3Share, vendorCount: n };
}

/**
 * Decide confidence level — drives how many actions the response has and
 * tunes the voice. High = one decisive call. Mixed/Low = three plays.
 *
 * Signal factors (all bundled):
 *   - expiring volume vs noise floor
 *   - concentration extremity (very locked OR very fragmented = high signal)
 *   - data completeness (did we get rows back at all?)
 *
 * @param {object} signals  { rowCount, expiringCount, classification, hasClearRecompete }
 * @returns {'high'|'mixed'|'low'}
 */
export function scoreConfidence(signals) {
  const { rowCount = 0, expiringCount = 0, classification, hasClearRecompete } = signals;
  if (rowCount === 0) return 'low';
  if (rowCount < 5) return 'low';
  // High signal: clear classification AND meaningful pipeline
  if (hasClearRecompete && expiringCount >= 3 && classification?.label !== 'Mixed market') {
    return 'high';
  }
  // Low signal: not enough data to be decisive
  if (expiringCount === 0 && rowCount < 15) return 'low';
  return 'mixed';
}

// ============================================================================
// Helpers
// ============================================================================

export function money(amt) {
  if (amt == null || isNaN(amt)) return '$0';
  if (amt >= 1e9) return `$${(amt / 1e9).toFixed(1)}B`;
  if (amt >= 1e6) return `$${(amt / 1e6).toFixed(1)}M`;
  if (amt >= 1e3) return `$${(amt / 1e3).toFixed(0)}K`;
  return `$${amt.toFixed(0)}`;
}

export function daysUntil(endDateStr) {
  if (!endDateStr) return null;
  const end = new Date(endDateStr).getTime();
  if (isNaN(end)) return null;
  const now = Date.now();
  return Math.max(0, Math.round((end - now) / 86400_000));
}
