// ============================================================================
// resolver.js — Natural names → USASpending-canonical filter objects
// ============================================================================
//
// This module is the translation layer between what Mo (Gemini) writes in
// her <data> tags and the filter shape USASpending's API actually accepts.
//
// Design principle: Mo should write whatever is natural ("SOCOM", "Air Force",
// "Govini", "AFLCMC cyber"). The resolver's job is to turn that into the
// precise USASpending filter object. No LLM involvement, no prompt rules —
// just inspectable tables and deterministic resolution.
//
// Every entry here replaces a rule that used to live in the v1 router prompt.
// When we find a new canonical-name drift, we add a line here, not a rule
// there.
//
// USAGE (ES module):
//   import { resolve } from './resolver.js';
//   const filter = resolve({ vendor: 'Booz', agency: 'SOCOM', topic: 'cyber' });
//   // => { agencies: [{ tier: 'subtier', name: 'U.S. Special Operations Command',
//   //       toptier_name: 'Department of Defense', type: 'awarding' }],
//   //     keywords: ['cyber'], recipient_names: ['BOOZ ALLEN HAMILTON'] }
// ============================================================================


// ─────────────────────────────────────────────────────────────────────
// AGENCIES — aliases → canonical USASpending agency filter objects
// ─────────────────────────────────────────────────────────────────────
//
// Keys are lowercased aliases users or Gemini might type.
// Values are USASpending filter-object literals (without `type`, which the
// resolver always adds as `awarding` — we filter by who AWARDED the contract,
// not who funded it).
//
// Source of truth: the agencies table USASpending's autocomplete returns
// and what govhoo's production product uses after months of real-query
// calibration.
// ─────────────────────────────────────────────────────────────────────

const AGENCIES = {
  // ── Toptiers ─────────────────────────────────────────────────
  'dod':                       { tier: 'toptier', name: 'Department of Defense' },
  'department of defense':     { tier: 'toptier', name: 'Department of Defense' },

  'hhs':                       { tier: 'toptier', name: 'Department of Health and Human Services' },
  'health and human services': { tier: 'toptier', name: 'Department of Health and Human Services' },

  'dhs':                       { tier: 'toptier', name: 'Department of Homeland Security' },
  'homeland security':         { tier: 'toptier', name: 'Department of Homeland Security' },

  'va':                        { tier: 'toptier', name: 'Department of Veterans Affairs' },
  'veterans affairs':          { tier: 'toptier', name: 'Department of Veterans Affairs' },
  "veteran's affairs":         { tier: 'toptier', name: 'Department of Veterans Affairs' },

  'gsa':                       { tier: 'toptier', name: 'General Services Administration' },
  'treasury':                  { tier: 'toptier', name: 'Department of the Treasury' },
  'doe':                       { tier: 'toptier', name: 'Department of Energy' },
  'energy':                    { tier: 'toptier', name: 'Department of Energy' },
  'doj':                       { tier: 'toptier', name: 'Department of Justice' },
  'justice':                   { tier: 'toptier', name: 'Department of Justice' },
  'dot':                       { tier: 'toptier', name: 'Department of Transportation' },
  'transportation':            { tier: 'toptier', name: 'Department of Transportation' },
  'usda':                      { tier: 'toptier', name: 'Department of Agriculture' },
  'agriculture':               { tier: 'toptier', name: 'Department of Agriculture' },
  'commerce':                  { tier: 'toptier', name: 'Department of Commerce' },
  'interior':                  { tier: 'toptier', name: 'Department of the Interior' },
  'state':                     { tier: 'toptier', name: 'Department of State' },
  'state department':          { tier: 'toptier', name: 'Department of State' },
  'nasa':                      { tier: 'toptier', name: 'National Aeronautics and Space Administration' },
  'epa':                       { tier: 'toptier', name: 'Environmental Protection Agency' },
  'hud':                       { tier: 'toptier', name: 'Department of Housing and Urban Development' },
  'education':                 { tier: 'toptier', name: 'Department of Education' },
  'labor':                     { tier: 'toptier', name: 'Department of Labor' },
  'opm':                       { tier: 'toptier', name: 'Office of Personnel Management' },
  'ssa':                       { tier: 'toptier', name: 'Social Security Administration' },
  'nrc':                       { tier: 'toptier', name: 'Nuclear Regulatory Commission' },
  'nsf':                       { tier: 'toptier', name: 'National Science Foundation' },

  // ── DoD subtiers ──────────────────────────────────────────────
  // For each, toptier_name = 'Department of Defense' so USASpending can
  // disambiguate subtiers that share names across toptiers.
  'army':        { tier: 'subtier', name: 'Department of the Army',              toptier_name: 'Department of Defense' },
  'navy':        { tier: 'subtier', name: 'Department of the Navy',              toptier_name: 'Department of Defense' },
  'air force':   { tier: 'subtier', name: 'Department of the Air Force',         toptier_name: 'Department of Defense' },
  'usaf':        { tier: 'subtier', name: 'Department of the Air Force',         toptier_name: 'Department of Defense' },
  'space force': { tier: 'subtier', name: 'United States Space Force',           toptier_name: 'Department of Defense' },
  'ussf':        { tier: 'subtier', name: 'United States Space Force',           toptier_name: 'Department of Defense' },
  'marines':     { tier: 'subtier', name: 'United States Marine Corps',          toptier_name: 'Department of Defense' },
  'usmc':        { tier: 'subtier', name: 'United States Marine Corps',          toptier_name: 'Department of Defense' },

  // Combatant commands
  'socom':       { tier: 'subtier', name: 'U.S. Special Operations Command',     toptier_name: 'Department of Defense' },
  'ussocom':     { tier: 'subtier', name: 'U.S. Special Operations Command',     toptier_name: 'Department of Defense' },
  'cybercom':    { tier: 'subtier', name: 'U.S. Cyber Command',                  toptier_name: 'Department of Defense' },
  'uscybercom':  { tier: 'subtier', name: 'U.S. Cyber Command',                  toptier_name: 'Department of Defense' },
  'stratcom':    { tier: 'subtier', name: 'U.S. Strategic Command',              toptier_name: 'Department of Defense' },
  // TRANSCOM's canonical USASpending subtier is literally "USTRANSCOM" (all caps,
  // no dots, no "U.S. Transportation Command" expansion). Verified by pulling
  // the real subtier list from USASpending's awarding_subagency endpoint.
  // Using "U.S. Transportation Command" here returns zero rows.
  'transcom':    { tier: 'subtier', name: 'USTRANSCOM',                          toptier_name: 'Department of Defense' },
  'ustranscom':  { tier: 'subtier', name: 'USTRANSCOM',                          toptier_name: 'Department of Defense' },
  'centcom':     { tier: 'subtier', name: 'U.S. Central Command',                toptier_name: 'Department of Defense' },
  'eucom':       { tier: 'subtier', name: 'U.S. European Command',               toptier_name: 'Department of Defense' },
  'indopacom':   { tier: 'subtier', name: 'U.S. Indo-Pacific Command',           toptier_name: 'Department of Defense' },
  'northcom':    { tier: 'subtier', name: 'U.S. Northern Command',               toptier_name: 'Department of Defense' },
  'southcom':    { tier: 'subtier', name: 'U.S. Southern Command',               toptier_name: 'Department of Defense' },
  'africom':     { tier: 'subtier', name: 'U.S. Africa Command',                 toptier_name: 'Department of Defense' },
  'jsoc':        { tier: 'subtier', name: 'Joint Special Operations Command',    toptier_name: 'Department of Defense' },

  // DoD defense agencies
  'disa':        { tier: 'subtier', name: 'Defense Information Systems Agency',  toptier_name: 'Department of Defense' },
  'darpa':       { tier: 'subtier', name: 'Defense Advanced Research Projects Agency', toptier_name: 'Department of Defense' },
  'dla':         { tier: 'subtier', name: 'Defense Logistics Agency',            toptier_name: 'Department of Defense' },
  'nsa':         { tier: 'subtier', name: 'National Security Agency',            toptier_name: 'Department of Defense' },
  'mda':         { tier: 'subtier', name: 'Missile Defense Agency',              toptier_name: 'Department of Defense' },
  'dcsa':        { tier: 'subtier', name: 'Defense Counterintelligence and Security Agency', toptier_name: 'Department of Defense' },
  'dfas':        { tier: 'subtier', name: 'Defense Finance and Accounting Service', toptier_name: 'Department of Defense' },
  'dtra':        { tier: 'subtier', name: 'Defense Threat Reduction Agency',     toptier_name: 'Department of Defense' },
  'dha':         { tier: 'subtier', name: 'Defense Health Agency',               toptier_name: 'Department of Defense' },

  // ── DHS subtiers ──────────────────────────────────────────────
  'cisa':        { tier: 'subtier', name: 'Cybersecurity and Infrastructure Security Agency', toptier_name: 'Department of Homeland Security' },
  'fema':        { tier: 'subtier', name: 'Federal Emergency Management Agency', toptier_name: 'Department of Homeland Security' },
  'tsa':         { tier: 'subtier', name: 'Transportation Security Administration', toptier_name: 'Department of Homeland Security' },
  'cbp':         { tier: 'subtier', name: 'U.S. Customs and Border Protection',  toptier_name: 'Department of Homeland Security' },
  'ice':         { tier: 'subtier', name: 'U.S. Immigration and Customs Enforcement', toptier_name: 'Department of Homeland Security' },
  'uscis':       { tier: 'subtier', name: 'U.S. Citizenship and Immigration Services', toptier_name: 'Department of Homeland Security' },
  'uscg':        { tier: 'subtier', name: 'United States Coast Guard',           toptier_name: 'Department of Homeland Security' },
  'secret service': { tier: 'subtier', name: 'United States Secret Service',     toptier_name: 'Department of Homeland Security' },

  // ── DOJ subtiers ──────────────────────────────────────────────
  'fbi':         { tier: 'subtier', name: 'Federal Bureau of Investigation',     toptier_name: 'Department of Justice' },
  'dea':         { tier: 'subtier', name: 'Drug Enforcement Administration',     toptier_name: 'Department of Justice' },
  'atf':         { tier: 'subtier', name: 'Bureau of Alcohol, Tobacco, Firearms, and Explosives', toptier_name: 'Department of Justice' },
  'us marshals': { tier: 'subtier', name: 'United States Marshals Service',      toptier_name: 'Department of Justice' },
  'bop':         { tier: 'subtier', name: 'Federal Bureau of Prisons',           toptier_name: 'Department of Justice' },

  // ── HHS subtiers ──────────────────────────────────────────────
  'cms':         { tier: 'subtier', name: 'Centers for Medicare and Medicaid Services', toptier_name: 'Department of Health and Human Services' },
  'cdc':         { tier: 'subtier', name: 'Centers for Disease Control and Prevention', toptier_name: 'Department of Health and Human Services' },
  'fda':         { tier: 'subtier', name: 'Food and Drug Administration',        toptier_name: 'Department of Health and Human Services' },
  'nih':         { tier: 'subtier', name: 'National Institutes of Health',       toptier_name: 'Department of Health and Human Services' },
  'hrsa':        { tier: 'subtier', name: 'Health Resources and Services Administration', toptier_name: 'Department of Health and Human Services' },
  'ihs':         { tier: 'subtier', name: 'Indian Health Service',               toptier_name: 'Department of Health and Human Services' },

  // ── DOT subtiers ──────────────────────────────────────────────
  'faa':         { tier: 'subtier', name: 'Federal Aviation Administration',     toptier_name: 'Department of Transportation' },
  'fhwa':        { tier: 'subtier', name: 'Federal Highway Administration',      toptier_name: 'Department of Transportation' },
  'fra':         { tier: 'subtier', name: 'Federal Railroad Administration',     toptier_name: 'Department of Transportation' },
  'nhtsa':       { tier: 'subtier', name: 'National Highway Traffic Safety Administration', toptier_name: 'Department of Transportation' },

  // ── Commerce subtiers ─────────────────────────────────────────
  'noaa':        { tier: 'subtier', name: 'National Oceanic and Atmospheric Administration', toptier_name: 'Department of Commerce' },
  'nist':        { tier: 'subtier', name: 'National Institute of Standards and Technology', toptier_name: 'Department of Commerce' },
  'census':      { tier: 'subtier', name: 'U.S. Census Bureau',                  toptier_name: 'Department of Commerce' },
  'uspto':       { tier: 'subtier', name: 'United States Patent and Trademark Office', toptier_name: 'Department of Commerce' },

  // ── Treasury subtiers ─────────────────────────────────────────
  'irs':         { tier: 'subtier', name: 'Internal Revenue Service',            toptier_name: 'Department of the Treasury' },
  'occ':         { tier: 'subtier', name: 'Office of the Comptroller of the Currency', toptier_name: 'Department of the Treasury' },

  // ── State subtiers ────────────────────────────────────────────
  'usaid':       { tier: 'toptier', name: 'Agency for International Development' }, // note: toptier, not under State in USASpending
};


// ─────────────────────────────────────────────────────────────────────
// PROGRAM OFFICES — acronyms whose contracts lurk UNDER a subtier
// ─────────────────────────────────────────────────────────────────────
//
// These are offices like AFLCMC (Air Force Life Cycle Management Center)
// that are NOT clean USASpending subtiers but ARE constantly referenced
// by federal sellers. Strategy: filter by the parent subtier AND add
// the acronym + full name as keywords. The agency filter narrows the
// scope to the right service; the keywords pull in descriptions that
// mention the office by name.
// ─────────────────────────────────────────────────────────────────────

const PROGRAM_OFFICES = {
  // Air Force centers
  'aflcmc':  { fullName: 'Air Force Life Cycle Management Center', parent: 'air force' },
  'afrl':    { fullName: 'Air Force Research Laboratory',           parent: 'air force' },
  'afmc':    { fullName: 'Air Force Materiel Command',              parent: 'air force' },
  'acc':     { fullName: 'Air Combat Command',                      parent: 'air force' },
  'afsoc':   { fullName: 'Air Force Special Operations Command',    parent: 'air force' },
  'afgsc':   { fullName: 'Air Force Global Strike Command',         parent: 'air force' },
  'amc-af':  { fullName: 'Air Mobility Command',                    parent: 'air force' },
  'pacaf':   { fullName: 'Pacific Air Forces',                      parent: 'air force' },
  'usafe':   { fullName: 'U.S. Air Forces in Europe',               parent: 'air force' },

  // Space Force
  'smc':     { fullName: 'Space and Missile Systems Center',        parent: 'space force' },
  'ssc':     { fullName: 'Space Systems Command',                   parent: 'space force' },

  // Navy commands
  'navair':  { fullName: 'Naval Air Systems Command',               parent: 'navy' },
  'navsea':  { fullName: 'Naval Sea Systems Command',               parent: 'navy' },
  'navwar':  { fullName: 'Naval Information Warfare Systems Command', parent: 'navy' },
  'spawar':  { fullName: 'Naval Information Warfare Systems Command', parent: 'navy' }, // legacy name for NAVWAR
  'navsup':  { fullName: 'Naval Supply Systems Command',            parent: 'navy' },
  'navfac':  { fullName: 'Naval Facilities Engineering Command',    parent: 'navy' },
  'onr':     { fullName: 'Office of Naval Research',                parent: 'navy' },
  'niwc':    { fullName: 'Naval Information Warfare Center',        parent: 'navy' },
  'nswc':    { fullName: 'Naval Surface Warfare Center',            parent: 'navy' },
  'nuwc':    { fullName: 'Naval Undersea Warfare Center',           parent: 'navy' },

  // Army commands
  'amc':        { fullName: 'Army Materiel Command',                parent: 'army' },
  'cecom':      { fullName: 'Army Communications-Electronics Command', parent: 'army' },
  'smdc':       { fullName: 'Army Space and Missile Defense Command', parent: 'army' },
  'netcom':     { fullName: 'Network Enterprise Technology Command', parent: 'army' },
  'erdc':       { fullName: 'Army Engineer Research and Development Center', parent: 'army' },
  'peo c3n':    { fullName: 'PEO Command Control Communications-Tactical', parent: 'army' },
  'peo c3t':    { fullName: 'PEO Command Control Communications-Tactical', parent: 'army' },
  'peo iews':   { fullName: 'PEO Intelligence Electronic Warfare Sensors', parent: 'army' },
  'peo eis':    { fullName: 'PEO Enterprise Information Systems',   parent: 'army' },
};


// ─────────────────────────────────────────────────────────────────────
// VENDOR LEGAL NAMES — common short names → USASpending recipient strings
// ─────────────────────────────────────────────────────────────────────
//
// USASpending indexes recipients by legal entity name. "Booz" in casual
// speech is "BOOZ ALLEN HAMILTON" in the data. Without this map, a search
// for "Booz" against the keywords filter hits contract descriptions that
// mention Booz, not Booz's contracts as the recipient.
//
// Resolver uses these for the `recipient_names` output (which becomes an
// after-fetch filter against the Recipient Name field, since USASpending's
// API doesn't support exact recipient-name filtering directly — it has
// `recipient_search_text` but that's fuzzy and OR-tokenized).
// ─────────────────────────────────────────────────────────────────────

const VENDOR_LEGAL_NAMES = {
  'aws':                   'AMAZON WEB SERVICES',
  'amazon web services':   'AMAZON WEB SERVICES',
  'microsoft':             'MICROSOFT CORPORATION',
  'msft':                  'MICROSOFT CORPORATION',
  'google':                'GOOGLE',              // Google LLC + subsidiaries
  'gcp':                   'GOOGLE',
  'oracle':                'ORACLE',
  'salesforce':            'SALESFORCE',
  'servicenow':            'SERVICENOW',
  'snowflake':             'SNOWFLAKE',
  'databricks':            'DATABRICKS',
  'palantir':              'PALANTIR',

  'ibm':                   'INTERNATIONAL BUSINESS MACHINES',
  'hpe':                   'HEWLETT PACKARD ENTERPRISE',
  'dell':                  'DELL',
  'cisco':                 'CISCO',

  'splunk':                'SPLUNK',
  'elastic':               'ELASTICSEARCH',
  'datadog':               'DATADOG',
  'sonatype':              'SONATYPE',
  'snyk':                  'SNYK',
  'crowdstrike':           'CROWDSTRIKE',
  'sentinelone':           'SENTINELONE',
  'tenable':               'TENABLE',
  'rapid7':                'RAPID7',
  'okta':                  'OKTA',
  'sailpoint':             'SAILPOINT',
  'cyberark':              'CYBERARK',
  'zscaler':               'ZSCALER',
  'palo alto':             'PALO ALTO NETWORKS',
  'fortinet':              'FORTINET',
  'cloudflare':             'CLOUDFLARE',

  // CDN & edge security — needed for Akamai competitor resolution. F5 is
  // the critical one: its acronym "F5" is 2 chars, which USASpending
  // rejects as a keyword ("value 'F5' is below min '3' items"). The
  // legal-name mapping below converts "F5" into "F5 NETWORKS" before it
  // ever reaches the API, and the filter in the resolver drops any
  // remaining <3-char forms.
  'akamai':                'AKAMAI TECHNOLOGIES',
  'f5':                    'F5 NETWORKS',
  'f5 networks':           'F5 NETWORKS',
  'fastly':                'FASTLY',
  'imperva':               'IMPERVA',
  'cloudfront':            'AMAZON',  // CloudFront is an AWS service, not a separate recipient

  'leidos':                'LEIDOS',
  'booz':                  'BOOZ ALLEN HAMILTON',
  'booz allen':            'BOOZ ALLEN HAMILTON',
  'gdit':                  'GENERAL DYNAMICS INFORMATION TECHNOLOGY',
  'general dynamics':      'GENERAL DYNAMICS',
  'saic':                  'SCIENCE APPLICATIONS INTERNATIONAL',
  'lockheed':              'LOCKHEED MARTIN',
  'northrop':              'NORTHROP GRUMMAN',
  'raytheon':              'RAYTHEON',
  'l3harris':              'L3HARRIS',
  'mantech':               'MANTECH',
  'peraton':               'PERATON',
  'caci':                  'CACI',
  'accenture federal':     'ACCENTURE FEDERAL SERVICES',
  'deloitte':              'DELOITTE',
  'maximus':               'MAXIMUS',
  'kbr':                   'KBR',
  'bah':                   'BOOZ ALLEN HAMILTON',

  'carahsoft':             'CARAHSOFT TECHNOLOGY',
  'wwt':                   'WORLD WIDE TECHNOLOGY',
  'world wide technology': 'WORLD WIDE TECHNOLOGY',
  'govplace':              'GOVPLACE',
  'fcn':                   'FCN',
  'thundercat':            'THUNDERCAT TECHNOLOGY',
  'four points':           'FOUR POINTS TECHNOLOGY',
  'immixgroup':            'IMMIXGROUP',
};


// ─────────────────────────────────────────────────────────────────────
// Utility: normalize + lookup
// ─────────────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().trim()
  .replace(/[.,]/g, '')
  .replace(/\s+/g, ' ');

// ─────────────────────────────────────────────────────────────────────
// entities.json — auto-refreshed USASpending subtier + toptier dictionary
// ─────────────────────────────────────────────────────────────────────
//
// Generated by scripts/build-entities.mjs. Loaded once when resolver.js is
// imported; becomes a read-only lookup used as a FALLBACK after hand-curated
// AGENCIES. Hand-curated entries always win, which is why broken cases like
// CENTCOM stay broken until we explicitly fix them — entities.json is a
// safety net for the tail of obscure subtiers, not an override of deliberate
// tuning.
//
// Load is best-effort. If entities.json is missing or malformed, resolver
// falls through to hand-curated tables only — the pre-entities behavior.
// This keeps the resolver working if someone forgets to run the script or
// the file hasn't been generated yet.
//
// Callers that need to block on load can `await resolverReady` before
// calling resolve(). Most callers don't bother; the entities fallback is
// only used for agencies the hand-curated table doesn't know, and that
// path is tolerant of an empty entities table (falls through to keyword
// search, same as if the agency term is unknown).
// ─────────────────────────────────────────────────────────────────────

let _entities = {};       // { searchKey: [entityObj, ...] }
let _entitiesLoaded = false;

export const resolverReady = (async () => {
  // Where to load from. Same directory as this module, as a plain static
  // file. If resolver.js moves, this URL will move with it thanks to
  // import.meta.url.
  try {
    const url = new URL('./entities.json', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[resolver] entities.json fetch failed: HTTP ${res.status}. Falling back to hand-curated tables only.`);
      _entitiesLoaded = true;
      return;
    }
    const data = await res.json();
    if (data && typeof data.entities === 'object' && data.entities !== null) {
      _entities = data.entities;
      _entitiesLoaded = true;
      // Don't log entity count on success — keeps console clean in production.
    } else {
      console.warn('[resolver] entities.json has unexpected shape. Falling back to hand-curated tables only.');
      _entitiesLoaded = true;
    }
  } catch (err) {
    // Network error, CORS, JSON parse error, etc. Non-fatal.
    console.warn('[resolver] entities.json load error:', err.message, '— falling back to hand-curated tables only.');
    _entitiesLoaded = true;
  }
})();

// Look up an agency term in entities.json. Returns the first match as a
// USASpending-shaped filter object, or null if no match.
//
// entities.json keys are pre-normalized (lowercase, no dots, collapsed
// whitespace) by the build script using the same norm rules as below.
function lookupEntitiesAgency(term) {
  if (!_entitiesLoaded || !_entities) return null;
  const key = norm(term);
  const hits = _entities[key];
  if (!hits || hits.length === 0) return null;
  // Take the first hit. Multiple matches happen when subtier names collide
  // (e.g., "Office of Inspector General" exists under multiple toptiers) —
  // first-match is arbitrary but consistent. If real users hit ambiguity
  // problems, we'll add a "did you mean?" UX layer later.
  const h = hits[0];
  return {
    tier: h.tier,
    name: h.name,
    toptier_name: h.toptier_name || h.name,
  };
}

// Two-stage agency lookup: hand-curated first, entities.json as fallback.
// Hand-curated wins because that's where we document deliberate overrides
// (TRANSCOM=USTRANSCOM, SOCOM's nickname mapping, etc.). Entities.json
// catches the long tail — obscure subtiers we haven't hand-tuned.
const lookupAgency  = (term) => {
  return AGENCIES[norm(term)] || lookupEntitiesAgency(term) || null;
};
const lookupOffice  = (term) => PROGRAM_OFFICES[norm(term)] || null;
const lookupVendor  = (term) => {
  const n = norm(term);
  if (VENDOR_LEGAL_NAMES[n]) return VENDOR_LEGAL_NAMES[n];
  // If the caller passes an already-canonical name (uppercase legal entity)
  // just echo it back so searches for "LEIDOS INNOVATIONS INC" still work.
  return String(term || '').toUpperCase().trim();
};

// ─────────────────────────────────────────────────────────────────────
// deriveShortForm — strip entity suffixes + common category words so a
// legal name like 'DELOITTE CONSULTING LLP' becomes just 'DELOITTE'.
//
// Why this exists: USASpending's Prime Recipient Name field uses the
// legal name (e.g. 'DELOITTE CONSULTING LLP'), but the Sub-Awardee Name
// field often uses shorter forms. USASpending's `keywords` filter is
// token-contains across BOTH fields, so sending ONLY the full legal
// name misses as-prime rows where the prime field happens to have
// a shorter registered name (e.g., 'DELOITTE' alone), while sending
// ONLY the short name misses rows where USASpending stored the full
// legal entity.
//
// Sending BOTH solves it. For vendors in the hand-curated alias table
// (GDIT → GENERAL DYNAMICS INFORMATION TECHNOLOGY + GDIT) that already
// works. This helper generalizes it so ANY vendor gets the same
// treatment without needing an alias entry. Probe data confirms this
// unlocks as-prime data for Deloitte (2→10), SAIC (1→24), Booz Allen
// (2→7), and should do the same for every integrator and reseller we
// haven't yet hand-curated.
//
// Input:  a normalized uppercase legal name (already suffix-stripped
//         by norm(), but we do our own cleanup too for safety)
// Output: the short form, or null if the short form would be identical
//         to the input, below the 3-char USASpending minimum, or empty.
// ─────────────────────────────────────────────────────────────────────
const _SHORT_FORM_NOISE = new Set([
  // Entity suffixes (most already stripped by norm(), but safety-net)
  'INC','LLC','CORP','CORPORATION','INCORPORATED','COMPANY','CO','LTD',
  'LP','PC','PLLC','LLP',
  // Category words that bloat a legal name without disambiguating it
  'TECHNOLOGY','TECHNOLOGIES','CONSULTING','SOLUTIONS','SERVICES',
  'SYSTEMS','FEDERAL','INTERNATIONAL','INDUSTRIES','HOLDINGS','GROUP',
  'ENTERPRISES','PARTNERS','ASSOCIATES','AMERICA','GLOBAL','USA',
]);

const deriveShortForm = (legalName) => {
  const raw = String(legalName || '').toUpperCase().trim();
  if (!raw) return null;

  // Split into word tokens. Strip trailing periods so 'INC.' matches 'INC'
  // in the noise set. USASpending legal names are already uppercase-normalized
  // by this point, but raw user input may still carry punctuation.
  const tokens = raw.split(/[\s,]+/)
    .map(t => t.replace(/\.$/, ''))
    .filter(Boolean);
  if (tokens.length === 0) return null;

  // Drop trailing noise tokens. We walk from the end because leading
  // tokens are almost always the brand (DELOITTE, CARAHSOFT, GENERAL),
  // and trailing tokens are the category/entity descriptors we want
  // to shed. Stop as soon as we hit a non-noise token — don't remove
  // noise words from the middle (BOOZ ALLEN HAMILTON has no noise).
  const kept = [...tokens];
  while (kept.length > 1 && _SHORT_FORM_NOISE.has(kept[kept.length - 1])) {
    kept.pop();
  }

  // Edge case: the only surviving token is itself a noise word. Happens
  // with inputs like 'CONSULTING SERVICES' which would reduce to just
  // 'CONSULTING'. That's not a usable brand keyword — return null so the
  // caller falls back to the legal name alone.
  if (kept.length === 1 && _SHORT_FORM_NOISE.has(kept[0])) return null;

  const short = kept.join(' ');
  // Skip if the short form is identical to the input (no trimming happened)
  if (short === raw) return null;
  // Skip if USASpending would reject it for being too short
  if (short.length < 3) return null;

  return short;
};


// ─────────────────────────────────────────────────────────────────────
// resolve() — main entry point
// ─────────────────────────────────────────────────────────────────────
//
// Input: a plain object with any of these keys (all optional):
//   vendor        — single vendor name (natural)
//   vendors       — array of vendor names, or comma-separated string
//   agency        — single agency name (natural) — includes program offices
//   topic         — free-text topic keywords (1-2 words ideally)
//   topics        — array of topics
//   naics         — single NAICS code or array
//   psc           — single PSC code or array
//   expiring_only — boolean
//   min_amount    — number
//   max_amount    — number
//
// Output: { filters, postFilters } where:
//   filters — the object to send to USASpending's /search/spending_by_award/
//   postFilters — client-side checks to apply after the fetch returns:
//     { agency_scope, vendor_scope } — both optional
//
// The split exists because USASpending's filter matching is loose (keywords
// match both descriptions and recipients, subtier filters sometimes bleed
// into siblings). The postFilters are safety nets that enforce scope
// rigorously on the returned rows.
// ─────────────────────────────────────────────────────────────────────

export function resolve(input) {
  const filters = {
    // Caller is expected to add time_period and award_type_codes.
    // The resolver only handles the semantic filters.
  };
  const postFilters = {};

  // ── Keywords (topic) ────────────────────────────────────────────
  //
  // USASpending's keyword filter appears to reject strings under ~3
  // characters with a 422 error, and very short strings match too much
  // noise even when they're accepted. Federal sellers type these short
  // forms constantly ("IT", "AI", "ML", "HR"), so we expand known
  // acronyms to their federal-description equivalents before sending.
  //
  // Some acronyms expand to MULTIPLE keywords because contract writers
  // don't agree on one phrasing — USASpending ORs keywords together, so
  // expanding "GenAI" to all three of artificial intelligence, machine
  // learning, and generative AI gives the broadest real match against
  // how the work is actually described in contract text.
  //
  // Anything short and unknown gets dropped; if the list ends up empty,
  // the caller treats this like a no-keyword query (typically falling
  // through to the category-fallback path in stream-client.js).
  const AI_FAMILY = ['artificial intelligence', 'machine learning', 'generative AI'];
  const FOOD_FAMILY = ['subsistence', 'food service', 'perishable', 'produce', 'fresh fruit', 'fresh vegetable'];
  const TOPIC_EXPANSIONS = {
    'it': ['information technology'],
    'ai': AI_FAMILY,
    'ai/ml': AI_FAMILY,
    'ml': AI_FAMILY,
    'genai': AI_FAMILY,
    'gen ai': AI_FAMILY,
    'generative ai': AI_FAMILY,
    'llm': AI_FAMILY,
    'llms': AI_FAMILY,
    'sbom': ['software bill of materials', 'software supply chain', 'SBOM'],
    'zt': ['zero trust'],
    'zta': ['zero trust'],
    'zero trust': ['zero trust'],
    'siem': ['SIEM', 'security information', 'log management'],
    'edr': ['endpoint detection', 'EDR', 'endpoint protection'],
    'xdr': ['XDR', 'extended detection'],
    'cdn': ['content delivery', 'CDN'],
    'apm': ['application performance', 'APM', 'observability'],
    'fedramp': ['FedRAMP', 'cloud authorization'],
    'cmmc': ['CMMC', 'cybersecurity maturity'],
    'cyber': ['cybersecurity', 'cyber security', 'cyber'],
    // Food commodities — federal contracts use DLA's "subsistence" vocabulary,
    // not the seller's everyday terms. Without this, a "bananas to DoD" pitch
    // loose-matches "producer" in defense-industrial descriptions and returns
    // tank ammunition contracts. Map commodity words to federal phrasing.
    'bananas': FOOD_FAMILY,
    'banana': FOOD_FAMILY,
    'produce': FOOD_FAMILY,
    'fruit': FOOD_FAMILY,
    'fruits': FOOD_FAMILY,
    'vegetables': FOOD_FAMILY,
    'meat': ['subsistence', 'food service', 'meat', 'protein'],
    'dairy': ['subsistence', 'food service', 'dairy'],
    'hr': ['human resources'],
    'cx': ['customer experience'],
    'rf': ['radio frequency'],
    'ir': ['infrared'],
    'qa': ['quality assurance'],
    'qc': ['quality control'],
    'ot': ['operational technology'],
  };
  const rawTopics = []
    .concat(input.topic ? [input.topic] : [])
    .concat(Array.isArray(input.topics) ? input.topics : [])
    .map(t => String(t || '').trim())
    .filter(Boolean);

  const topics = [];
  for (const t of rawTopics) {
    const lower = t.toLowerCase();
    if (TOPIC_EXPANSIONS[lower]) {
      topics.push(...TOPIC_EXPANSIONS[lower]);
    } else if (t.length >= 3) {
      topics.push(t);
    }
    // else: silently drop short unknown strings (USASpending would 422 on them)
  }

  // ── Vendor resolution ──────────────────────────────────────────
  // Accept either `vendor` (single) or `vendors` (array or comma-separated).
  let vendorInputs = [];
  if (input.vendor) vendorInputs.push(input.vendor);
  if (Array.isArray(input.vendors)) {
    vendorInputs.push(...input.vendors);
  } else if (typeof input.vendors === 'string') {
    vendorInputs.push(...input.vendors.split(',').map(s => s.trim()).filter(Boolean));
  }
  vendorInputs = vendorInputs.map(v => String(v || '').trim()).filter(Boolean);

  if (vendorInputs.length > 0) {
    const legalNames = vendorInputs.map(lookupVendor);
    // Send BOTH forms as keywords to USASpending: the legal name AND the
    // raw input (e.g., ['GENERAL DYNAMICS INFORMATION TECHNOLOGY', 'GDIT']).
    // USASpending's keyword filter appears to do token-contains across
    // prime + sub fields and descriptions; the legal form and the short
    // form often hit different records. This matters most in subaward
    // mode — searching just 'GENERAL DYNAMICS INFORMATION TECHNOLOGY'
    // returns GDIT-as-sub rows, while adding 'GDIT' unlocks the
    // GDIT-as-prime rows because those use the short form in the Prime
    // Recipient Name field. Verified via USASpending probe, April 2026.
    //
    // Beyond the explicit short form from raw input, we also DERIVE a
    // short form from every legal name (DELOITTE CONSULTING → DELOITTE,
    // CARAHSOFT TECHNOLOGY → CARAHSOFT, AMAZON WEB SERVICES → AMAZON WEB).
    // This unlocks as-prime data for vendors whose alias entries are
    // incomplete, AND for vendors not in the alias table at all. The
    // probe showed Deloitte going from 2 → 10 prime rows and SAIC from
    // 1 → 24 prime rows with this change, which are huge improvements
    // for BDR use cases.
    //
    // Every keyword MUST be ≥3 characters or USASpending rejects the
    // whole request with a 422: {"detail":"Field 'filters|keywords'
    // value 'F5' is below min '3' items"}. Competitor lists may contain
    // short names like 'F5' or 'C3' — those get dropped at the keyword
    // stage but stay in postFilters.vendor_scope for client-side match.
    const keywordSet = new Set();
    for (const n of legalNames) {
      if (String(n || '').trim().length >= 3) keywordSet.add(n);
    }
    for (const raw of vendorInputs) {
      const short = String(raw || '').trim();
      if (short.length >= 3) keywordSet.add(short.toUpperCase());
    }
    // Derived short forms from each legal name
    for (const legal of legalNames) {
      const derived = deriveShortForm(legal);
      if (derived) keywordSet.add(derived);
    }
    topics.push(...keywordSet);

    // Post-filter needles mirror the keyword set. Recipient fields on
    // USASpending use the legal name; descriptions use short forms.
    // Carry both so applyPostFilters can match either.
    postFilters.vendor_scope = [...keywordSet];

    // Also stash the legal names separately so the subaward direction
    // filter in stream-client can match against them without re-running
    // the lookup. vendor_scope contains BOTH raw and legal forms mixed;
    // this field is just the legal-form subset.
    postFilters.vendor_legal_names = legalNames
      .filter(n => String(n || '').trim().length >= 3)
      .map(n => String(n).toUpperCase());
  }

  // ── Agency resolution ──────────────────────────────────────────
  // If the agency input is a known program office, we emit both the parent
  // subtier agency filter AND add the office acronym + full name as keywords.
  // Otherwise, straight agency lookup.
  if (input.agency) {
    const agencyTerm = String(input.agency).trim();
    const office = lookupOffice(agencyTerm);
    let agency = office ? lookupAgency(office.parent) : lookupAgency(agencyTerm);

    // Fallback: if the full string doesn't match but it contains a known
    // parent agency (e.g. "DHS Office of Procurement Operations" contains
    // "DHS"), match to the parent and treat the rest as a keyword hint.
    // This catches the common pattern where Mo or the user combines a
    // toptier with a sub-agency label that we don't have in our table.
    // Without this fallback, the agency filter silently drops and the
    // query becomes fed-wide — producing a card that's wildly wrong.
    let agencyResidue = null;
    if (!agency && !office) {
      const normTerm = norm(agencyTerm);
      // Find ALL aliases that match the term as whole words. Prefer
      // subtier matches over toptier matches — in composite inputs like
      // "DoD SOCOM" or "DHS TSA," both the parent acronym and the sub
      // acronym match. The right filter is the narrower one (the
      // subtier). If only toptier matches exist, fall back to the
      // longest toptier (so "department of defense" beats "defense").
      const aliasKeys = Object.keys(AGENCIES);
      const subtierMatches = [];
      const toptierMatches = [];
      for (const alias of aliasKeys) {
        const aliasRegex = new RegExp(`(^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
        if (aliasRegex.test(normTerm)) {
          const entry = AGENCIES[alias];
          const target = entry.tier === 'subtier' ? subtierMatches : toptierMatches;
          target.push({ alias, entry, aliasRegex });
        }
      }

      let pick = null;
      if (subtierMatches.length > 0) {
        // Prefer the longest subtier alias — avoids picking up a short
        // false-positive when a longer one is present.
        subtierMatches.sort((a, b) => b.alias.length - a.alias.length);
        pick = subtierMatches[0];
      } else if (toptierMatches.length > 0) {
        toptierMatches.sort((a, b) => b.alias.length - a.alias.length);
        pick = toptierMatches[0];
      }

      if (pick) {
        agency = pick.entry;
        const rawResidue = normTerm.replace(pick.aliasRegex, ' ').trim();

        // ── Subtier match + parent residue → discard residue ─────
        // If the matched alias is a subtier, any residue is almost
        // always the parent toptier ("DoD SOCOM" → matched "socom"
        // subtier, residue "dod"). That's redundant — the subtier
        // filter already scopes to the parent. Pushing "dod" as an
        // office_scope substring makes the post-filter drop every
        // row whose Awarding Office/Sub Agency doesn't literally
        // contain "dod" (most DoD rows show the sub-agency name
        // like "Department of the Navy", not "dod"). This was the
        // original bug behind "DHS CISA returns nothing" and
        // "DoD SOCOM over-filters."
        if (agency.tier === 'subtier') {
          const parentToptier = agency.toptier_name || '';
          const residueIsParent = rawResidue && (
            norm(parentToptier).includes(rawResidue) ||
            rawResidue === 'dod' || rawResidue === 'hhs' ||
            rawResidue === 'dhs' || rawResidue === 'doj' ||
            rawResidue === 'dot' || rawResidue === 'doe' ||
            rawResidue === 'va'  || rawResidue === 'gsa' ||
            rawResidue === 'treasury' || rawResidue === 'commerce' ||
            rawResidue === 'interior' || rawResidue === 'labor' ||
            rawResidue === 'energy' || rawResidue === 'justice' ||
            rawResidue === 'state' || rawResidue === 'education' ||
            rawResidue === 'agriculture' || rawResidue === 'transportation' ||
            rawResidue === 'homeland security' ||
            rawResidue === 'health and human services' ||
            rawResidue === 'veterans affairs'
          );
          if (residueIsParent) {
            // Matched subtier is the RIGHT filter. Discard residue.
            agencyResidue = null;
          } else if (rawResidue.length >= 3) {
            agencyResidue = rawResidue;
          }
        } else {
          // Toptier match — residue is a real office/subagency hint.
          // Expand it through the alias table if possible so the
          // post-filter substring check matches against the real
          // data field values (USASpending returns full canonical
          // names in Awarding Sub Agency, not acronyms).
          if (rawResidue.length >= 3) {
            const expanded = AGENCIES[rawResidue];
            if (expanded && expanded.name) {
              // e.g. residue "cms" → needle "centers for medicare and medicaid services"
              agencyResidue = norm(expanded.name);
            } else {
              agencyResidue = rawResidue;
            }
          }
        }
      }
    }

    if (agency) {
      filters.agencies = [{ ...agency, type: 'awarding' }];
      postFilters.agency_scope = agency;
      if (agencyResidue) {
        // Post-filter only — no keyword push. Adding the residue as a
        // USASpending keyword forces the API to match it against the
        // contract description, which returns almost nothing because
        // descriptions talk about WORK not OFFICES. Example: querying
        // "DHS Office of Procurement Operations" with keyword filter
        // returned 3 rows ($2M total) even though the actual OPO
        // footprint is hundreds of contracts. The post_filter below
        // narrows the returned rows to those whose Awarding Office
        // OR Awarding Sub Agency contains the residue — real scoping
        // without poisoning the upstream query.
        postFilters.office_scope = agencyResidue;
      }
    } else {
      // Unknown agency — fall through to keywords. Better a keyword search
      // than silent no-op. User might have typed a legitimate agency we
      // just don't have in our table.
      topics.push(agencyTerm);
    }

    if (office) {
      topics.push(agencyTerm.toUpperCase(), office.fullName);
    }
  }

  if (topics.length > 0) {
    filters.keywords = [...new Set(topics)]; // dedupe
  }

  // ── NAICS / PSC ─────────────────────────────────────────────────
  const naicsList = []
    .concat(Array.isArray(input.naics) ? input.naics : input.naics ? [input.naics] : [])
    .map(n => String(n).trim())
    .filter(n => /^\d{6}$/.test(n));
  if (naicsList.length > 0) filters.naics_codes = { require: naicsList };

  const pscList = []
    .concat(Array.isArray(input.psc) ? input.psc : input.psc ? [input.psc] : [])
    .map(p => String(p).trim().toUpperCase())
    .filter(p => /^[A-Z][A-Z0-9]{1,3}$/.test(p));
  if (pscList.length > 0) filters.psc_codes = pscList;

  // ── Amount / expiring — these are post-filters applied client-side ──
  // USASpending's API supports award_amounts but it's finicky; simpler to
  // return everything and slice in the browser.
  if (input.expiring_only) postFilters.expiring_only = true;
  if (typeof input.min_amount === 'number') postFilters.min_amount = input.min_amount;
  if (typeof input.max_amount === 'number') postFilters.max_amount = input.max_amount;

  return { filters, postFilters };
}


// ─────────────────────────────────────────────────────────────────────
// applyPostFilters — run the client-side checks against returned rows
// ─────────────────────────────────────────────────────────────────────
//
// Given the raw USASpending response rows and the postFilters object from
// resolve(), return the filtered+sorted rows.
// ─────────────────────────────────────────────────────────────────────

export function applyPostFilters(rows, postFilters) {
  if (!Array.isArray(rows)) return [];
  let out = rows;

  if (postFilters.agency_scope) {
    const wanted = postFilters.agency_scope;
    const wantedName = (wanted.name || '').toLowerCase();
    const stripPrefix = (s) => (s || '').toLowerCase().replace(/^department of the /, '');
    const needle = stripPrefix(wantedName);
    if (wanted.tier === 'subtier' && needle) {
      out = out.filter(r => {
        const sub = (r['Awarding Sub Agency'] || '').toLowerCase();
        const top = (r['Awarding Agency']    || '').toLowerCase();
        return sub === wantedName
            || sub.includes(needle)
            || top === wantedName
            || top.includes(needle);
      });
    }
  }

  // Office-level narrowing. Used when a compound-agency input like
  // "DHS Office of Procurement Operations" was parsed — the parent
  // subtier (DHS) went into the API filter, and the office residue
  // ("office of procurement operations") lands here to narrow the
  // already-returned rows. Matches the Awarding Office field, which
  // is populated by USASpending for most civilian contracts and by
  // our offices.json decode for DoD contracts.
  if (postFilters.office_scope) {
    const officeNeedle = String(postFilters.office_scope).toLowerCase().trim();
    if (officeNeedle.length >= 3) {
      out = out.filter(r => {
        const office = (r['Awarding Office'] || '').toLowerCase();
        const sub = (r['Awarding Sub Agency'] || '').toLowerCase();
        return office.includes(officeNeedle) || sub.includes(officeNeedle);
      });
    }
  }

  if (postFilters.vendor_scope && postFilters.vendor_scope.length > 0) {
    // Match EITHER the Recipient Name OR the contract Description.
    //
    // Why: for platform vendors like AWS, Splunk, or Palantir, a huge share
    // of their federal footprint flows through:
    //   - Resellers/VARs (Carahsoft, Four Points, immixGroup, WWT)
    //   - Integrators/primes (GDIT, Booz, Northrop, Leidos)
    // The recipient on those contracts is the reseller or integrator, NOT
    // the platform vendor. But the contract description almost always names
    // the platform ("AWS cloud services", "Splunk licenses for SOCOM",
    // "Palantir Gotham professional services"). Matching description lets
    // us keep those rows and show the real footprint.
    //
    // The keyword already sent to USASpending ensures the API returns only
    // rows that mention the vendor somewhere (description OR recipient), so
    // this filter is the browser's final "is this actually about X" check.
    const needles = postFilters.vendor_scope.map(v => v.toLowerCase());
    out = out.filter(r => {
      const recipient = (r['Recipient Name'] || '').toLowerCase();
      const description = (r['Description'] || '').toLowerCase();
      return needles.some(n => recipient.includes(n) || description.includes(n));
    });
  }

  const now = Date.now();
  if (postFilters.expiring_only) {
    const in90 = now + 90 * 86400_000;
    out = out.filter(r => {
      const end = r._endTs || (r['End Date'] ? new Date(r['End Date']).getTime() : 0);
      return end > now && end <= in90;
    });
  }

  if (typeof postFilters.min_amount === 'number') {
    out = out.filter(r => (parseFloat(r['Award Amount']) || 0) >= postFilters.min_amount);
  }
  if (typeof postFilters.max_amount === 'number') {
    out = out.filter(r => (parseFloat(r['Award Amount']) || 0) <= postFilters.max_amount);
  }

  return out;
}


// ─────────────────────────────────────────────────────────────────────
// Debug helpers — export the tables so tests / introspection tools work
// ─────────────────────────────────────────────────────────────────────

export const _TABLES = {
  AGENCIES,
  PROGRAM_OFFICES,
  VENDOR_LEGAL_NAMES,
};

// Exported for tests
export const _deriveShortForm = deriveShortForm;
