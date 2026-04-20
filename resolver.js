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
  'transcom':    { tier: 'subtier', name: 'U.S. Transportation Command',         toptier_name: 'Department of Defense' },
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
  'cloudflare':            'CLOUDFLARE',

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

const lookupAgency  = (term) => AGENCIES[norm(term)] || null;
const lookupOffice  = (term) => PROGRAM_OFFICES[norm(term)] || null;
const lookupVendor  = (term) => {
  const n = norm(term);
  if (VENDOR_LEGAL_NAMES[n]) return VENDOR_LEGAL_NAMES[n];
  // If the caller passes an already-canonical name (uppercase legal entity)
  // just echo it back so searches for "LEIDOS INNOVATIONS INC" still work.
  return String(term || '').toUpperCase().trim();
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
  const topics = []
    .concat(input.topic ? [input.topic] : [])
    .concat(Array.isArray(input.topics) ? input.topics : [])
    .map(t => String(t || '').trim())
    .filter(Boolean);

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
    // Send vendor names as keywords to USASpending (it matches keywords
    // against recipient names as well as descriptions).
    topics.push(...legalNames);
    // Post-filter: drop contracts whose Recipient Name doesn't contain one
    // of the legal names. Uses substring match so "BOOZ ALLEN" catches
    // "BOOZ ALLEN HAMILTON INC." variants.
    postFilters.vendor_scope = legalNames;
  }

  // ── Agency resolution ──────────────────────────────────────────
  // If the agency input is a known program office, we emit both the parent
  // subtier agency filter AND add the office acronym + full name as keywords.
  // Otherwise, straight agency lookup.
  if (input.agency) {
    const agencyTerm = String(input.agency).trim();
    const office = lookupOffice(agencyTerm);
    const agency = office ? lookupAgency(office.parent) : lookupAgency(agencyTerm);

    if (agency) {
      filters.agencies = [{ ...agency, type: 'awarding' }];
      postFilters.agency_scope = agency;
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

  if (postFilters.vendor_scope && postFilters.vendor_scope.length > 0) {
    const needles = postFilters.vendor_scope.map(v => v.toLowerCase());
    out = out.filter(r => {
      const recipient = (r['Recipient Name'] || '').toLowerCase();
      return needles.some(n => recipient.includes(n));
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
