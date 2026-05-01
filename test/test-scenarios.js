// ============================================================================
// test-scenarios.js — automated test cases for minimo
// ============================================================================
//
// Each scenario is one user message + a set of assertions about what should
// happen. Two assertion kinds:
//   - hard: product bug if it fails (red)
//   - soft: Gemini drift is acceptable (yellow)
//
// The test runner posts the question to the Lambda, parses Mo's emitted
// <data ... /> tag, runs the USASpending pull with those attrs, and gives
// each assertion a snapshot to check:
//   {
//     question,          // string user typed
//     tagAttrs,          // {agency, recipient, naics, keywords, since, until, ...}
//     resolved,          // {recipientName, directFilters, baseFilters, ...}
//     rows,              // array of USASpending rows
//     rowCount,          // rows.length
//     total,             // sum of Award Amount
//     proseBefore,       // Mo's text before the <data> tag
//     proseAfter,        // Mo's text after the <data> tag
//     error,             // any thrown error
//     timings,           // {lambdaMs, usaspendingMs, totalMs}
//   }
//
// Scenarios run in order. Reproducibility scenarios run the SAME question
// twice in fresh contexts and compare results — Gemini non-determinism
// is the bug we're guarding against.

// ── Assertion helpers ──────────────────────────────────────────────────────

const tagHas = (key, expected) => (s) => {
  if (!s.tagAttrs) return false;
  const actual = s.tagAttrs[key];
  if (expected === undefined) return key in s.tagAttrs;  // just check presence
  if (expected === null) return !(key in s.tagAttrs);    // check absence
  if (typeof expected === 'string') return String(actual || '') === expected;
  if (expected instanceof RegExp) return expected.test(String(actual || ''));
  return actual === expected;
};

const tagAbsent = (key) => (s) => !s.tagAttrs || !(key in s.tagAttrs);

const tagAttrIncludes = (key, substr) => (s) => {
  if (!s.tagAttrs) return false;
  return String(s.tagAttrs[key] || '').toLowerCase().includes(substr.toLowerCase());
};

const rowsAtLeast = (n) => (s) => s.rowCount >= n;
const rowsAtMost = (n) => (s) => s.rowCount <= n;
const rowsBetween = (lo, hi) => (s) => s.rowCount >= lo && s.rowCount <= hi;

const totalAtLeast = (dollars) => (s) => s.total >= dollars;
const totalAtMost = (dollars) => (s) => s.total <= dollars;

const proseLacks = (needle) => (s) => {
  const combined = ((s.proseBefore || '') + ' ' + (s.proseAfter || '')).toLowerCase();
  return !combined.includes(needle.toLowerCase());
};

const proseContains = (needle) => (s) => {
  const combined = ((s.proseBefore || '') + ' ' + (s.proseAfter || '')).toLowerCase();
  return combined.includes(needle.toLowerCase());
};

// Check a row matches a predicate (used for IGT/vehicle assertions)
const someRowMatches = (pred) => (s) => (s.rows || []).some(pred);

// ── Scenarios ─────────────────────────────────────────────────────────────

export const SCENARIOS = [

  // ── Smoke tests: the four greeting pills ──────────────────────────────
  {
    name: 'Pill 1: cloud at HHS',
    question: 'Show me FY26 cloud awards at HHS',
    tags: ['smoke', 'pill', 'cloud'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Health and Human Services/), msg: 'agency = HHS' },
      { kind: 'hard', check: tagHas('keywords', 'cloud'), msg: 'keywords = "cloud" exactly (no synonym expansion)' },
      { kind: 'hard', check: tagHas('naics', '541512,541519,541511,541513'), msg: 'naics = canonical IT services bundle' },
      { kind: 'hard', check: tagAbsent('psc'), msg: 'psc must NOT be present (Fix 1: capability queries don\'t mix in PSC)' },
      { kind: 'hard', check: tagHas('since', '2025-10-01'), msg: 'since = FY26 floor' },
      { kind: 'hard', check: tagHas('until', '2026-09-30'), msg: 'until = FY26 ceiling' },
      { kind: 'hard', check: rowsAtLeast(20), msg: 'at least 20 rows returned' },
      { kind: 'hard', check: totalAtLeast(400e6), msg: 'total at least $400M' },
    ],
  },

  {
    name: 'Pill 2: cyber at DoD',
    question: 'Show me cyber opps at DoD',
    tags: ['smoke', 'pill', 'cyber'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Defense/), msg: 'agency = DoD' },
      { kind: 'hard', check: tagHas('keywords', 'cybersecurity'), msg: 'keywords = "cybersecurity" exactly' },
      { kind: 'hard', check: tagHas('naics', '541512,541519'), msg: 'naics = canonical cyber bundle' },
      { kind: 'hard', check: tagAbsent('psc'), msg: 'no PSC mixed in' },
      { kind: 'hard', check: rowsAtLeast(15), msg: 'at least 15 rows' },
      { kind: 'hard', check: totalAtLeast(400e6), msg: 'total at least $400M' },
    ],
  },

  {
    name: 'Pill 3: who resells AWS',
    question: 'Who resells AWS',
    tags: ['smoke', 'pill', 'vendor'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Amazon/), msg: 'recipient resolves to Amazon entity' },
      { kind: 'hard', check: rowsAtLeast(30), msg: 'at least 30 reseller rows' },
      { kind: 'hard', check: totalAtLeast(500e6), msg: 'total at least $500M' },
    ],
  },

  {
    name: 'Pill 4: what is a NAICS (educational, no card)',
    question: 'What is a NAICS',
    tags: ['smoke', 'pill', 'educational'],
    assertions: [
      // Educational query — Mo should respond in prose without emitting a card tag.
      // If she does emit a tag, it'd query something nonsense.
      { kind: 'soft', check: (s) => !s.tagAttrs || Object.keys(s.tagAttrs).length === 0, msg: 'no <data> tag emitted (or empty tag)' },
      { kind: 'hard', check: proseContains('naics'), msg: 'prose explains NAICS' },
    ],
  },

  // ── Reproducibility tests (Fix 1 from this session) ─────────────────────
  // These don't run twice automatically — the runner detects scenarios with
  // `reproduce: true` and runs them twice in fresh contexts, comparing the
  // tag attrs and totals between runs.
  {
    name: 'Reproducibility: cloud at HHS (Fix 1)',
    question: 'Show me FY26 cloud awards at HHS',
    tags: ['reproducibility', 'fix1'],
    reproduce: true,
    assertions: [
      // The runner injects an extra "consistency" assertion that compares run 1 vs run 2.
      { kind: 'hard', check: tagAbsent('psc'), msg: 'no PSC across both runs' },
      { kind: 'hard', check: (s) => /^cloud$/i.test(s.tagAttrs?.keywords || ''), msg: 'keywords stays exactly "cloud" both runs' },
    ],
  },

  {
    name: 'Reproducibility: cyber at DoD (Fix 1)',
    question: 'Show me cyber opps at DoD',
    tags: ['reproducibility', 'fix1'],
    reproduce: true,
    assertions: [
      { kind: 'hard', check: tagAbsent('psc'), msg: 'no PSC across both runs' },
      { kind: 'hard', check: (s) => /^cybersecurity$/i.test(s.tagAttrs?.keywords || ''), msg: 'keywords stays exactly "cybersecurity"' },
    ],
  },

  // ── Vehicle queries (Fix 3 from this session) ───────────────────────────
  {
    name: 'Vehicle: SEWP V (no agency filter)',
    question: 'Who\'s on SEWP V',
    tags: ['fix3', 'vehicle'],
    assertions: [
      { kind: 'hard', check: tagAbsent('agency'), msg: 'NO agency filter (vehicles cross all agencies)' },
      { kind: 'hard', check: tagAttrIncludes('keywords', 'SEWP'), msg: 'keywords includes SEWP' },
      { kind: 'hard', check: rowsAtLeast(8), msg: 'at least 8 rows across many agencies' },
      { kind: 'soft', check: (s) => {
        const agencies = new Set((s.rows || []).map(r => r['Awarding Agency']).filter(Boolean));
        return agencies.size >= 4;
      }, msg: 'rows span at least 4 different agencies' },
    ],
  },

  {
    name: 'Vehicle: JWCC',
    question: 'JWCC awards',
    tags: ['fix3', 'vehicle'],
    assertions: [
      { kind: 'hard', check: tagAttrIncludes('keywords', 'JWCC'), msg: 'keywords includes JWCC' },
      { kind: 'hard', check: rowsAtLeast(10), msg: 'at least 10 JWCC rows' },
      { kind: 'hard', check: totalAtLeast(150e6), msg: 'total at least $150M' },
      { kind: 'soft', check: someRowMatches(r => /HC1047|HC105023/.test(r['Award ID'] || '')),
        msg: 'at least one row has JWCC contract prefix HC1047 or HC105023' },
    ],
  },

  {
    name: 'Vehicle: OASIS+',
    question: 'Show me OASIS+ task orders',
    tags: ['fix3', 'vehicle'],
    assertions: [
      { kind: 'hard', check: tagAttrIncludes('keywords', 'OASIS'), msg: 'keywords includes OASIS' },
      { kind: 'hard', check: rowsAtLeast(5), msg: 'at least 5 rows' },
    ],
  },

  // ── Expiry queries (Fix 2 from this session) ────────────────────────────
  {
    name: 'Expiry: NAVSEA (no expiry-keyword stuffing)',
    question: 'What\'s expiring at NAVSEA in 90 days',
    tags: ['fix2', 'expiry'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Navy/), msg: 'agency = Navy' },
      { kind: 'hard', check: tagAttrIncludes('keywords', 'NAVSEA'), msg: 'keywords includes NAVSEA' },
      { kind: 'hard', check: (s) => {
        const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
        return !kw.includes('expir');  // catches both "expiring" and "expiration"
      }, msg: 'keywords must NOT contain "expiring" or "expiration" (card auto-flags)' },
      // NAVSEA terms appear in awarding_office, not description text — the
      // production client drops keywords and retries agency-only when 0 rows.
      // Test runner mirrors this fallback, so rows come from the agency-only retry.
      { kind: 'hard', check: (s) => s.rowCount >= 5 || s.keywordsDropped,
        msg: 'at least 5 rows returned (or keyword-drop fallback fired — expected for NAVSEA)' },
    ],
  },

  {
    name: 'Expiry: HHS in 90 days',
    question: 'What\'s expiring at HHS in 90 days',
    tags: ['fix2', 'expiry'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Health and Human Services/), msg: 'agency = HHS' },
      { kind: 'hard', check: (s) => !String(s.tagAttrs?.keywords || '').toLowerCase().includes('expir'),
        msg: 'no expiry keyword stuffing' },
      { kind: 'hard', check: rowsAtLeast(20), msg: 'at least 20 rows' },
    ],
  },

  // ── IGT detection (this session's UI fix) ───────────────────────────────
  // Note: IGT detection lives in minimo.html — these tests just verify the
  // underlying query returns rows where IGT detection would fire.
  {
    name: 'IGT: NAVSEA scope surfaces ENERGY DEPT row',
    question: 'NAVSEA',
    tags: ['igt', 'corner-case'],
    assertions: [
      // NAVSEA keyword returns 0 from USASpending description search; production
      // and test runner both fall back to agency-only (Department of the Navy).
      // The Naval Reactors IGT row (ENERGY, DEPARTMENT OF) surfaces in that set.
      { kind: 'soft', check: (s) => s.rowCount > 0, msg: 'rows returned (via keyword-drop fallback to Navy agency)' },
      { kind: 'soft', check: someRowMatches(r => /DEPARTMENT OF/i.test(r['Recipient Name'] || '')),
        msg: 'at least one row has government-entity recipient (Naval Reactors row)' },
    ],
  },

  // ── Pivot vs refine (history cap from prior sessions) ───────────────────
  {
    name: 'Pivot: AWS at DoD then NASA textiles',
    question: 'Show me textile suppliers at NASA',
    tags: ['pivot', 'history'],
    history: [
      { role: 'user', parts: [{ text: 'Show me AWS at DoD past year' }] },
      { role: 'model', parts: [{ text: 'AWS shows up across DoD primarily through resellers...' }] },
    ],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /National Aeronautics/), msg: 'agency = NASA (pivot worked)' },
      { kind: 'hard', check: (s) => {
        const r = String(s.tagAttrs?.recipient || '').toLowerCase();
        return !r.includes('amazon') && !r.includes('aws');
      }, msg: 'AWS did NOT bleed into the NASA pivot' },
      { kind: 'soft', check: proseLacks('aws'), msg: 'Mo\'s prose doesn\'t mention AWS' },
    ],
  },

  // ── Vendor disambiguation ───────────────────────────────────────────────
  {
    name: 'Vendor alias: Booz Allen at HHS',
    question: 'Booz Allen at HHS',
    tags: ['vendor', 'alias'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Booz Allen/), msg: 'recipient = Booz Allen' },
      { kind: 'hard', check: tagHas('agency', /Health and Human Services/), msg: 'agency = HHS' },
      { kind: 'hard', check: rowsAtLeast(10), msg: 'at least 10 rows' },
    ],
  },

  {
    name: 'Vendor alias: SAIC at Air Force (subtier)',
    question: 'SAIC at Air Force',
    tags: ['vendor', 'alias', 'subtier'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /SAIC/), msg: 'recipient = SAIC' },
      { kind: 'hard', check: tagHas('agency', /Air Force/), msg: 'agency = Air Force' },
      { kind: 'hard', check: rowsAtLeast(10), msg: 'at least 10 rows' },
    ],
  },

  // ── Voice / tone ────────────────────────────────────────────────────────
  // Spot checks for the explicit ban list.
  {
    name: 'Voice: cyber at DoD lacks negative phrases',
    question: 'Show me cyber opps at DoD',
    tags: ['voice', 'tone'],
    assertions: [
      { kind: 'hard', check: proseLacks('just noise'), msg: 'no "just noise"' },
      { kind: 'hard', check: proseLacks('wasting your time'), msg: 'no "wasting your time"' },
      { kind: 'hard', check: proseLacks('too late'), msg: 'no "too late"' },
      { kind: 'hard', check: proseLacks('don\'t bother'), msg: 'no "don\'t bother"' },
      { kind: 'hard', check: proseLacks('stop trying'), msg: 'no "stop trying"' },
    ],
  },

  // ── Fallback chips ──────────────────────────────────────────────────────
  {
    name: 'Fallback: Pure Storage at NSA (cascading agency drop)',
    question: 'Pure Storage at NSA',
    tags: ['fallback', 'corner-case'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Pure Storage/), msg: 'recipient = Pure Storage' },
      // Either we got results at NSA, or the fallback fired and dropped the agency.
      { kind: 'soft', check: (s) => s.rowCount > 0 || s.resolved?.agencyDropped,
        msg: 'either results at NSA OR fallback dropped agency (resolved.agencyDropped set)' },
    ],
  },

  {
    name: 'Fallback: Splunk at Federal Reserve',
    question: 'Splunk at the Federal Reserve',
    tags: ['fallback', 'corner-case'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Splunk/), msg: 'recipient = Splunk' },
      { kind: 'soft', check: (s) => s.rowCount > 0 || s.resolved?.agencyDropped,
        msg: 'either results OR fallback fired' },
    ],
  },

  // ── Empty / unresolvable ────────────────────────────────────────────────
  {
    name: 'Empty: bogus vendor name',
    question: 'foobarbaz fake company contracts',
    tags: ['empty', 'corner-case'],
    assertions: [
      { kind: 'hard', check: (s) => s.rowCount === 0, msg: 'returns 0 rows' },
      { kind: 'soft', check: (s) => !s.error, msg: 'no thrown error (graceful empty)' },
    ],
  },

  // ── Program offices (prompt section) ────────────────────────────────────
  {
    name: 'Program office: DARPA AI',
    question: 'DARPA AI awards',
    tags: ['program-office'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Defense/), msg: 'agency = DoD (parent of DARPA)' },
      { kind: 'hard', check: tagAttrIncludes('keywords', 'DARPA'), msg: 'keywords includes DARPA' },
      { kind: 'hard', check: rowsAtLeast(20), msg: 'at least 20 rows' },
    ],
  },

  {
    name: 'Program office: AFLCMC cyber',
    question: 'AFLCMC cyber',
    tags: ['program-office'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Air Force/), msg: 'agency = Air Force (parent of AFLCMC)' },
      { kind: 'hard', check: tagAttrIncludes('keywords', 'AFLCMC'), msg: 'keywords includes AFLCMC' },
    ],
  },
  // ── AWS seller persona ──────────────────────────────────────────────────
  {
    name: 'AWS: Who resells AWS at DoD',
    question: 'Who resells AWS at DoD',
    tags: ['seller', 'aws', 'reseller'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Amazon/i), msg: 'recipient = Amazon (not "AWS" alone — denylist collision)' },
      { kind: 'hard', check: tagHas('agency', /Defense/i), msg: 'agency = DoD' },
      { kind: 'hard', check: rowsAtLeast(10), msg: 'at least 10 rows' },
      { kind: 'hard', check: totalAtLeast(100e6), msg: 'total at least $100M' },
    ],
  },

  {
    name: 'AWS: JWCC vehicle query (no agency filter)',
    question: 'Show me JWCC awards',
    tags: ['seller', 'aws', 'vehicle'],
    assertions: [
      { kind: 'hard', check: tagAbsent('agency'), msg: 'no agency filter — JWCC spans all agencies' },
      { kind: 'hard', check: tagAttrIncludes('keywords', 'JWCC'), msg: 'keywords includes JWCC' },
      { kind: 'hard', check: rowsAtLeast(5), msg: 'at least 5 rows' },
    ],
  },

  {
    name: 'AWS: cloud at Space Force',
    question: 'Show me cloud at Space Force',
    tags: ['seller', 'aws', 'space-force'],
    assertions: [
      { kind: 'hard', check: (s) => tagHas('agency', /Space Force/i)(s) || tagHas('agency', /Air Force/i)(s), msg: 'agency = Space Force or Air Force (Space Force is subtier under AF)' },
      { kind: 'hard', check: tagAttrIncludes('keywords', 'cloud'), msg: 'keywords includes cloud' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'AWS: IC community (agencyDropped expected)',
    question: 'AWS at IC community',
    tags: ['seller', 'aws', 'fallback'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Amazon/i), msg: 'recipient = Amazon' },
      { kind: 'soft', check: (s) => s.rowCount > 0 || s.resolved?.agencyDropped,
        msg: 'either rows returned OR agencyDropped fired (IC not a USASpending agency)' },
    ],
  },

  // ── Microsoft seller persona ────────────────────────────────────────────
  {
    name: 'Microsoft: M365 at Army',
    question: 'Show me M365 at Army',
    tags: ['seller', 'microsoft', 'alias'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Microsoft/i), msg: 'recipient = Microsoft (M365 alias resolves to MICROSOFT CORPORATION)' },
      { kind: 'hard', check: tagHas('agency', /Army/i), msg: 'agency = Army (subtier)' },
      { kind: 'hard', check: rowsAtLeast(5), msg: 'at least 5 rows' },
    ],
  },

  {
    name: 'Microsoft: Azure at HHS',
    question: 'Azure at HHS',
    tags: ['seller', 'microsoft', 'alias'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Microsoft/i), msg: 'recipient = Microsoft (Azure alias resolves to MICROSOFT CORPORATION)' },
      { kind: 'hard', check: tagHas('agency', /Health and Human Services/i), msg: 'agency = HHS' },
      { kind: 'hard', check: rowsAtLeast(5), msg: 'at least 5 rows' },
    ],
  },

  {
    name: 'Microsoft: Defender at Air Force',
    question: 'Defender at Air Force',
    tags: ['seller', 'microsoft', 'alias'],
    assertions: [
      { kind: 'soft', check: tagHas('recipient', /Microsoft/i), msg: 'recipient = Microsoft (Defender alias)' },
      { kind: 'hard', check: tagHas('agency', /Air Force/i), msg: 'agency = Air Force' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'Microsoft: Sentinel SIEM at CISA',
    question: 'Microsoft Sentinel SIEM at CISA',
    tags: ['seller', 'microsoft', 'cisa'],
    assertions: [
      { kind: 'soft', check: tagHas('recipient', /Microsoft/i), msg: 'recipient = Microsoft' },
      { kind: 'hard', check: tagHas('agency', /Homeland Security|CISA|Cybersecurity/i), msg: 'agency = DHS or CISA' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  // ── Atlassian seller persona ────────────────────────────────────────────
  {
    name: 'Atlassian: Atlassian at DoD (reseller-only play)',
    question: 'Atlassian at DoD',
    tags: ['seller', 'atlassian', 'reseller'],
    assertions: [
      // Atlassian never primes — aliases path catches Carahsoft task orders
      { kind: 'soft', check: (s) => {
          const aliases = String(s.tagAttrs?.aliases || '').toLowerCase();
          return aliases.includes('jira') || aliases.includes('confluence') || aliases.includes('atlassian');
        }, msg: 'aliases includes Jira/Confluence/Atlassian so keyword path fires' },
      { kind: 'hard', check: tagHas('agency', /Defense/i), msg: 'agency = DoD' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows via keyword path' },
    ],
  },

  {
    name: 'Atlassian: Who resells Jira in federal',
    question: 'Who resells Jira in federal',
    tags: ['seller', 'atlassian', 'reseller'],
    assertions: [
      { kind: 'soft', check: (s) => {
          const aliases = String(s.tagAttrs?.aliases || '').toLowerCase();
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return aliases.includes('jira') || kw.includes('jira');
        }, msg: 'Jira appears in aliases or keywords' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'Atlassian: ITSM at DHS',
    question: 'Show me ITSM at DHS',
    tags: ['seller', 'atlassian', 'capability'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Homeland Security/i), msg: 'agency = DHS' },
      { kind: 'soft', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('itsm') || kw.includes('service management') || kw.includes('it service');
        }, msg: 'keywords includes ITSM or IT service management' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  // ── Datadog seller persona ──────────────────────────────────────────────
  {
    name: 'Datadog: monitoring at DISA',
    question: 'Monitoring contracts at DISA',
    tags: ['seller', 'datadog', 'program-office'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Defense/i), msg: 'agency = DoD (parent of DISA)' },
      { kind: 'hard', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('disa') || kw.includes('monitoring');
        }, msg: 'keywords includes DISA or monitoring' },
      { kind: 'soft', check: rowsAtLeast(5), msg: 'at least 5 rows' },
    ],
  },

  {
    name: 'Datadog: observability at NSA (agencyDropped expected)',
    question: 'Show me observability at NSA',
    tags: ['seller', 'datadog', 'fallback'],
    assertions: [
      // NSA returns 0 on both tiers — agencyDropped chip fires
      { kind: 'soft', check: (s) => s.rowCount > 0 || s.resolved?.agencyDropped,
        msg: 'either rows returned OR agencyDropped fired (NSA = no USASpending data)' },
      { kind: 'soft', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('observability') || kw.includes('monitor');
        }, msg: 'keywords includes observability or monitoring' },
    ],
  },

  {
    name: 'Datadog: APM at Army',
    question: 'APM at Army',
    tags: ['seller', 'datadog', 'capability'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Army/i), msg: 'agency = Army' },
      { kind: 'soft', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('apm') || kw.includes('performance monitoring') || kw.includes('application performance');
        }, msg: 'keywords includes APM or application performance monitoring' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  // ── Sonatype seller persona ─────────────────────────────────────────────
  {
    name: 'Sonatype: SBOM contracts at DoD',
    question: 'SBOM contracts at DoD',
    tags: ['seller', 'sonatype', 'sbom'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Defense/i), msg: 'agency = DoD' },
      { kind: 'hard', check: tagAttrIncludes('keywords', 'SBOM'), msg: 'keywords includes SBOM' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'Sonatype: DevSecOps at Air Force',
    question: 'DevSecOps at Air Force',
    tags: ['seller', 'sonatype', 'capability'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Air Force/i), msg: 'agency = Air Force (subtier)' },
      { kind: 'hard', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('devsecops') || kw.includes('devops');
        }, msg: 'keywords includes DevSecOps or DevOps' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'Sonatype: software supply chain at NSA (agencyDropped expected)',
    question: 'Software supply chain at NSA',
    tags: ['seller', 'sonatype', 'fallback'],
    assertions: [
      { kind: 'soft', check: (s) => s.rowCount > 0 || s.resolved?.agencyDropped,
        msg: 'either rows returned OR agencyDropped fired (NSA = no data)' },
      { kind: 'soft', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('supply chain') || kw.includes('software composition') || kw.includes('sbom');
        }, msg: 'keywords includes supply chain or SBOM' },
    ],
  },

  // ── Akamai seller persona ───────────────────────────────────────────────
  {
    name: 'Akamai: zero trust at CISA',
    question: 'Zero trust at CISA',
    tags: ['seller', 'akamai', 'capability', 'cisa'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Homeland Security|CISA|Cybersecurity/i), msg: 'agency = DHS or CISA' },
      { kind: 'hard', check: tagAttrIncludes('keywords', 'zero trust'), msg: 'keywords includes zero trust' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'Akamai: Guardicore alias resolves to Akamai',
    question: 'Akamai Guardicore at Army',
    tags: ['seller', 'akamai', 'alias'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Akamai/i), msg: 'recipient = Akamai (Guardicore is Akamai acquisition)' },
      { kind: 'hard', check: tagHas('agency', /Army/i), msg: 'agency = Army' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'Akamai: DDoS protection at Treasury',
    question: 'DDoS protection at Treasury',
    tags: ['seller', 'akamai', 'capability'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Treasury/i), msg: 'agency = Treasury' },
      { kind: 'soft', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('ddos') || kw.includes('denial') || kw.includes('cdn') || kw.includes('edge');
        }, msg: 'keywords includes DDoS, denial of service, CDN, or edge' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  // ── SentinelOne seller persona ──────────────────────────────────────────
  {
    name: 'SentinelOne: at Air Force (direct)',
    question: 'SentinelOne at Air Force',
    tags: ['seller', 'sentinelone', 'subtier'],
    assertions: [
      { kind: 'hard', check: tagHas('recipient', /Sentinel/i), msg: 'recipient = SentinelOne' },
      { kind: 'hard', check: tagHas('agency', /Air Force/i), msg: 'agency = Air Force (subtier)' },
      { kind: 'hard', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'SentinelOne: XDR at CYBERCOM',
    question: 'XDR contracts at CYBERCOM',
    tags: ['seller', 'sentinelone', 'program-office'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Defense|Cyber Command/i), msg: 'agency = DoD or Cyber Command (CYBERCOM parent)' },
      { kind: 'soft', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('xdr') || kw.includes('endpoint') || kw.includes('cyber command') || kw.includes('cybercom');
        }, msg: 'keywords includes XDR, endpoint, or CYBERCOM' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows' },
    ],
  },

  {
    name: 'SentinelOne: CrowdStrike vs SentinelOne at DHS (no recipient bleed)',
    question: 'CrowdStrike vs SentinelOne at DHS',
    tags: ['seller', 'sentinelone', 'competitor'],
    assertions: [
      { kind: 'hard', check: tagHas('agency', /Homeland Security/i), msg: 'agency = DHS' },
      // Mo should pick one — not pack both into a comma-list that breaks parsing
      { kind: 'hard', check: (s) => {
          const r = String(s.tagAttrs?.recipient || '');
          return !r.includes(',');
        }, msg: 'recipient is single vendor (no comma-list that breaks resolver)' },
      { kind: 'soft', check: rowsAtLeast(3), msg: 'at least 3 rows for whichever vendor Mo chose' },
    ],
  },

  {
    name: 'SentinelOne: endpoint at IC (agencyDropped expected)',
    question: 'Show me endpoint at IC',
    tags: ['seller', 'sentinelone', 'fallback'],
    assertions: [
      { kind: 'soft', check: (s) => s.rowCount > 0 || s.resolved?.agencyDropped,
        msg: 'either rows returned OR agencyDropped fired (IC not a USASpending agency)' },
      { kind: 'soft', check: (s) => {
          const kw = String(s.tagAttrs?.keywords || '').toLowerCase();
          return kw.includes('endpoint') || kw.includes('edr') || kw.includes('xdr');
        }, msg: 'keywords includes endpoint, EDR, or XDR' },
    ],
  },

];