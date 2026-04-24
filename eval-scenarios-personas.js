// ============================================================================
// eval-scenarios-personas.js — persona-driven and recent-capability evals
// ============================================================================
//
// Companion to eval-scenarios-harsh.js. Same snapshot shape, same assertion
// helpers, runs through the same eval-runner.js. These scenarios test:
//
//   - Real personas from the LinkedIn launch audience (BDR, AE, partner
//     manager, VP, director — at AWS, Datadog, Akamai, Sonatype, Lockheed)
//   - Capabilities added after harsh-suite was written:
//       * subaward direction flip (who subs to X vs who X subs to)
//       * channel-partner classification (direct/channel/competitor)
//       * mission-program fallback (CISA/USCG/STRATCOM rerouting)
//       * recompete / pipeline list intent
//       * territory pills (FedFin, FedHealth)
//       * reseller queries
//   - Persona-shaped multi-turn flows that mimic actual sales workflows
//     (BDR researching → AE pitching → partner manager flipping direction)
//
// Run alongside the harsh suite before a release. These take longer because
// many are 3-5 turn flows.
// ============================================================================

// ── Assertion helpers (identical to eval-scenarios-harsh.js) ─────────────

const proseContains = (needle) => (s) => {
  const combined = [(s.preTagText || ''), (s.postTagText || '')].join(' ').toLowerCase();
  return combined.includes(needle.toLowerCase());
};
const proseLacks = (needle) => (s) => !proseContains(needle)(s);
const proseLacksAll = (...needles) => (s) => needles.every(n => proseLacks(n)(s));
const proseContainsAny = (...needles) => (s) => needles.some(n => proseContains(n)(s));
const tagAttr = (key, expected) => (s) => {
  if (!s.tagAttrs) return false;
  if (expected == null) return key in s.tagAttrs;
  const actual = s.tagAttrs[key];
  if (typeof expected === 'string') return String(actual || '').toLowerCase() === expected.toLowerCase();
  return actual === expected;
};
const rowsBetween = (min, max) => (s) => s.rowCount >= min && s.rowCount <= max;
const mode = (m) => (s) => s.mode === m;
const modeAnyOf = (...modes) => (s) => modes.includes(s.mode);
const rowsIncludePrime = (needle) => (s) => {
  if (!s.rows) return false;
  const n = needle.toLowerCase();
  return s.rows.some(r => (r['Recipient Name'] || '').toLowerCase().includes(n));
};
const rowsIncludeAnyPrime = (...needles) => (s) => needles.some(n => rowsIncludePrime(n)(s));

// Persona evals get tagged so the runner can group / filter later if needed.
const persona = (label) => label;

// ── The scenarios ──────────────────────────────────────────────────────

export const SCENARIOS = [

  // ════════════════════════════════════════════════════════════════════
  //  PERSONA: AWS BDR — exploratory, low-context, learning the territory
  // ════════════════════════════════════════════════════════════════════
  //
  // A BDR's job is to find new accounts and qualify opportunities. They
  // don't know the full landscape yet. They ask broad, exploratory
  // questions and need Mo to scope them down without making them feel
  // dumb. They care about expiring contracts (where to call) and gaps
  // (where AWS isn't winning yet).

  {
    name: 'Persona AWS BDR: exploratory pivot — what\'s expiring → who\'s winning → my opening',
    persona: persona('AWS BDR'),
    description: 'A BDR researching the federal cloud market. Starts with "what\'s expiring" (a pipeline-list intent), narrows to a specific agency, then asks where AWS could win. Tests: pipeline-list detection, agency narrowing, multi-turn AWS framing without forcing seller_pitch on every turn.',
    turns: [
      {
        question: "what's expiring at DoD in the next 90 days for cloud",
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'agency is DoD-shaped', check: (s) =>
            /dod|defense/i.test(s.tagAttrs?.agency || s.tagAttrs?.toptier || '') ||
            modeAnyOf('pipeline_list', 'data')(s) },
          { kind: 'soft', msg: 'rows returned (something to pursue)', check: (s) =>
            (s.rowCount || 0) >= 5 || s.mode === 'pipeline_list' },
        ],
      },
      {
        question: "narrow that to Air Force",
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'agency narrowed to Air Force (or DoD sub-component)', check: (s) =>
            /air ?force|department of the air force|usaf/i.test(
              (s.tagAttrs?.agency || '') + ' ' + (s.tagAttrs?.office || '') + ' ' + (s.resolverInput?.subtier || '')
            ) },
        ],
      },
      {
        question: "where would AWS have an opening here",
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'AWS is now in scope (vendor or seller context)', check: (s) =>
            /aws|amazon/i.test(s.tagAttrs?.vendor || '') ||
            /aws|amazon/i.test(s.resolverInput?._sellerName || '') ||
            proseContains('aws')(s) || proseContains('amazon')(s) },
          { kind: 'soft', msg: 'response stays in the Air Force / DoD context (does not bounce back to "all DoD")',
            check: (s) => /air ?force|usaf/i.test(
              (s.tagAttrs?.agency || '') + ' ' + (s.tagAttrs?.office || '') + ' ' + (s.preTagText || '') + ' ' + (s.postTagText || '')
            ) || (s.tagAttrs?.agency || '').toLowerCase() !== 'department of defense' },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  PERSONA: AWS sales rep covering VA — seller_pitch with channel reality
  // ════════════════════════════════════════════════════════════════════
  //
  // VA AWS rep knows AWS shows up at VA mostly through resellers (Four Points
  // Technology is a major one). The CRITICAL test: when they pitch AWS at VA,
  // Mo must recognize Four Points and similar VARs as CHANNEL partners, not
  // competitors. This is the channel-classification feature in payload-summary.

  {
    name: 'Persona AWS@VA: seller pitch, channel partners must NOT be framed as competitors',
    persona: persona('AWS sales rep, VA'),
    description: 'VA AWS rep pitches their territory. The top primes at VA include Four Points Technology and other VARs reselling AWS. Mo must NOT advise "attack Four Points" — they\'re channel. Mo SHOULD frame Four Points as a partner / door-opener. Tests the channel-classification logic in summarizePayloadForMo.',
    turns: [
      {
        question: 'I sell AWS to the VA',
        assertions: [
          { kind: 'hard', msg: 'mode is data', check: mode('data') },
          { kind: 'hard', msg: 'vendor=AWS', check: tagAttr('vendor', 'AWS') },
          { kind: 'hard', msg: 'agency=VA', check: (s) =>
            /va|veterans/i.test(s.tagAttrs?.agency || '') },
          { kind: 'hard', msg: '_sellerName captured for channel classification', check: (s) =>
            /aws|amazon/i.test(s.resolverInput?._sellerName || s.tagAttrs?.vendor || '') },
          { kind: 'hard', msg: 'Mo does NOT call channel partners "competitors"',
            check: (s) => {
              // Specifically guard against "Four Points is your competitor"
              // language. Allow Mo to mention Four Points (good), just not
              // as a foe. Heuristic: if she names a VAR and the word
              // "competitor" appears within 50 chars on either side, fail.
              const text = ((s.preTagText || '') + ' ' + (s.postTagText || '')).toLowerCase();
              const vars_ = ['four points', 'thundercat', 'carahsoft', 'gdit'];
              for (const v of vars_) {
                const idx = text.indexOf(v);
                if (idx >= 0) {
                  const window = text.slice(Math.max(0, idx - 50), idx + v.length + 50);
                  if (window.includes('competitor') || window.includes('beat ') || window.includes('displace')) {
                    return false;
                  }
                }
              }
              return true;
            } },
        ],
      },
      {
        question: 'who are my biggest channel partners here',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'soft', msg: 'Mo names a real reseller (Four Points, Thundercat, Carahsoft, etc)',
            check: proseContainsAny('four points', 'thundercat', 'carahsoft', 'reseller', 'channel', 'partner') },
          { kind: 'soft', msg: 'still scoped to VA (not bouncing to all-of-government)',
            check: (s) => /va|veterans/i.test((s.tagAttrs?.agency || '') + ' ' + (s.preTagText || '') + ' ' + (s.postTagText || '')) },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  PERSONA: AWS partner manager for Lockheed — subaward direction flip
  // ════════════════════════════════════════════════════════════════════
  //
  // A partner manager wants to know two distinct things:
  //   1. What primes hire Lockheed as a sub (Lockheed-as-subcontractor)
  //   2. What subs Lockheed hires under their own primes (Lockheed-as-prime)
  // Mo's subaward flow has both directions; this scenario tests the flip.

  {
    name: 'Persona Lockheed partner manager: subaward direction flip',
    persona: persona('AWS partner manager, Lockheed'),
    description: 'Partner manager flips between "who hires Lockheed as a sub" and "who Lockheed subs to". This tests subaward direction handling — a real feature in the resolver. The two answers should be different sets of vendors.',
    turns: [
      {
        question: 'who subawards to Lockheed Martin',
        assertions: [
          { kind: 'hard', msg: 'mode is subaward', check: mode('subaward') },
          { kind: 'hard', msg: 'subaward direction reflects "who hires Lockheed"',
            check: (s) => {
              // Direction "to" means: list primes that subawarded TO Lockheed
              const dir = s.resolverInput?._subawardDirection || s.tagAttrs?.subaward_direction || '';
              return /to|hires|primes|hiring/i.test(dir + ' ' + JSON.stringify(s.resolverInput || {}));
            } },
          { kind: 'soft', msg: 'rows returned (Lockheed has sub work)', check: (s) => (s.rowCount || 0) > 0 },
        ],
      },
      {
        question: 'now flip it — who does Lockheed subaward to',
        assertions: [
          { kind: 'hard', msg: 'mode is subaward', check: mode('subaward') },
          { kind: 'hard', msg: 'still about Lockheed', check: (s) =>
            /lockheed/i.test(JSON.stringify(s.resolverInput || s.tagAttrs || {})) ||
            proseContains('lockheed')(s) },
          { kind: 'hard', msg: 'direction has flipped (from-Lockheed perspective)',
            check: (s) => {
              const blob = JSON.stringify(s.resolverInput || {}) + ' ' + (s.tagAttrs?.subaward_direction || '');
              return /from|hired|subs|by lockheed|down/i.test(blob);
            } },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  PERSONA: Akamai fed civilian rep — small-but-real, FedHealth territory
  // ════════════════════════════════════════════════════════════════════
  //
  // Akamai sells CDN / edge to civilian agencies. They have real direct
  // prime contracts but they're a smaller player overall. This persona
  // tests territory expansion (FedHealth → multiple agencies) and the
  // tone-balance between "real but modest" markets.

  {
    name: 'Persona Akamai civilian rep: territory pill (FedHealth) and small-vendor read',
    persona: persona('Akamai sales, fed civilian'),
    description: 'Civilian Akamai rep asks about CDN/edge in the FedHealth territory. Territory should expand to multiple HHS-adjacent agencies (CMS, NIH, FDA, CDC, etc). Mo should give a real read of a small-but-present vendor — not pretend they\'re bigger than they are, not dismiss them.',
    turns: [
      {
        question: 'I sell Akamai into FedHealth',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'vendor=Akamai', check: tagAttr('vendor', 'Akamai') },
          { kind: 'hard', msg: 'territory expanded to multiple HHS-adjacent agencies', check: (s) => {
            // Either the territory pill flag is set, or multiple agencies
            // appear in resolver.agencies, or rows show multi-agency mix.
            const ri = s.resolverInput || {};
            const territoryFlag = !!ri._territory || ri.territory;
            const multipleAgencies = Array.isArray(ri.agencies) && ri.agencies.length > 1;
            // Or: rows include >1 agency
            const rowAgencies = new Set((s.rows || []).map(r => r['Awarding Agency'] || ''));
            const multiAgencyRows = rowAgencies.size >= 2;
            return territoryFlag || multipleAgencies || multiAgencyRows;
          } },
          { kind: 'soft', msg: 'Mo references CDN, edge, content, or media in prose',
            check: proseContainsAny('cdn', 'edge', 'content', 'media', 'streaming', 'delivery') },
        ],
      },
      {
        question: 'who else is winning CDN business in this space',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'soft', msg: 'Mo names plausible CDN/edge competitors or partners',
            check: proseContainsAny('cloudflare', 'fastly', 'aws', 'amazon', 'cloudfront', 'azure front', 'verizon', 'limelight') },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  PERSONA: Datadog VP — broad strategic view, competitor framing
  // ════════════════════════════════════════════════════════════════════
  //
  // A VP wants a portfolio view, not a single-deal view. They ask
  // strategic questions like "where are we losing" or "what's the
  // observability market shape". Mo should hold the broader frame and
  // not reduce it to a single account.

  {
    name: 'Persona Datadog VP: portfolio view, observability competitor landscape',
    persona: persona('Datadog VP'),
    description: 'VP asks broad questions about Datadog\'s federal observability footprint and competitors. Tests file-first competitor lookup (Datadog has known competitors in fixtures: Splunk, New Relic, Dynatrace, Elastic). VP-tone questions should not collapse to single-deal coaching.',
    turns: [
      {
        question: "what does Datadog's federal footprint look like",
        assertions: [
          { kind: 'hard', msg: 'mode is data', check: mode('data') },
          { kind: 'hard', msg: 'vendor=Datadog', check: tagAttr('vendor', 'Datadog') },
          { kind: 'soft', msg: 'agency is broad (no agency = whole-government view, that is the right answer for a VP)',
            check: (s) => !s.tagAttrs?.agency || s.tagAttrs.agency.toLowerCase() === '' },
          { kind: 'soft', msg: 'rows span multiple agencies (portfolio shape, not one customer)',
            check: (s) => {
              if (!s.rows || s.rows.length === 0) return false;
              const agencies = new Set(s.rows.map(r => r['Awarding Agency'] || ''));
              return agencies.size >= 3;
            } },
        ],
      },
      {
        question: 'who are we losing to in observability across fed',
        assertions: [
          { kind: 'hard', msg: 'competitor mode fired', check: (s) =>
            s.resolverInput?._competitors === true || (s.tagAttrs?.competitors || '').toString() === 'true' },
          { kind: 'hard', msg: 'competitor source is file (fixtures match for Datadog)', check: (s) =>
            s.resolverInput?._competitorSource === 'file' },
          { kind: 'hard', msg: 'competitor list includes real observability players', check: (s) => {
            const list = (s.resolverInput?._competitorList || []).map(x => String(x).toLowerCase()).join('|');
            return /splunk|new relic|dynatrace|elastic|grafana/.test(list);
          } },
          { kind: 'hard', msg: '_sellerName preserved through competitor expansion', check: (s) =>
            /datadog/i.test(s.resolverInput?._sellerName || '') },
        ],
      },
      {
        question: 'where should I focus my team next quarter',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'soft', msg: 'response is strategic — names a focus area, not just data dump',
            check: proseContainsAny('focus', 'priority', 'strongest', 'opportunity', 'gap', 'invest', 'beachhead', 'land', 'expand', 'where') },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  PERSONA: Sonatype public-sector director — known thin vendor
  // ════════════════════════════════════════════════════════════════════
  //
  // Sonatype shows up rarely as a direct prime — most of their fed business
  // flows through Carahsoft and other VARs. The CORRECT behavior is to
  // surface that channel reality, not pretend Sonatype has a big direct
  // footprint. Tests channel surfacing on a thin-direct vendor.

  {
    name: 'Persona Sonatype director: thin-direct, must surface channel reality',
    persona: persona('Sonatype public sector director'),
    description: 'Sonatype direct-prime contracts at most agencies are thin-to-zero. The right answer: acknowledge that, then show the Carahsoft / VAR channel where Sonatype actually shows up. The wrong answer: pretend there\'s a large direct market, OR refuse and say "no data".',
    turns: [
      {
        question: 'I sell Sonatype to DoD',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'vendor=Sonatype in the query intent', check: (s) =>
            /sonatype/i.test(s.tagAttrs?.vendor || '') ||
            /sonatype/i.test(s.resolverInput?.vendor || '') ||
            /sonatype/i.test(s.resolverInput?._sellerName || '') },
          { kind: 'hard', msg: 'Mo handles thin data honestly (data with channel framing, OR category fallback, OR honest no_data prose)',
            check: (s) => {
              if (modeAnyOf('no_data', 'no_subaward_data', 'prose')(s)) return true;
              if (s.mode === 'data') {
                // If she returned data, she should either have channel-aware prose
                // OR have rerouted to the broader application-security/SCA market.
                const text = ((s.preTagText || '') + ' ' + (s.postTagText || '')).toLowerCase();
                const channelAware = /carahsoft|reseller|channel|partner|var\b|through/.test(text);
                const categoryAware = /software composition|sca\b|application security|appsec|supply chain|open source/.test(text);
                const honestAboutThin = /thin|small|limited|few|not much|doesn't show/.test(text);
                return channelAware || categoryAware || honestAboutThin;
              }
              return false;
            } },
          { kind: 'hard', msg: 'Mo does NOT fabricate big Sonatype direct numbers',
            check: (s) => {
              // If rows came back, Sonatype direct contracts at DoD are typically
              // few. If we see ROW count > 30 AND every row is Sonatype-named,
              // that's suspicious — but the more reliable check is "she didn't
              // claim Sonatype is a top-5 prime at DoD." Heuristic check on prose:
              const text = ((s.preTagText || '') + ' ' + (s.postTagText || '')).toLowerCase();
              return !text.includes('sonatype is the top') &&
                     !text.includes('sonatype dominates') &&
                     !text.includes('sonatype leads');
            } },
        ],
      },
      {
        question: 'who resells us in fed',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'soft', msg: 'Mo names Carahsoft (or another known fed reseller for Sonatype)',
            check: proseContainsAny('carahsoft', 'reseller', 'channel', 'partner', 'var') },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  CAPABILITY: mission-program fallback (CISA/USCG/STRATCOM)
  // ════════════════════════════════════════════════════════════════════
  //
  // CISA isn't a real USASpending toptier — contracts flow through DHS.
  // The Lambda has fallback logic that retries the query against the
  // parent toptier with the mission name as a keyword. Mo's payload
  // summary then includes a missionFallback note that should produce a
  // short acknowledgment in her prose.

  {
    name: 'Mission program fallback: CISA cyber',
    persona: persona('Capability test'),
    description: 'CISA is a sub-organization of DHS, not a toptier. Lambda should fall back to DHS + "CISA" keyword filter. Mo should acknowledge briefly that USASpending files this under DHS rather than pretending the agency lookup worked as typed. This is the missionFallback path in summarizePayloadForMo.',
    turns: [
      {
        question: 'cyber spending at CISA',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'rows returned (fallback worked, didn\'t leave user empty-handed)',
            check: (s) => modeAnyOf('data')(s) && (s.rowCount || 0) > 0 },
          { kind: 'soft', msg: 'Mo acknowledges the parent-department reality (DHS, parent, files under, etc)',
            check: proseContainsAny('dhs', 'homeland', 'parent', 'files under', 'under the', 'rolled up', 'flow through') },
          { kind: 'soft', msg: 'CISA mention is preserved (not dropped silently)',
            check: proseContains('cisa') },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  CAPABILITY: territory pill expansion (FedFin)
  // ════════════════════════════════════════════════════════════════════
  //
  // FedFin should expand to Treasury, FDIC, SEC, SBA, FinCEN, OCC.
  // The resolver has the territory mapping; this tests that a FedFin
  // query gets the multi-agency expansion, not a literal "FedFin" lookup.

  {
    name: 'Territory pill: FedFin expansion to multiple agencies',
    persona: persona('Capability test'),
    description: 'FedFin is a sales territory, not a real agency. Resolver should expand it to Treasury + FDIC + SEC + SBA + FinCEN + OCC. The data card should reflect cross-agency rows. Critical: a literal "FedFin" agency lookup that fails silently is the failure mode.',
    turns: [
      {
        question: 'cloud spending across FedFin',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'territory was expanded — rows span multiple FedFin agencies',
            check: (s) => {
              if (!s.rows || s.rows.length === 0) return false;
              const agencies = new Set(s.rows.map(r => (r['Awarding Agency'] || '').toLowerCase()));
              const fedfinAgencies = ['treasury', 'fdic', 'sec', 'sba', 'fincen', 'occ',
                                       'securities and exchange', 'small business administration'];
              const matchCount = fedfinAgencies.filter(name =>
                [...agencies].some(a => a.includes(name))
              ).length;
              return matchCount >= 2;
            } },
          { kind: 'hard', msg: 'NOT a literal "FedFin" agency lookup that returned empty',
            check: (s) => (s.rowCount || 0) > 0 },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  CAPABILITY: reseller channel-map query
  // ════════════════════════════════════════════════════════════════════
  //
  // "Who resells AWS" should map to the federal channel reality —
  // Four Points, GDIT, Carahsoft (and others) — not Amazon's direct
  // prime footprint. This is a different intent from "show me AWS contracts".

  {
    name: 'Reseller channel map: who resells AWS in fed',
    persona: persona('Capability test'),
    description: 'A "who resells X" query is fundamentally different from "show me X". The answer should be the channel map (resellers, VARs), not the direct vendor\'s footprint. If Mo just shows AWS prime contracts, she missed the question.',
    turns: [
      {
        question: 'who resells AWS in federal',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'soft', msg: 'Mo names known AWS federal resellers',
            check: proseContainsAny('four points', 'gdit', 'carahsoft', 'thundercat', 'reseller', 'channel', 'var\\b') },
          { kind: 'soft', msg: 'Mo does NOT just show Amazon Web Services as the top prime',
            check: (s) => {
              // If she pulled data and the top row is AWS direct, she misread the
              // question. (Allow the case where she pulled data AND framed it as
              // channel — the prose check above covers that.)
              if (s.mode !== 'data' || !s.rows?.length) return true;
              const topRowName = (s.rows[0]?.['Recipient Name'] || '').toLowerCase();
              if (topRowName.includes('amazon web services') || topRowName.includes('amazon.com')) {
                // Failed the soft check unless prose explicitly reframes
                const text = ((s.preTagText || '') + ' ' + (s.postTagText || '')).toLowerCase();
                return /resell|channel|partner|through/.test(text);
              }
              return true;
            } },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  PERSONA × MULTI-TURN: AWS BDR → AE handoff (5-turn chain)
  // ════════════════════════════════════════════════════════════════════
  //
  // Composite scenario: a BDR researches a market, narrows it, then a
  // colleague (the AE) takes over and asks competitive/pitch questions.
  // Tests Mo's ability to hold context across a long realistic flow.

  {
    name: 'Multi-turn: AWS BDR → AE handoff at VA cyber (5 turns)',
    persona: persona('Composite: BDR + AE'),
    description: 'A BDR-then-AE workflow stretching across five turns. BDR explores VA cyber market, narrows to expiring contracts, AE picks up and asks competitive position. This stresses both attribute-stickiness (good context carries) and reset-discipline (when topic changes, drop stale).',
    turns: [
      {
        question: "what's happening in cyber at the VA",
        assertions: [
          { kind: 'hard', msg: 'T1: agency=VA, topic=cyber-shaped', check: (s) =>
            /va|veterans/i.test(s.tagAttrs?.agency || '') &&
            (
              /cyber|security/i.test(s.tagAttrs?.topic || '') ||
              /cyber|security/i.test(s.tagAttrs?.naics || '') ||
              /cyber|security/i.test(JSON.stringify(s.resolverInput || {}))
            ) },
          { kind: 'hard', msg: 'T1: rows returned', check: (s) => (s.rowCount || 0) > 5 },
        ],
      },
      {
        question: "what's expiring in the next 6 months",
        assertions: [
          { kind: 'hard', msg: 'T2: VA + cyber context preserved', check: (s) =>
            /va|veterans/i.test((s.tagAttrs?.agency || '') + ' ' + JSON.stringify(s.resolverInput || {})) },
          { kind: 'soft', msg: 'T2: expiring/recompete signal in mode or prose',
            check: (s) => modeAnyOf('pipeline_list', 'data')(s) ||
              proseContainsAny('expir', 'recompet', 'next 6', 'period of performance') },
        ],
      },
      {
        question: "ok now imagine I'm the AWS rep here. What's my play?",
        assertions: [
          { kind: 'hard', msg: 'T3: AWS now in scope', check: (s) =>
            /aws|amazon/i.test(s.tagAttrs?.vendor || s.resolverInput?._sellerName || '') ||
            proseContainsAny('aws', 'amazon') },
          { kind: 'hard', msg: 'T3: VA still the agency context', check: (s) =>
            /va|veterans/i.test((s.tagAttrs?.agency || '') + ' ' + (s.preTagText || '') + ' ' + (s.postTagText || '')) },
        ],
      },
      {
        question: 'who am I up against',
        assertions: [
          { kind: 'hard', msg: 'T4: competitor flag fired', check: (s) =>
            s.resolverInput?._competitors === true ||
            (s.tagAttrs?.competitors || '').toString() === 'true' },
          { kind: 'hard', msg: 'T4: AWS is still the seller (not pivoted)', check: (s) =>
            /aws|amazon/i.test(s.resolverInput?._sellerName || s.tagAttrs?.vendor || '') },
        ],
      },
      {
        question: 'switching gears — give me the read on Palantir at Army',
        assertions: [
          { kind: 'hard', msg: 'T5: vendor=Palantir (NOT AWS)', check: tagAttr('vendor', 'Palantir') },
          { kind: 'hard', msg: 'T5: agency=Army (NOT VA)', check: (s) =>
            /army/i.test(s.tagAttrs?.agency || '') },
          { kind: 'hard', msg: 'T5: AWS dropped from prose context (no AWS coaching dragged forward)',
            check: (s) => {
              const text = ((s.preTagText || '') + ' ' + (s.postTagText || '')).toLowerCase();
              const awsMentions = (text.match(/\b(aws|amazon)\b/g) || []).length;
              // Allow up to 1 contrast mention; more than that is dragged context.
              return awsMentions <= 1;
            } },
          { kind: 'hard', msg: 'T5: VA dropped from agency context', check: (s) => {
              const text = ((s.preTagText || '') + ' ' + (s.postTagText || '')).toLowerCase();
              const vaMentions = (text.match(/\b(va|veterans)\b/g) || []).length;
              return vaMentions <= 1;
            } },
          { kind: 'hard', msg: 'T5: competitor flag did NOT carry forward', check: (s) =>
            !s.tagAttrs?.competitors && s.resolverInput?._competitors !== true },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  ADVERSARIAL: vendor name collision (Akamai vs Akami misspelling)
  // ════════════════════════════════════════════════════════════════════
  //
  // Sellers will misspell vendor names. Mo's resolver should handle common
  // typos / case variations and not return empty. Specifically tests
  // resolver.js fuzzy matching on a beta vendor.

  {
    name: 'Adversarial: vendor misspelling resilience',
    persona: persona('Capability test'),
    description: 'User types vendor names with various capitalizations and minor typos. Resolver should still find the right vendor. This is one of the most common real-world failure modes.',
    turns: [
      {
        question: 'i sell AKAMAI to dod', // all caps
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'vendor=Akamai (case-insensitive resolver)', check: (s) =>
            /akamai/i.test(s.tagAttrs?.vendor || s.resolverInput?.vendor || '') },
          { kind: 'hard', msg: 'data mode (not "vendor not found")', check: mode('data') },
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════
  //  EDGE: refine to a sub-agency that doesn't exist as a toptier
  // ════════════════════════════════════════════════════════════════════
  //
  // After scoping AWS at DoD, user narrows to "Marines" which is a sub-
  // component of Department of the Navy in USASpending. Mo should
  // resolve it to the Navy + a Marines sub-tier filter, NOT pretend
  // "Marines" is a standalone agency.

  {
    name: 'Edge: refine to "Marines" (sub-component of Navy)',
    persona: persona('Capability test'),
    description: 'Marines is a DoD sub-component under Department of the Navy. A refine to "Marines" should narrow correctly via subtier filter or office, not lookup "Marines" as a toptier.',
    turns: [
      {
        question: 'I sell AWS to DoD',
        assertions: [
          { kind: 'hard', msg: 'T1 baseline: vendor=AWS, agency=DoD', check: (s) =>
            /aws/i.test(s.tagAttrs?.vendor || '') && /dod|defense/i.test(s.tagAttrs?.agency || '') },
        ],
      },
      {
        question: 'just the Marines',
        assertions: [
          { kind: 'hard', msg: 'no crash', check: (s) => !!s.mode && s.mode !== 'error' },
          { kind: 'hard', msg: 'vendor still AWS', check: tagAttr('vendor', 'AWS') },
          { kind: 'hard', msg: 'narrowed via subtier or office (Navy / USMC), NOT a "Marines" toptier lookup',
            check: (s) => {
              // Acceptable: resolver resolved to Navy + Marines subtier, OR the
              // office filter set, OR rows shape changed to Marines-flavored
              // contracts. Failure: a literal toptier="Marines" that returned
              // empty/garbage.
              const blob = JSON.stringify(s.resolverInput || s.tagAttrs || {}).toLowerCase();
              const naviness = /navy|usmc|marine/.test(blob);
              const hasRows = (s.rowCount || 0) > 0;
              return naviness && hasRows;
            } },
        ],
      },
    ],
  },

];
