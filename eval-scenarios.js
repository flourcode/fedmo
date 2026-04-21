// ============================================================================
// eval-scenarios.js — the scripted conversations we check against
// ============================================================================
//
// These ten scenarios are drawn from real testing. Each one either broke in
// a recent turn (regression guard) or represents a core use case users will
// actually hit. The assertions target structure and keyword presence, not
// exact wording — Gemini is non-deterministic, and brittle string matches
// would fail on prose that's equivalently correct.
//
// Assertion kinds:
//   - hard: product bug if this fails. Red in the UI.
//   - soft: Gemini drift is acceptable. Yellow if a few fail.
//
// Snapshot shape passed to check() functions:
//   {
//     preTagText, postTagText, tagAttrs, resolverInput,
//     rows, rowCount, mode, error, isSubawardCard
//   }
// ============================================================================

// ── Assertion helpers ───────────────────────────────────────────────
// These keep the scenarios readable. Each returns a check function.

// Mo's combined prose (pre-tag + post-tag) contains the given text, case-insensitive
const proseContains = (needle) => (s) => {
  const combined = [(s.preTagText || ''), (s.postTagText || '')].join(' ').toLowerCase();
  return combined.includes(needle.toLowerCase());
};

// Mo's combined prose does NOT contain the given text
const proseLacks = (needle) => (s) => !proseContains(needle)(s);

// Check a specific <data> tag attribute
const tagAttr = (key, expected) => (s) => {
  if (!s.tagAttrs) return false;
  if (expected == null) return key in s.tagAttrs;
  const actual = s.tagAttrs[key];
  if (typeof expected === 'string') return String(actual || '').toLowerCase() === expected.toLowerCase();
  return actual === expected;
};

// Row count in the expected range (inclusive)
const rowsBetween = (min, max) => (s) => s.rowCount >= min && s.rowCount <= max;

// Turn produced a specific mode
const mode = (m) => (s) => s.mode === m;

// Rows contain at least one recipient whose name matches needle (case-insensitive substring)
const rowsIncludePrime = (needle) => (s) => {
  if (!s.rows) return false;
  const n = needle.toLowerCase();
  return s.rows.some(r => (r['Recipient Name'] || '').toLowerCase().includes(n));
};

// ── The scenarios ──────────────────────────────────────────────────

export const SCENARIOS = [
  // ────────────────────────────────────────────────────────────
  // 1. Known vendor pitch at a major agency
  // ────────────────────────────────────────────────────────────
  {
    name: 'Known vendor: AWS at DoD',
    description: 'Standard seller-pitch. Tests that Mo emits vendor+agency tag, rows come back, Four Points shows up as a channel partner.',
    turns: [
      {
        question: 'I sell AWS to DoD',
        assertions: [
          { kind: 'hard', msg: 'mode is "data"', check: mode('data') },
          { kind: 'hard', msg: 'tag has vendor=AWS', check: tagAttr('vendor', 'AWS') },
          { kind: 'hard', msg: 'tag has agency=DoD (or similar)', check: (s) => /dod|defense/i.test(s.tagAttrs?.agency || '') },
          { kind: 'hard', msg: 'rows returned (≥ 10)', check: rowsBetween(10, 100) },
          { kind: 'hard', msg: 'rows include AWS as a prime', check: rowsIncludePrime('amazon') },
          { kind: 'soft', msg: 'rows include a federal reseller (Carahsoft, Four Points, or similar)', check: (s) =>
            rowsIncludePrime('carahsoft')(s) || rowsIncludePrime('four points')(s) || rowsIncludePrime('thundercat')(s) },
          { kind: 'soft', msg: 'Mo mentions a channel partner or reseller', check: (s) =>
            proseContains('reseller')(s) || proseContains('carahsoft')(s) || proseContains('four points')(s) || proseContains('channel')(s) },
          { kind: 'hard', msg: 'opener does NOT ask user to clarify agency', check: proseLacks('which agency') },
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 2. Niche vendor pitch (the smart-pills candidate)
  // ────────────────────────────────────────────────────────────
  {
    name: 'Niche vendor: Sonatype at fedhealth',
    description: 'Tests vendor recognition beyond the big platforms. Sonatype is the benchmark case — it has real federal presence but low name recognition.',
    turns: [
      {
        question: 'I sell Sonatype to fedhealth',
        assertions: [
          { kind: 'hard', msg: 'tag has vendor=Sonatype', check: tagAttr('vendor', 'Sonatype') },
          { kind: 'hard', msg: 'Mo pulls data (not just prose)', check: mode('data') },
          // Note: Sonatype at fedhealth can legitimately return few rows
          // because its federal health footprint is narrow. Rowcount is
          // soft here — what matters is that a pull happened.
          { kind: 'soft', msg: 'some rows came back', check: rowsBetween(1, 100) },
          { kind: 'soft', msg: 'Mo acknowledges SBOM / supply chain / dev tools context', check: (s) =>
            proseContains('supply chain')(s) || proseContains('sbom')(s) || proseContains('software')(s) },
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 3. Vendor pivot — the big one. Users complained about being trapped.
  // ────────────────────────────────────────────────────────────
  {
    name: 'Vendor pivot: AWS → textiles',
    description: 'Tests turn-by-turn freedom. After AWS pitch, user pivots to an unrelated product. Mo must NOT drag AWS context forward.',
    turns: [
      {
        question: 'I sell AWS to DoD',
        assertions: [
          { kind: 'hard', msg: 'first turn: tag vendor=AWS', check: tagAttr('vendor', 'AWS') },
        ],
      },
      {
        question: 'I want to sell textiles to DoD',
        assertions: [
          { kind: 'hard', msg: 'second turn: tag vendor is NOT AWS', check: (s) =>
            !s.tagAttrs?.vendor || !/aws|amazon/i.test(s.tagAttrs.vendor) },
          { kind: 'hard', msg: 'Mo prose does NOT say "building on" AWS', check: proseLacks('building on') },
          { kind: 'hard', msg: 'Mo prose does NOT mention AWS or Amazon at all', check: (s) =>
            proseLacks('aws')(s) && proseLacks('amazon')(s) },
          { kind: 'soft', msg: 'Mo mentions food service / commissary / DLA (textiles go through similar channels)', check: (s) =>
            proseContains('dla')(s) || proseContains('commissary')(s) || proseContains('exchange')(s) ||
            proseContains('defense logistics')(s) || proseContains('supply chain')(s) },
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 4. Genuine refine — "what about VA" should carry AWS context
  // ────────────────────────────────────────────────────────────
  {
    name: 'Genuine refine: AWS at DoD → what about VA',
    description: 'Tests that Mo carries context when the user explicitly refines. "What about VA" after AWS-DoD should still be about AWS.',
    turns: [
      {
        question: 'I sell AWS to DoD',
        assertions: [
          { kind: 'hard', msg: 'first turn: tag vendor=AWS', check: tagAttr('vendor', 'AWS') },
        ],
      },
      {
        question: 'what about VA',
        assertions: [
          { kind: 'hard', msg: 'second turn: tag vendor is still AWS', check: (s) =>
            /aws|amazon/i.test(s.tagAttrs?.vendor || '') },
          { kind: 'hard', msg: 'second turn: tag agency is VA', check: (s) =>
            /va|veterans/i.test(s.tagAttrs?.agency || '') },
          { kind: 'soft', msg: 'rows include Four Points (dominant AWS VA reseller)', check: rowsIncludePrime('four points') },
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 5. Agency-only bare term
  // ────────────────────────────────────────────────────────────
  {
    name: 'Bare agency: HHS',
    description: 'Tests that bare agency names pull the federal-wide picture without asking for clarification.',
    turns: [
      {
        question: 'HHS',
        assertions: [
          { kind: 'hard', msg: 'Mo pulls data (not just prose)', check: mode('data') },
          { kind: 'hard', msg: 'tag has agency=HHS (or Health and Human Services)', check: (s) =>
            /hhs|health/i.test(s.tagAttrs?.agency || '') },
          { kind: 'hard', msg: 'no vendor attribute — HHS alone is agency-only', check: (s) =>
            !s.tagAttrs?.vendor && !s.tagAttrs?.vendors },
          { kind: 'hard', msg: 'Mo does NOT ask user for clarification', check: proseLacks('which agency') },
          { kind: 'hard', msg: 'rows returned (≥ 30)', check: rowsBetween(30, 100) },
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 6. Coaching question — no data tag
  // ────────────────────────────────────────────────────────────
  {
    name: 'Teaming: who should I team with at VA',
    description: 'Tests that teaming questions produce useful output. Three valid answer shapes: (1) prose coaching ("tell me what you sell so I can target recommendations"), (2) subaward card (shows prime/sub relationships directly), (3) agency-wide prime data (shows who the dominant primes are, with coaching about joining their vendor roster). All three legitimately answer the teaming question.',
    turns: [
      {
        question: 'Who should I team with at VA',
        assertions: [
          { kind: 'hard', msg: 'mode is prose, subaward, or agency-wide data', check: (s) =>
            s.mode === 'prose' || s.mode === 'subaward' ||
            (s.mode === 'data' && s.resolverInput?.agency && !s.resolverInput?.vendor) },
          { kind: 'soft', msg: 'if data/subaward mode, rows returned', check: (s) =>
            s.mode === 'prose' || (s.rowCount || 0) > 0 },
          { kind: 'soft', msg: 'Mo names concrete primes or asks clarifying questions', check: (s) =>
            proseContains('what you sell')(s) || proseContains('what you offer')(s) ||
            proseContains("what you're selling")(s) || proseContains("what you're offering")(s) ||
            proseContains("what's your product")(s) || proseContains('your product or service')(s) ||
            proseContains('which vendor')(s) || proseContains('which technology')(s) ||
            proseContains('tell me')(s) || proseContains('need to know')(s) ||
            proseContains('what are you selling')(s) || proseContains('what are you offering')(s) ||
            proseContains('booz')(s) || proseContains('leidos')(s) || proseContains('gdit')(s) ||
            proseContains('perspecta')(s) || proseContains('red river')(s) ||
            proseContains('accenture')(s) || proseContains('deloitte')(s) ||
            proseContains('optum')(s) || proseContains('triwest')(s) ||
            proseContains('mckesson')(s) || proseContains('oracle')(s) },
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 7. Subawards — the v2 fix
  // ────────────────────────────────────────────────────────────
  {
    name: 'Subawards: AWS at DoD → who\'s subbing',
    description: 'Tests that subaward questions emit subawards="true" and render the subaward card.',
    turns: [
      {
        question: 'I sell AWS to DoD',
        assertions: [
          { kind: 'hard', msg: 'first turn: data pulled', check: mode('data') },
        ],
      },
      {
        question: "who's subbing here",
        assertions: [
          { kind: 'hard', msg: 'tag has subawards=true (as boolean)', check: (s) =>
            s.resolverInput?._subawards === true },
          { kind: 'hard', msg: 'mode is "subaward"', check: mode('subaward') },
          { kind: 'soft', msg: 'rows are subaward shape (prime + sub pairs)', check: (s) =>
            !!s.isSubawardCard },
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 8. Competitors — the competitor expansion flow
  // ────────────────────────────────────────────────────────────
  {
    name: 'Competitors: AWS at VA → who are my competitors',
    description: 'Tests competitor expansion flow: mo_competitors called, vendors array expands, card shows competitive landscape.',
    turns: [
      {
        question: 'I sell AWS to VA',
        assertions: [
          { kind: 'hard', msg: 'first turn: AWS card rendered', check: mode('data') },
        ],
      },
      {
        question: 'who are my competitors',
        assertions: [
          { kind: 'hard', msg: 'tag has competitors=true', check: (s) =>
            s.resolverInput?._competitors === true },
          { kind: 'hard', msg: 'resolverInput has competitor metadata', check: (s) =>
            !!s.resolverInput?._competitorList && s.resolverInput._competitorList.length > 0 },
          { kind: 'hard', msg: 'resolverInput has _sellerName preserved', check: (s) =>
            !!s.resolverInput?._sellerName },
          { kind: 'soft', msg: 'Mo names a real AWS competitor (Azure, GCP, or Oracle)', check: (s) =>
            proseContains('azure')(s) || proseContains('gcp')(s) || proseContains('google cloud')(s) ||
            proseContains('oracle')(s) || proseContains('microsoft')(s) },
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 9. Noise case — bananas
  // ────────────────────────────────────────────────────────────
  {
    name: 'Noise case: bananas at DoD',
    description: 'Tests that a non-federal-procurement product fails cleanly instead of showing F-35 contracts.',
    turns: [
      {
        question: 'I sell bananas to DoD',
        assertions: [
          // Either mo pulls and gets no_data, or she might pivot to food-service
          // and pull commissary contracts (which is actually helpful). Both are
          // acceptable outcomes. Hard failure is showing Hydra-70 rockets.
          { kind: 'soft', msg: 'mode is no_data OR rows are food-service related', check: (s) => {
            if (s.mode === 'no_data') return true;
            if (!s.rows) return false;
            // Check both descriptions AND recipient names — the signal we
            // want ("Norfolk Banana Company", "Coastal Pacific Food
            // Distributors") often lives in the recipient name, not the
            // contract description.
            const haystack = s.rows.map(r =>
              ((r['Description'] || '') + ' ' + (r['Recipient Name'] || '')).toLowerCase()
            ).join(' ');
            return /food|mess|dining|commissary|ration|meal|banana|produce|distribut|subsist|fresh|grocer/.test(haystack);
          }},
          { kind: 'hard', msg: 'rows do NOT include rockets or ammo', check: (s) => {
            if (!s.rows) return true;
            const combinedDesc = s.rows.map(r => (r['Description'] || '').toLowerCase()).join(' ');
            return !/hydra|rocket|tnt|155mm|ammunition|missile/.test(combinedDesc);
          }},
        ],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────
  // 10. Unknown vendor
  // ────────────────────────────────────────────────────────────
  {
    name: 'Unknown vendor: Randomco at DoD',
    description: 'Tests graceful handling of a vendor that isn\'t in any known list. Mo should either return no_data, return a thin data set, or (ideally) return needs_qualifier so she can ask the user what the product does rather than guessing.',
    turns: [
      {
        question: 'I sell Randomco to DoD',
        assertions: [
          { kind: 'hard', msg: 'no crash — mode is set', check: (s) => s.mode != null },
          { kind: 'hard', msg: 'tag has vendor=Randomco', check: tagAttr('vendor', 'Randomco') },
          // Unknown vendor: three valid outcomes. needs_qualifier is the
          // best — Mo refusing to guess and asking what the product does.
          // no_data is acceptable — she pulled, came back empty, said so
          // honestly. data with few rows is acceptable — keyword matched
          // something small. Anything else is a fake-confidence risk.
          { kind: 'soft', msg: 'mode is needs_qualifier, no_data, or data with few rows', check: (s) =>
            s.mode === 'needs_qualifier' || s.mode === 'no_data' ||
            (s.mode === 'data' && s.rowCount <= 10) },
        ],
      },
    ],
  },
];
