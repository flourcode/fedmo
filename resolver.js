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
  'hp':                    'HEWLETT PACKARD',
  'hpe':                   'HEWLETT PACKARD ENTERPRISE',
  'hpi':                   'HP INC',
  'dell':                  'DELL',
  'cisco':                 'CISCO',
  'sap':                   'SAP',
  'dxc':                   'DXC TECHNOLOGY',
  '3m':                    '3M COMPANY',
  'ge':                    'GENERAL ELECTRIC',
  'att':                   'AT&T',
  'att corp':              'AT&T',

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
  'rtx':                   'RAYTHEON',
  'l3harris':              'L3HARRIS',
  'mantech':               'MANTECH',
  'peraton':               'PERATON',
  'caci':                  'CACI',
  'accenture':             'ACCENTURE FEDERAL SERVICES',
  'accenture federal':     'ACCENTURE FEDERAL SERVICES',
  'deloitte':              'DELOITTE CONSULTING',
  'deloitte consulting':   'DELOITTE CONSULTING',
  'maximus':               'MAXIMUS',
  'kbr':                   'KBR',
  'bah':                   'BOOZ ALLEN HAMILTON',
  'cgi':                   'CGI FEDERAL',
  'cgi federal':           'CGI FEDERAL',
  'amazon':                'AMAZON WEB SERVICES',
  'jfrog':                 'JFROG',

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
// VENDOR_EXCLUDES — per-vendor collision phrases to reject at post-filter
// ─────────────────────────────────────────────────────────────────────
//
// Some vendor names collide with unrelated federal contract phrases
// even after word-boundary matching. The word "SAP" is a 3-letter
// acronym that appears as a WHOLE WORD in:
//   - SAP (the vendor, ERP/HANA/Ariba work)
//   - Substance Abuse Program (SAP) — Army National Guard, DoD health
//   - Special Access Program (SAP) — classified DoD contracting
// Word-boundary match can't distinguish these. A post-filter reject
// list bolted on after the vendor match handles it.
//
// Keyed by the raw user input (lowercased) or the legal alias. When a
// vendor query resolves through lookupVendor, we check for an excludes
// entry and stash the list in postFilters.vendor_excludes. The
// post-filter then drops any row whose description or recipient
// contains any excluded phrase, regardless of vendor-scope match.
//
// Keep exclude phrases SHORT and SPECIFIC. "ABUSE" alone would be too
// broad; "SUBSTANCE ABUSE" is targeted. Phrases are matched via
// word-boundary regex just like needles, so "SAP" in excludes (don't
// do this) would nuke the whole query.
const VENDOR_EXCLUDES = {
  'sap': [
    'SUBSTANCE ABUSE',
    'SPECIAL ACCESS PROGRAM',
    'SPECIAL ACCESS PROGRAMS',
    'SUICIDE PREVENTION',        // often bundled with SAP (Substance Abuse Program, Suicide Prevention)
    'CHAUVENET HALL',            // Navy academy building; "SAP 2025 for Chauvenet" is facility, not vendor
  ],
};
function lookupVendorExcludes(raw) {
  const n = norm(raw);
  return VENDOR_EXCLUDES[n] || null;
}


// ─────────────────────────────────────────────────────────────────────
// TERRITORIES — seller shorthand for agency groupings (FedHealth, FedFin…)
// ─────────────────────────────────────────────────────────────────────
//
// Federal sellers routinely carve the market into "territories" — groups
// of agencies that share a buyer persona. A FedHealth rep sells to HHS
// and VA (and all their subtiers: CMS, CDC, FDA, NIH, VHA, etc). A
// FedFin rep sells to Treasury, FDIC, SEC, SBA, etc. A FedCiv rep
// covers the remaining civilian departments.
//
// This table captures the canonical groupings used in the fedhoo UI's
// territory-filter dropdown. When a user says "I sell cloud to
// FedHealth" or "cloud at FedCiv", Mo emits territory="fedhealth"
// (or "fedciv" / "fedfin" / "feddod"), and the resolver expands that
// into an agencies-array sent directly to USASpending's API filter —
// not a post-filter. This means the top-100 rows USASpending returns
// are ALREADY scoped to the territory before any client-side filtering.
//
// Terminology aliases are handled in lookupTerritory(): 'fedhealth',
// 'fed health', 'federal health', 'health sector' all resolve to the
// same canonical key. Short forms without the 'fed' prefix also work
// ('civilian' → fedciv, 'defense' → feddod).
//
// FedHealth requires special handling: USASpending sometimes files HHS
// subtier contracts under the subtier directly (Centers for Medicare
// and Medicaid Services, Food and Drug Administration, etc.) rather
// than rolling them up to 'Department of Health and Human Services' at
// the toptier level. Same for VA. So we explicitly list the major
// subtiers alongside the toptier to catch both filing styles.
const TERRITORIES = {
  feddod: {
    label: 'FedDoD',
    agencies: [
      { type: 'awarding', tier: 'toptier', name: 'Department of Defense' },
      { type: 'awarding', tier: 'toptier', name: 'Corps of Engineers - Civil Works' },
      { type: 'awarding', tier: 'toptier', name: 'Defense Nuclear Facilities Safety Board' },
      { type: 'awarding', tier: 'toptier', name: 'Armed Forces Retirement Home' },
      { type: 'awarding', tier: 'toptier', name: 'American Battle Monuments Commission' },
    ],
  },
  fedciv: {
    label: 'FedCiv',
    agencies: [
      'Department of Homeland Security',
      'General Services Administration',
      'Social Security Administration',
      'Department of Agriculture',
      'Office of Personnel Management',
      'Department of Education',
      'Department of Transportation',
      'Department of Energy',
      'Department of Housing and Urban Development',
      'Department of Labor',
      'Department of Justice',
      'Department of the Interior',
      'Department of State',
      'Department of Commerce',
      'National Aeronautics and Space Administration',
      'Environmental Protection Agency',
      'Federal Communications Commission',
      'Agency for International Development',
      'National Science Foundation',
      'Nuclear Regulatory Commission',
      'Railroad Retirement Board',
      'National Archives and Records Administration',
      'Peace Corps',
      'Equal Employment Opportunity Commission',
      'Executive Office of the President',
    ].map(name => ({ type: 'awarding', tier: 'toptier', name })),
  },
  fedhealth: {
    label: 'FedHealth',
    agencies: [
      // Toptier entries
      { type: 'awarding', tier: 'toptier', name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'toptier', name: 'Department of Veterans Affairs' },
      { type: 'awarding', tier: 'toptier', name: 'United States Court of Appeals for Veterans Claims' },
      { type: 'awarding', tier: 'toptier', name: 'Patient-Centered Outcomes Research Trust Fund' },
      // HHS subtiers that file independently
      { type: 'awarding', tier: 'subtier', name: 'Centers for Medicare and Medicaid Services',               toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'Centers for Disease Control and Prevention',               toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'Food and Drug Administration',                             toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'National Institutes of Health',                            toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'Health Resources and Services Administration',             toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'Substance Abuse and Mental Health Services Administration',toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'Agency for Healthcare Research and Quality',               toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'Indian Health Service',                                    toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'Administration for Community Living',                      toptier_name: 'Department of Health and Human Services' },
      { type: 'awarding', tier: 'subtier', name: 'Administration for Children and Families',                 toptier_name: 'Department of Health and Human Services' },
      // VA subtiers that file independently
      { type: 'awarding', tier: 'subtier', name: 'Veterans Health Administration',                           toptier_name: 'Department of Veterans Affairs' },
      { type: 'awarding', tier: 'subtier', name: 'Veterans Benefits Administration',                         toptier_name: 'Department of Veterans Affairs' },
      { type: 'awarding', tier: 'subtier', name: 'National Cemetery Administration',                         toptier_name: 'Department of Veterans Affairs' },
    ],
  },
  fedfin: {
    label: 'FedFin',
    agencies: [
      'Department of the Treasury',
      'Pension Benefit Guaranty Corporation',
      'Federal Deposit Insurance Corporation',
      'Consumer Financial Protection Bureau',
      'Small Business Administration',
      'Government Accountability Office',
      'Commodity Futures Trading Commission',
      'Export-Import Bank of the United States',
      'Farm Credit System Insurance Corporation',
      'U.S. International Development Finance Corporation',
      'International Trade Commission',
      'Federal Trade Commission',
      'National Credit Union Administration',
    ].map(name => ({ type: 'awarding', tier: 'toptier', name })),
  },
};

// Alias table: seller shorthand → canonical territory key
const TERRITORY_ALIASES = {
  // FedHealth
  'fedhealth':        'fedhealth',
  'fed health':       'fedhealth',
  'federal health':   'fedhealth',
  'fed healthcare':   'fedhealth',
  'federal healthcare':'fedhealth',
  'health sector':    'fedhealth',
  'healthcare sector':'fedhealth',
  'fedhlth':          'fedhealth',
  // FedFin
  'fedfin':           'fedfin',
  'fed fin':          'fedfin',
  'federal financial':'fedfin',
  'federal financials':'fedfin',
  'fed financial':    'fedfin',
  'fed financials':   'fedfin',
  'financial sector': 'fedfin',
  'fed banking':      'fedfin',
  // FedCiv
  'fedciv':           'fedciv',
  'fed civ':          'fedciv',
  'fed civilian':     'fedciv',
  'federal civilian': 'fedciv',
  'civilian':         'fedciv',
  'civilian agencies':'fedciv',
  // FedDoD
  'feddod':           'feddod',
  'fed dod':          'feddod',
  'dod sector':       'feddod',
  'defense sector':   'feddod',
  'federal defense':  'feddod',
  'pentagon sector':  'feddod',
};

function lookupTerritory(raw) {
  const n = norm(raw);
  const key = TERRITORY_ALIASES[n];
  return key ? { key, ...TERRITORIES[key] } : null;
}


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

// ─────────────────────────────────────────────────────────────────────
// LAZY LOAD (Apr 2026): entities.json is no longer fetched on module
// init. It's ~170KB raw / ~12KB gzipped, and most first-turn queries
// hit the hand-curated AGENCIES table and never need it. We now defer
// until either:
//   (a) a caller explicitly warms it via warmEntities() — oldmo.html
//       kicks this off on idle and on chip tap, so the file is loading
//       in parallel with the Lambda call
//   (b) a lookup misses AGENCIES and lookupEntitiesAgency() triggers
//       a background load — the miss itself is served from empty
//       (same behavior as pre-load), but the NEXT miss will hit the
//       warmed table
//
// `resolverReady` is preserved as a resolved promise for backwards
// compat with anything that was awaiting it. Code that needs the
// entities table loaded before a specific operation should await
// warmEntities() instead.
// ─────────────────────────────────────────────────────────────────────

let _entities = {};       // { searchKey: [entityObj, ...] }
let _entitiesLoaded = false;
let _entitiesLoading = null;   // promise guard, prevents double-fetch

export function warmEntities() {
  if (_entitiesLoaded) return Promise.resolve();
  if (_entitiesLoading) return _entitiesLoading;
  _entitiesLoading = (async () => {
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
      } else {
        console.warn('[resolver] entities.json has unexpected shape. Falling back to hand-curated tables only.');
        _entitiesLoaded = true;
      }
    } catch (err) {
      console.warn('[resolver] entities.json load error:', err.message, '— falling back to hand-curated tables only.');
      _entitiesLoaded = true;
    }
  })();
  return _entitiesLoading;
}

// Backwards-compat. Old code awaited this before first resolve() call.
// resolve() now works against AGENCIES immediately; misses trigger a
// background entities fetch but don't block.
export const resolverReady = Promise.resolve();

// Look up an agency term in entities.json. Returns the first match as a
// USASpending-shaped filter object, or null if no match.
//
// entities.json keys are pre-normalized (lowercase, no dots, collapsed
// whitespace) by the build script using the same norm rules as below.
function lookupEntitiesAgency(term) {
  // Not loaded yet? Kick off a background warm so future lookups hit,
  // and return null for THIS lookup — same behavior as a table miss.
  // Callers fall through to keyword search either way.
  if (!_entitiesLoaded) {
    warmEntities();
    return null;
  }
  if (!_entities) return null;
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
  const userTopicNeedles = [];  // client-side relevance check: at least ONE
                                // of these must literally appear in the
                                // description or recipient name for a row
                                // to pass the post-filter. This is the
                                // safety net against USASpending's
                                // token-fuzzy match pulling in irrelevant
                                // contracts (see note at applyPostFilters).
  for (const t of rawTopics) {
    const lower = t.toLowerCase();
    if (TOPIC_EXPANSIONS[lower]) {
      const expansions = TOPIC_EXPANSIONS[lower];
      topics.push(...expansions);
      // For the post-filter, use the EXPANSIONS as needles too — a topic
      // like "AI" expands to ['artificial intelligence', 'machine learning',
      // 'generative AI'] and a row is relevant if ANY of those appears.
      userTopicNeedles.push(...expansions);
    } else if (t.length >= 3) {
      topics.push(t);
      // Also push individual WORDS from the topic string. A topic like
      // "CSP engineering services" gets split into ['CSP', 'engineering',
      // 'services']. We require at least one (with min length 3) to
      // appear in description OR recipient. Without this split, the
      // post-filter only matches the full phrase, which is too strict.
      const parts = String(t)
        .split(/\s+/)
        .map(p => p.replace(/[^\w-]/g, '').trim())
        .filter(p => p.length >= 3);
      userTopicNeedles.push(...parts);
      // Also keep the full phrase as a needle in case it appears verbatim
      userTopicNeedles.push(t);
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
    // Build two sets: (1) keywordSet sent to USASpending's keyword filter,
    // and (2) vendorScopeSet for the browser-side post-filter that does
    // literal .includes() match against recipient name + description.
    //
    // Why split: USASpending's `keywords` filter is NOT a literal substring
    // match. Probe data from April 2026 showed keywords=['AWS'] returning
    // F-35 and nuclear-lab contracts whose descriptions contain NO literal
    // 'aws' substring. USASpending appears to token-stem or fuzzy-match,
    // which makes 3-char vendor acronyms (AWS, CGI, SAP, IBM) collide with
    // common contract-description words like 'award' and 'awarded'. The
    // collision dragged in ~84 junk rows that dominated the top-100 by
    // award amount, leaving the post-filter with 1 real match.
    //
    // Fix: when a resolved legal name exists AND the raw short form is
    // ≤3 chars, drop the short form from the USASpending keyword set.
    // Longer forms (legal + derived) still get sent, so GDIT (4-char raw
    // that doesn't collide) still gets both keywords. The post-filter
    // still carries the 3-char form so a literal 'AWS CLOUD' in a
    // description does still match client-side.
    //
    // Every keyword MUST be ≥3 characters or USASpending rejects with 422.
    // F5, C3, and other short competitor names drop out naturally.
    const keywordSet = new Set();   // sent to USASpending
    const vendorScopeSet = new Set(); // used by client-side post-filter

    // Legal names: always add to both (they're long enough to be unambiguous)
    for (const n of legalNames) {
      if (String(n || '').trim().length >= 3) {
        keywordSet.add(n);
        vendorScopeSet.add(n);
      }
    }

    // Raw inputs: always add to post-filter (literal match). Add to
    // USASpending keywords ONLY if longer than 3 chars OR if no legal
    // form was resolved (no alias found). The 3-char guard is what
    // prevents 'AWS' from dragging in award/awarded fuzzy matches.
    //
    // Short raw inputs (1-2 chars like "HP", "GE", "3M") still go into
    // vendor_scope because client-side post-filter is a literal match
    // that's safe at any length — just not to USASpending's fuzzy
    // keyword filter. Without this, a bare "HP" with no alias leaves
    // vendor_scope empty, which lets the entire $1.3T federal contract
    // universe sail past the post-filter.
    for (let i = 0; i < vendorInputs.length; i++) {
      const raw = String(vendorInputs[i] || '').trim();
      if (!raw) continue;
      const upper = raw.toUpperCase();
      // Always carry in vendor_scope for literal client-side match
      vendorScopeSet.add(upper);
      // Only send to USASpending keywords if ≥3 chars (API requirement)
      // AND either longer than 3 chars or no longer legal form exists
      // (collision guard: 3-char acronyms fuzzy-match common contract
      // words like 'award', so if we have a safer long-form, use it).
      if (raw.length < 3) continue;
      const legal = legalNames[i];
      const hasLongerLegal = legal && String(legal).length > raw.length;
      if (raw.length > 3 || !hasLongerLegal) {
        keywordSet.add(upper);
      }
    }

    // Derived short forms: always add to post-filter. Add to USASpending
    // keywords only if >3 chars — same collision guard as for raw input.
    // deriveShortForm('CGI FEDERAL') returns 'CGI' which would collide
    // with contract-description fuzzy match just like 'AWS' does.
    for (const legal of legalNames) {
      const derived = deriveShortForm(legal);
      if (derived) {
        vendorScopeSet.add(derived);
        if (derived.length > 3) keywordSet.add(derived);
      }
    }

    topics.push(...keywordSet);
    postFilters.vendor_scope = [...vendorScopeSet];

    // Also stash the legal names separately so the subaward direction
    // filter in stream-client can match against them without re-running
    // the lookup. vendor_scope contains BOTH raw and legal forms mixed;
    // this field is just the legal-form subset.
    postFilters.vendor_legal_names = legalNames
      .filter(n => String(n || '').trim().length >= 3)
      .map(n => String(n).toUpperCase());

    // Per-vendor excludes: collision-prone vendor names (SAP, etc.) can
    // carry a list of phrases that should REJECT a row even if the
    // vendor-scope word-boundary match passed. "SAP" matches both the
    // vendor and "Substance Abuse Program (SAP)"; the excludes list lets
    // us drop the substance-abuse rows without losing real SAP ERP work.
    const allExcludes = new Set();
    for (const raw of vendorInputs) {
      const excludes = lookupVendorExcludes(raw);
      if (excludes) excludes.forEach(e => allExcludes.add(e));
    }
    if (allExcludes.size > 0) postFilters.vendor_excludes = [...allExcludes];
  }

  // ── Territory resolution ───────────────────────────────────────
  // Federal sellers use shorthand like "FedHealth", "FedFin", "FedCiv"
  // to describe agency groupings that share a buyer persona. If the
  // caller provides input.territory, or if input.agency is actually a
  // territory alias, expand it into the agencies-array and send it
  // directly to USASpending's filter (pre-filter, not post-filter —
  // this means the top-100 rows USASpending returns are already scoped
  // to the territory before any client-side narrowing).
  //
  // Both territory + agency? That's the "Navy in FedHealth" case —
  // apply the intersection logic from fedhoo: if the agency is within
  // the territory, narrow to just that agency; if outside, keep
  // territory as the filter and add the agency name as a keyword.
  let territory = null;
  if (input.territory) {
    territory = lookupTerritory(input.territory);
  }
  // Also detect when the user typed a territory alias in the agency field
  // ('FedHealth cloud' → Mo may emit agency="FedHealth")
  if (!territory && input.agency) {
    const maybeTerritory = lookupTerritory(input.agency);
    if (maybeTerritory) {
      territory = maybeTerritory;
      // Clear input.agency so the regular agency path below doesn't also fire
      input = { ...input, agency: null };
    }
  }
  if (territory) {
    filters.agencies = territory.agencies;
    postFilters.territory_scope = territory.key;
    // The agency_scope post-filter expects a single agency; for territory
    // mode we carry the full list as territory_scope and skip the
    // single-agency post-filter. USASpending's pre-filter already scoped
    // the rows correctly so no additional post-filter narrowing needed.
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
      if (territory) {
        // Both territory AND a specific agency were provided.
        // Intersection logic from fedhoo._applySectorFilter.
        const territoryNames = new Set(
          territory.agencies.map(a => (a.name || '').toLowerCase())
        );
        const agencyNameLc = (agency.name || '').toLowerCase();
        if (territoryNames.has(agencyNameLc)) {
          // Agency is within the territory — narrow to just this agency
          filters.agencies = [{ ...agency, type: 'awarding' }];
          postFilters.agency_scope = agency;
          // Clear the territory scope since we've narrowed past it
          delete postFilters.territory_scope;
        } else {
          // Agency is outside the territory (e.g. "Navy within FedHealth").
          // Keep the territory as the agency filter, and add the agency
          // name as a keyword so USASpending returns territory rows that
          // mention this agency in their description or recipient.
          // Do NOT set agency_scope post-filter — that would reject every
          // row whose Awarding Agency isn't Navy (i.e. all of them, since
          // all returned rows are HHS/VA). The keyword+territory combo is
          // already the right scoping.
          if (agency.name) topics.push(agency.name);
          // territory_scope stays — card will show intersection label
        }
      } else {
        filters.agencies = [{ ...agency, type: 'awarding' }];
        postFilters.agency_scope = agency;
      }
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

  // ── Topic relevance post-filter ─────────────────────────────────
  // The user-typed topic words (split + expanded) become a requirement:
  // at least one needle must literally appear in the description or
  // recipient name for the row to survive applyPostFilters. This is a
  // safety net against USASpending's fuzzy keyword matcher returning
  // contracts that match on common-word tokens instead of the topic.
  // Example: user says "CSP engineering services at Army" — without
  // this filter, USASpending returns $14B of Army industrial operations
  // that have "engineering" or "services" somewhere but nothing to do
  // with CSP. With this filter, only rows with CSP / engineering /
  // services in their actual text pass through.
  if (userTopicNeedles.length > 0) {
    const dedupedUpper = [...new Set(userTopicNeedles.map(n => String(n).toUpperCase().trim()))].filter(Boolean);
    if (dedupedUpper.length > 0) postFilters.topic_scope = dedupedUpper;
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

  // ── Word-boundary needle match helper ────────────────────────────
  //
  // Used by vendor_scope and topic_scope filters. The old implementation
  // did a plain substring .includes() check, which produced nasty false
  // positives when a short needle happened to be a substring of unrelated
  // words. Real example captured April 2026: competitor list for Sonatype
  // included 'Mend' (a real SCA vendor). Post-filter matched MENDONCA
  // (ship name), MENDOCINO (Lake Mendocino at Army), MENDELSOHN,
  // MENDOZA — pulling $135M of maritime dredging contracts into a
  // DevSecOps query.
  //
  // Word-boundary match (\b on both sides) fixes it cleanly:
  //   - MEND matches 'MEND INC', 'MEND LLC', 'SUBSCRIPTION TO MEND' ✓
  //   - MEND does NOT match 'MENDONCA', 'MENDOCINO', 'AMENDMENT' ✓
  //
  // Multi-word needles still work: 'AMAZON WEB SERVICES' has \b at
  // start (boundary with space before AMAZON) and end (boundary after
  // final S), and the spaces between words are themselves boundaries.
  //
  // Needles are regex-escaped to handle punctuation safely (commas,
  // ampersands, periods in 'CACI, INC.' etc.). Compiled once per
  // needle and cached on a map so re-running against many rows isn't
  // 1000 regex compilations.
  const _needleCache = new Map();
  function needleMatches(text, needle) {
    if (!text || !needle) return false;
    let re = _needleCache.get(needle);
    if (!re) {
      // Escape regex metachars. \b is a word boundary — position between
      // \w (word char: alphanumeric + underscore) and a non-word char.
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp('\\b' + escaped + '\\b', 'i');
      _needleCache.set(needle, re);
    }
    return re.test(text);
  }

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
    // Uses word-boundary matching (see needleMatches) so short needles
    // like 'MEND' or 'OKTA' don't false-positive on MENDONCA, OKTAUGHT,
    // etc. Substring match caused $135M of maritime contracts to surface
    // on a Sonatype+competitors query because one competitor name was 'Mend'.
    //
    // The keyword already sent to USASpending ensures the API returns only
    // rows that mention the vendor somewhere; this filter is the browser's
    // final "is this actually about X" check.
    const needles = postFilters.vendor_scope;
    out = out.filter(r => {
      const recipient = r['Recipient Name'] || '';
      const description = r['Description'] || '';
      return needles.some(n => needleMatches(recipient, n) || needleMatches(description, n));
    });
  }

  // Per-vendor collision excludes. Runs AFTER vendor_scope accepts a row,
  // rejecting rows where the description or recipient contains a known
  // collision phrase. Example: 'SAP' vendor_scope accepts both real SAP
  // ERP rows AND 'Army Substance Abuse Program (SAP)' rows. The excludes
  // list for 'sap' contains 'SUBSTANCE ABUSE', which drops the collision
  // rows without affecting legitimate SAP rows. See VENDOR_EXCLUDES at
  // the top of this file for the curated collision lists.
  if (postFilters.vendor_excludes && postFilters.vendor_excludes.length > 0) {
    const excludes = postFilters.vendor_excludes;
    out = out.filter(r => {
      const recipient = r['Recipient Name'] || '';
      const description = r['Description'] || '';
      return !excludes.some(e => needleMatches(recipient, e) || needleMatches(description, e));
    });
  }

  // Topic relevance post-filter. Applies ONLY when no vendor_scope is set;
  // if the user asked about a specific vendor, the vendor scope already
  // acts as relevance. For vendor-less queries (topic+agency, like "cloud
  // at DoD" or "CSP engineering services at Army"), require at least one
  // user-typed topic needle to actually appear in description or recipient
  // name. Without this, USASpending's token-fuzzy keyword matcher returns
  // contracts whose text doesn't literally contain the topic words — the
  // CSP case where Army industrial ops ($14B KBR) surfaced on a CSP query
  // because "engineering" and "services" fuzzy-matched.
  //
  // Same word-boundary matcher as vendor_scope: avoids false positives
  // from short topic words embedded in unrelated contract text.
  if (!postFilters.vendor_scope && postFilters.topic_scope && postFilters.topic_scope.length > 0) {
    const topicNeedles = postFilters.topic_scope;
    out = out.filter(r => {
      const recipient = r['Recipient Name'] || '';
      const description = r['Description'] || '';
      return topicNeedles.some(n => needleMatches(recipient, n) || needleMatches(description, n));
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
