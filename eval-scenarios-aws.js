// ============================================================================
// eval-scenarios-aws.js — AWS Director of Startups demo readiness scenarios
// ============================================================================
//
// Tests Mo's combined fedmo + EDGAR capabilities through realistic queries an
// AWS Director of Startups would actually run. Eight clusters, ~35 scenarios.
//
// Assertion shape:
//   { kind, msg, check }
//   kind = 'hard' (product bug if fails) | 'soft' (Gemini drift acceptable)
//   check = (snapshot) => boolean
//
// Snapshot shape (what `check` receives):
//   {
//     question,            // the user's raw input
//     responseText,         // full Mo response body (post-stream)
//     tag,                  // the matched <data /> tag string
//     attrs,                // parsed tag attributes
//     mode,                 // 'edgar' | 'usaspending' | 'prose' | 'error'
//     edgarResult,          // raw EDGAR response if a follow-up data pull ran
//     usaSpendingResult,    // raw USASpending response if a follow-up ran
//     latencyMs,            // total time for Mo's first-pass response
//     dataPullMs,           // time for the data pull (if it ran)
//   }
// ============================================================================

// ── Assertion helpers ──────────────────────────────────────────────
const hasTag       = ()           => (s) => !!s.tag;
const noTag        = ()           => (s) => !s.tag;
const tagAttr      = (k, v)       => (s) => {
  if (!s.attrs) return false;
  if (v == null) return k in s.attrs;
  return String(s.attrs[k] || '').toLowerCase() === String(v).toLowerCase();
};
const tagAttrLike  = (k, regex)   => (s) => s.attrs && regex.test(String(s.attrs[k] || ''));
const tagHasAny    = (...keys)    => (s) => s.attrs && keys.some(k => k in s.attrs);
const modeIs       = (m)          => (s) => s.mode === m;
const proseIncludes = (needle)    => (s) => (s.responseText || '').toLowerCase().includes(String(needle).toLowerCase());
const proseLacks   = (needle)     => (s) => !(s.responseText || '').toLowerCase().includes(String(needle).toLowerCase());
const dateAfterIsRecent = (maxDaysOld) => (s) => {
  // Asserts date_after is within N days of today, OR no date_after at all
  const v = s.attrs?.date_after;
  if (!v) return true; // no date filter is fine for some queries
  const target = new Date(v + 'T00:00:00Z');
  const now = new Date();
  const diff = (now - target) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= maxDaysOld;
};
const edgarReturnedSomething = () => (s) => s.edgarResult && s.edgarResult.total > 0;
const usaSpendingReturnedSomething = () => (s) => s.usaSpendingResult && (s.usaSpendingResult.results || []).length > 0;

// ── Scenarios ──────────────────────────────────────────────────────

export const SCENARIOS = [
  // ════════════════════════════════════════════════════════════════════
  // CLUSTER 1: PRIVATE RAISES — the Form D headline use case
  // ════════════════════════════════════════════════════════════════════

  {
    name: '1.1  Big AI raises (>$20M, last 30 days)',
    description: 'Headline demo query. Mo emits Form D + AI sector + min_amount, EDGAR returns recent filings.',
    cluster: 'Private Raises',
    turns: [{
      question: 'Big AI raises above $20M in the last 30 days',
      followUp: 'edgar',
      assertions: [
        { kind: 'hard', msg: 'emits a tag',                                    check: hasTag() },
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'sector=AI',                                      check: tagAttr('sector', 'AI') },
        { kind: 'hard', msg: 'min_amount set to >=20M',                        check: (s) => Number(s.attrs?.min_amount) >= 20000000 },
        { kind: 'hard', msg: 'date_after within last 30 days',                 check: dateAfterIsRecent(35) },
        { kind: 'soft', msg: 'EDGAR returns matching filings',                 check: edgarReturnedSomething() },
      ],
    }],
  },

  {
    name: '1.2  Anthropic recent raises',
    description: 'Company-specific Form D query. Should NOT emit federal_adjacent (that is for sector-wide cross-references).',
    cluster: 'Private Raises',
    turns: [{
      question: 'Has Anthropic raised lately?',
      followUp: 'edgar',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'company=Anthropic',                              check: tagAttr('company', 'Anthropic') },
        { kind: 'hard', msg: 'date_after present (Mo defaults to recency)',    check: tagAttr('date_after') },
        { kind: 'hard', msg: 'date_after is recent (<= 365 days old)',         check: dateAfterIsRecent(380) },
        { kind: 'hard', msg: 'NO federal_adjacent (single-company query)',      check: (s) => !s.attrs?.federal_adjacent || s.attrs.federal_adjacent === 'false' },
      ],
    }],
  },

  {
    name: '1.3  Cybersecurity Form Ds, last 90 days',
    description: 'Sector + recent date.',
    cluster: 'Private Raises',
    turns: [{
      question: 'Cybersecurity Form Ds last 90 days',
      followUp: 'edgar',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'sector=cybersecurity',                            check: tagAttrLike('sector', /cyber/i) },
        { kind: 'hard', msg: 'date_after within last 95 days',                 check: dateAfterIsRecent(95) },
      ],
    }],
  },

  {
    name: '1.4  Climate raises this year',
    description: 'Sector + date phrase resolution to current year start.',
    cluster: 'Private Raises',
    turns: [{
      question: 'Climate companies that raised this year',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'sector=climate',                                  check: tagAttrLike('sector', /climate/i) },
        { kind: 'hard', msg: 'date_after is YYYY-01-01 of this year',          check: tagAttrLike('date_after', /^\d{4}-01-01$/) },
      ],
    }],
  },

  {
    name: '1.5  Biotech raises >$50M in 2025',
    description: 'Sector + min_amount + explicit year window.',
    cluster: 'Private Raises',
    turns: [{
      question: 'Biotech raises above $50M in 2025',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'sector=biotech',                                  check: tagAttrLike('sector', /bio/i) },
        { kind: 'hard', msg: 'min_amount=50000000',                             check: (s) => Number(s.attrs?.min_amount) >= 50000000 },
        { kind: 'hard', msg: 'date_after=2025-01-01',                           check: tagAttr('date_after', '2025-01-01') },
        { kind: 'soft', msg: 'date_before=2025-12-31',                          check: tagAttr('date_before', '2025-12-31') },
      ],
    }],
  },

  {
    name: '1.6  Stripe filings',
    description: 'Single named private company.',
    cluster: 'Private Raises',
    turns: [{
      question: 'Show me Stripe filings',
      assertions: [
        { kind: 'hard', msg: 'form_type=D (default for filings)',              check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'company=Stripe',                                 check: tagAttr('company', 'Stripe') },
      ],
    }],
  },

  // ════════════════════════════════════════════════════════════════════
  // CLUSTER 2: SPV DETECTION
  // ════════════════════════════════════════════════════════════════════

  {
    name: '2.1  SPVs targeting Anthropic',
    description: 'Should emit spv_only flag, company-specific.',
    cluster: 'SPV Detection',
    turns: [{
      question: 'SPVs targeting Anthropic',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'company=Anthropic',                              check: tagAttr('company', 'Anthropic') },
        { kind: 'hard', msg: 'spv_only=true',                                  check: tagAttr('spv_only', 'true') },
      ],
    }],
  },

  {
    name: '2.2  Recent SPVs for OpenAI',
    description: 'Variation in phrasing — "filed for X recently".',
    cluster: 'SPV Detection',
    turns: [{
      question: 'Are there any SPVs filed for OpenAI recently?',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'company=OpenAI',                                 check: tagAttrLike('company', /openai/i) },
        { kind: 'hard', msg: 'spv_only=true',                                  check: tagAttr('spv_only', 'true') },
      ],
    }],
  },

  {
    name: '2.3  SPVs for xAI',
    description: 'Lesser-known target company.',
    cluster: 'SPV Detection',
    turns: [{
      question: 'Show me SPVs for xAI',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'company=xAI',                                    check: tagAttrLike('company', /xai/i) },
        { kind: 'hard', msg: 'spv_only=true',                                  check: tagAttr('spv_only', 'true') },
      ],
    }],
  },

  // ════════════════════════════════════════════════════════════════════
  // CLUSTER 3: INSIDER & PUBLIC FILINGS (Form 4, 13F, 13D/G)
  // ════════════════════════════════════════════════════════════════════

  {
    name: '3.1  CrowdStrike insider selling, 90 days',
    description: 'Form 4. Verifies EDGAR returns real insider trade data through search-index.',
    cluster: 'Insider & Public',
    turns: [{
      question: 'Insider selling at CrowdStrike past 90 days',
      followUp: 'edgar',
      assertions: [
        { kind: 'hard', msg: 'form_type=4',                                    check: tagAttr('form_type', '4') },
        { kind: 'hard', msg: 'company=CrowdStrike',                            check: tagAttrLike('company', /crowdstrike/i) },
        { kind: 'hard', msg: 'date_after recent (last ~95 days)',              check: dateAfterIsRecent(95) },
        { kind: 'soft', msg: 'EDGAR returns Form 4 hits',                       check: edgarReturnedSomething() },
      ],
    }],
  },

  {
    name: '3.2  NVDA insider activity',
    description: 'Ticker as company input.',
    cluster: 'Insider & Public',
    turns: [{
      question: 'NVDA insider activity',
      assertions: [
        { kind: 'hard', msg: 'form_type=4',                                    check: tagAttr('form_type', '4') },
        { kind: 'hard', msg: 'company=NVDA or NVIDIA',                          check: tagAttrLike('company', /nvda|nvidia/i) },
      ],
    }],
  },

  {
    name: '3.3  Tiger Global 13F',
    description: 'Institutional investor filing.',
    cluster: 'Insider & Public',
    turns: [{
      question: "Tiger Global's latest 13F",
      assertions: [
        { kind: 'hard', msg: 'form_type=13F or similar',                       check: tagAttrLike('form_type', /13F/i) },
        { kind: 'hard', msg: 'company=Tiger Global',                           check: tagAttrLike('company', /tiger global/i) },
      ],
    }],
  },

  {
    name: '3.4  13D filings on AI companies',
    description: 'Activist stake disclosures, sector-wide.',
    cluster: 'Insider & Public',
    turns: [{
      question: '13D filings on AI companies',
      assertions: [
        { kind: 'hard', msg: 'form_type=13D or SC 13D',                        check: tagAttrLike('form_type', /13D/i) },
        { kind: 'hard', msg: 'sector=AI',                                      check: tagAttrLike('sector', /^ai$/i) },
      ],
    }],
  },

  // ════════════════════════════════════════════════════════════════════
  // CLUSTER 4: IPO WATCH (S-1)
  // ════════════════════════════════════════════════════════════════════

  {
    name: '4.1  S-1 filings in cybersecurity',
    description: 'IPO registration watch by sector.',
    cluster: 'IPO Watch',
    turns: [{
      question: 'Recent S-1 filings in cybersecurity',
      followUp: 'edgar',
      assertions: [
        { kind: 'hard', msg: 'form_type=S-1',                                  check: tagAttrLike('form_type', /s-?1/i) },
        { kind: 'hard', msg: 'sector=cybersecurity',                            check: tagAttrLike('sector', /cyber/i) },
        { kind: 'hard', msg: 'date_after present',                              check: tagAttr('date_after') },
        { kind: 'soft', msg: 'EDGAR returns S-1 hits',                          check: edgarReturnedSomething() },
      ],
    }],
  },

  {
    name: '4.2  AI companies that filed for IPO',
    description: 'Sector-wide S-1.',
    cluster: 'IPO Watch',
    turns: [{
      question: 'AI companies that filed for IPO',
      assertions: [
        { kind: 'hard', msg: 'form_type=S-1',                                  check: tagAttrLike('form_type', /s-?1/i) },
        { kind: 'hard', msg: 'sector=AI',                                      check: tagAttrLike('sector', /^ai$/i) },
      ],
    }],
  },

  // ════════════════════════════════════════════════════════════════════
  // CLUSTER 5: FEDERAL-ADJACENT (the killer differentiator)
  // ════════════════════════════════════════════════════════════════════

  {
    name: '5.1  AI raises this quarter that sell to fed',
    description: 'THE KILLER QUERY. Sector-wide Form D filtered to federal-adjacent issuers. No commercial database can answer this.',
    cluster: 'Federal-Adjacent (Killer)',
    turns: [{
      question: 'AI startups that raised this quarter and have federal contracts',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'sector=AI',                                      check: tagAttrLike('sector', /^ai$/i) },
        { kind: 'hard', msg: 'federal_adjacent=true',                          check: tagAttr('federal_adjacent', 'true') },
        { kind: 'hard', msg: 'date_after present (recency for "this quarter")', check: tagAttr('date_after') },
      ],
    }],
  },

  {
    name: '5.2  Cyber raises + federal contracts',
    description: 'Same shape, different sector.',
    cluster: 'Federal-Adjacent (Killer)',
    turns: [{
      question: 'Cyber companies with federal contracts AND recent raises',
      assertions: [
        { kind: 'hard', msg: 'form_type=D',                                    check: tagAttr('form_type', 'D') },
        { kind: 'hard', msg: 'sector=cybersecurity',                            check: tagAttrLike('sector', /cyber/i) },
        { kind: 'hard', msg: 'federal_adjacent=true',                          check: tagAttr('federal_adjacent', 'true') },
      ],
    }],
  },

  {
    name: '5.3  AI startups raising AND on SEWP V',
    description: 'A more specific cross-reference. Realistic AWS-director question.',
    cluster: 'Federal-Adjacent (Killer)',
    turns: [{
      question: 'Are there AI companies that just raised and are on SEWP V?',
      assertions: [
        { kind: 'hard', msg: 'emits an EDGAR tag (cross-reference)',           check: (s) => !!s.attrs?.form_type },
        { kind: 'soft', msg: 'sector=AI',                                      check: tagAttrLike('sector', /^ai$/i) },
        { kind: 'soft', msg: 'federal_adjacent=true OR mentions SEWP in prose', check: (s) => s.attrs?.federal_adjacent === 'true' || /sewp/i.test(s.responseText || '') },
      ],
    }],
  },

  // ════════════════════════════════════════════════════════════════════
  // CLUSTER 6: CROSS-MODE PIVOT (USASpending + EDGAR in one chat)
  // ════════════════════════════════════════════════════════════════════

  {
    name: '6.1  Carahsoft contracts at HHS',
    description: 'Classic USASpending query. Verifies fedmo-classic still works.',
    cluster: 'Cross-Mode Pivot',
    turns: [{
      question: 'Carahsoft contracts at HHS',
      followUp: 'usaspending',
      assertions: [
        { kind: 'hard', msg: 'NO form_type (USASpending mode)',                check: (s) => !s.attrs?.form_type },
        { kind: 'hard', msg: 'recipient=Carahsoft',                            check: tagAttrLike('recipient', /carahsoft/i) },
        { kind: 'hard', msg: 'agency=HHS',                                     check: tagAttrLike('agency', /health|hhs/i) },
        { kind: 'soft', msg: 'USASpending returns rows',                        check: usaSpendingReturnedSomething() },
      ],
    }],
  },

  {
    name: '6.2  Anthropic federal footprint',
    description: 'Single-company federal contract lookup. CRITICAL: should be USASpending, NOT EDGAR with federal_adjacent.',
    cluster: 'Cross-Mode Pivot',
    turns: [{
      question: "What's Anthropic's federal footprint?",
      assertions: [
        { kind: 'hard', msg: 'NO form_type (USASpending mode)',                check: (s) => !s.attrs?.form_type },
        { kind: 'hard', msg: 'recipient=Anthropic',                            check: tagAttrLike('recipient', /anthropic/i) },
        { kind: 'hard', msg: 'NO federal_adjacent (wrong tool)',                check: (s) => !s.attrs?.federal_adjacent },
      ],
    }],
  },

  {
    name: '6.3  AWS at DoD (classic seller-pitch)',
    description: 'Verifies aliases injection still happens.',
    cluster: 'Cross-Mode Pivot',
    turns: [{
      question: 'AWS at Department of Defense',
      assertions: [
        { kind: 'hard', msg: 'NO form_type (USASpending mode)',                check: (s) => !s.attrs?.form_type },
        { kind: 'hard', msg: 'recipient=Amazon Web Services',                  check: tagAttrLike('recipient', /amazon/i) },
        { kind: 'hard', msg: 'agency=DoD/Defense',                             check: tagAttrLike('agency', /defense|dod/i) },
        { kind: 'soft', msg: 'aliases attribute set',                           check: tagAttr('aliases') },
      ],
    }],
  },

  {
    name: '6.4  Multi-turn pivot: federal then capital',
    description: 'Conversation moves from USASpending to EDGAR mid-chat. Mo must not drag prior context.',
    cluster: 'Cross-Mode Pivot',
    turns: [
      {
        question: 'AWS at Department of Defense',
        assertions: [
          { kind: 'hard', msg: 'first turn: USASpending tag',                  check: (s) => !s.attrs?.form_type && tagAttrLike('recipient', /amazon/i)(s) },
        ],
      },
      {
        question: 'Now show me AI startups that raised this quarter',
        assertions: [
          { kind: 'hard', msg: 'second turn: switches to EDGAR',                check: tagAttr('form_type', 'D') },
          { kind: 'hard', msg: 'second turn: sector=AI',                       check: tagAttrLike('sector', /^ai$/i) },
          { kind: 'hard', msg: 'second turn: NO recipient leak from prior',    check: (s) => !s.attrs?.recipient },
          { kind: 'hard', msg: 'second turn: NO agency leak from prior',        check: (s) => !s.attrs?.agency },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  // CLUSTER 7: HONEST-LIMIT (Mo handles requests gracefully)
  // ════════════════════════════════════════════════════════════════════

  {
    name: '7.1  Anthropic valuation',
    description: 'Form D does not contain valuation. Mo should still pull the Form D (offering amount is the closest proxy) AND mention that valuation is not a Form D field.',
    cluster: 'Honest Limits',
    turns: [{
      question: "What's Anthropic's valuation?",
      assertions: [
        { kind: 'soft', msg: 'either emits Form D tag (with caveat) OR explains in prose', check: (s) => s.attrs?.form_type === 'D' || /not a form d field|not in form d|not disclosed|valuation isn/i.test(s.responseText || '') },
        { kind: 'hard', msg: 'response is non-trivially long',                  check: (s) => (s.responseText || '').length > 100 },
      ],
    }],
  },

  {
    name: '7.2  OpenAI investor names',
    description: 'Investor names are NOT in Form D. Mo should explain that and offer alternatives (13F, news).',
    cluster: 'Honest Limits',
    turns: [{
      question: "Who invested in OpenAI's last round?",
      assertions: [
        { kind: 'soft', msg: 'mentions 13F OR news OR not in Form D',          check: (s) => /13.?f|news|not (in|a) form d|not required|not disclosed/i.test(s.responseText || '') },
        { kind: 'hard', msg: 'response is non-trivially long',                  check: (s) => (s.responseText || '').length > 100 },
      ],
    }],
  },

  {
    name: '7.3  Definition: what is a Form D',
    description: 'Educational question — pure prose, no tag.',
    cluster: 'Honest Limits',
    turns: [{
      question: "What's a Form D?",
      assertions: [
        { kind: 'hard', msg: 'no tag emitted (educational)',                    check: noTag() },
        { kind: 'soft', msg: 'mentions private offering or capital',            check: (s) => /private|offering|capital|fundrais/i.test(s.responseText || '') },
        { kind: 'hard', msg: 'response is substantive',                         check: (s) => (s.responseText || '').length > 200 },
      ],
    }],
  },

  // ════════════════════════════════════════════════════════════════════
  // CLUSTER 8: CLASSIC FEDMO REGRESSION (don't break what worked)
  // ════════════════════════════════════════════════════════════════════

  {
    name: '8.1  ITES-3S task orders past 90 days',
    description: 'Vehicle query. Tests that vehicle attribute is emitted; client overrides date floor to 2020-01-01.',
    cluster: 'Classic Regression',
    turns: [{
      question: 'ITES-3S task orders past 90 days',
      assertions: [
        { kind: 'hard', msg: 'NO form_type (USASpending mode)',                check: (s) => !s.attrs?.form_type },
        { kind: 'hard', msg: 'vehicle=ITES-3S',                                check: tagAttrLike('vehicle', /ites/i) },
      ],
    }],
  },

  {
    name: '8.2  Top vendors on SEWP V',
    description: 'Vehicle aggregate query.',
    cluster: 'Classic Regression',
    turns: [{
      question: 'Top vendors on SEWP V',
      assertions: [
        { kind: 'hard', msg: 'NO form_type',                                   check: (s) => !s.attrs?.form_type },
        { kind: 'hard', msg: 'vehicle=SEWP V',                                 check: tagAttrLike('vehicle', /sewp/i) },
      ],
    }],
  },

  {
    name: '8.3  Smallest Booz Allen contracts',
    description: 'Reverse-sort query. Tests sort=amount-asc emission.',
    cluster: 'Classic Regression',
    turns: [{
      question: 'Smallest Booz Allen contracts',
      assertions: [
        { kind: 'hard', msg: 'recipient=Booz Allen',                           check: tagAttrLike('recipient', /booz/i) },
        { kind: 'hard', msg: 'sort=amount-asc',                                check: tagAttr('sort', 'amount-asc') },
      ],
    }],
  },

  {
    name: '8.4  HHS cloud awards FY26',
    description: 'Original demo query. Agency + NAICS + keyword.',
    cluster: 'Classic Regression',
    turns: [{
      question: 'Show me FY26 cloud awards at HHS',
      assertions: [
        { kind: 'hard', msg: 'NO form_type',                                   check: (s) => !s.attrs?.form_type },
        { kind: 'hard', msg: 'agency=HHS',                                     check: tagAttrLike('agency', /health|hhs/i) },
        { kind: 'soft', msg: 'has cloud-relevant naics or keywords',            check: (s) => s.attrs?.naics || /cloud/i.test(JSON.stringify(s.attrs || {})) },
        { kind: 'soft', msg: 'date_after=2025-10-01 (FY26 start)',             check: tagAttr('since', '2025-10-01') },
      ],
    }],
  },
];
