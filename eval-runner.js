// ============================================================================
// eval-runner.js — browser-side eval harness for Mo
// ============================================================================
//
// Plays a scripted scenario through the real askMo() pipeline, collects
// structured data at every stage (tag attributes, resolver filters, row
// counts, rendered card state, Mo's prose), and runs assertions against
// it. Returns a report object the UI can render.
//
// Design:
//   - No DOM. Pure data in/out. evals.html wires the UI.
//   - Uses the SAME stream-client code path as mo_mock.html. Deliberately.
//     We want to catch regressions in what real users hit, not a mock.
//   - Runs one turn at a time. Each user message gets played, askMo runs
//     to completion, and we snapshot everything the render callbacks saw.
//     Then assertions run against that snapshot.
//   - Soft vs hard assertions: HARD failures are product bugs; SOFT
//     failures flag Gemini non-determinism without tanking the eval run.
// ============================================================================

import { askMo } from './stream-client.js';

// Run a single scenario end-to-end. Returns { passed, failed, skipped, turns }.
//
// A scenario looks like:
//   {
//     name: 'I sell AWS to DoD',
//     description: 'Known vendor pitch at a major agency',
//     turns: [
//       {
//         question: 'I sell AWS to DoD',
//         assertions: [
//           { kind: 'hard', check: (s) => s.tagAttrs?.vendor === 'AWS', msg: 'Mo emits vendor=AWS' },
//           { kind: 'soft', check: (s) => /AWS/i.test(s.preTagText), msg: 'Opener mentions AWS' },
//           ...
//         ]
//       },
//       { question: 'what about VA', assertions: [...] },
//     ]
//   }
//
// Each assertion `check` receives a snapshot of what happened on that turn:
//   {
//     preTagText,       // Mo's text before the <data> tag
//     postTagText,      // Mo's grounded post-tag prose
//     tagAttrs,         // parsed <data> attributes (if any)
//     resolverInput,    // the object passed to resolve()
//     rows,             // USASpending rows returned after post-filter
//     rowCount,         // rows.length
//     mode,             // 'prose' | 'data' | 'subaward' | 'error' | 'no_data'
//     cardSpec,         // the card spec built by buildCardSpec (if rendered)
//     error,            // error message if render.renderError fired
//   }
export async function runScenario(scenario, endpoint, { onTurn = null } = {}) {
  const history = [];
  const turnResults = [];

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];
    const snapshot = {
      preTagText: '',
      postTagText: '',
      tagAttrs: null,
      resolverInput: null,
      rows: null,
      rowCount: 0,
      mode: null,
      cardSpec: null,
      error: null,
    };

    // Build render callbacks that capture into the snapshot instead of the DOM.
    // Matches the shape askMo expects but with no side effects beyond capture.
    const render = {
      streamPreTagProse: (text) => { snapshot.preTagText = text; },
      onDataTag: (resolverInput) => {
        snapshot.resolverInput = { ...resolverInput };
        // Return a capture-style "cardRef" that renderDataCard can attach to.
        return { _capture: true };
      },
      renderDataCard: (_cardRef, rows, resolverInput) => {
        snapshot.rows = rows;
        snapshot.rowCount = rows ? rows.length : 0;
        // Don't build a cardSpec here — that requires the buildCardSpec
        // function which lives in mo_mock.html. We capture the raw rows
        // and let assertions reason over them directly.
      },
      renderSubawardCard: (_cardRef, subs, resolverInput) => {
        snapshot.rows = subs;
        snapshot.rowCount = subs ? subs.length : 0;
        snapshot.isSubawardCard = true;
      },
      streamPostTagProse: (text) => { snapshot.postTagText = text; },
      renderError: (msg) => { snapshot.error = msg; },
      complete: () => { /* nothing */ },
    };

    const t0 = Date.now();
    let result;
    try {
      result = await askMo({
        question: turn.question,
        history: [...history],
        activeCardSummary: null, // matches production behavior
        endpoint,
        render,
      });
    } catch (err) {
      snapshot.mode = 'error';
      snapshot.error = err.message || String(err);
    }
    const durationMs = Date.now() - t0;

    if (result) {
      snapshot.mode = result.mode;

      // Prefer the final resolver input from the debug trace — this
      // reflects what ACTUALLY went to USASpending after competitor
      // expansion (file-first lookup adds _sellerName, _competitorList,
      // replaces vendor with vendors array) and any subaward mutations.
      // The onDataTag snapshot captures the input from the parsed tag,
      // BEFORE those mutations run, which made assertions checking for
      // _sellerName etc. fail even when the product was working.
      //
      // Keep resolverInputInitial available for assertions that want to
      // see the tag-derived state specifically.
      if (result.debug?.resolverInputFinal) {
        snapshot.resolverInputInitial = snapshot.resolverInput;
        snapshot.resolverInput = result.debug.resolverInputFinal;
      }

      // tagAttrs isn't directly on result; we can derive it from what
      // onDataTag captured into resolverInput. Store a cleaned view for
      // assertion ergonomics — strip internal underscore fields.
      // NOTE: derive from the INITIAL input (tag-derived), not the final
      // (post-expansion) — tagAttrs should reflect what Mo emitted in her
      // tag, not what the browser did with it after.
      const tagSource = snapshot.resolverInputInitial || snapshot.resolverInput;
      if (tagSource) {
        snapshot.tagAttrs = {};
        for (const [k, v] of Object.entries(tagSource)) {
          if (!k.startsWith('_')) snapshot.tagAttrs[k] = v;
        }
      }
    }

    // Update history the way real askMo callers do, so multi-turn scenarios
    // feel real. Skip on errors — matches mo_mock.html behavior.
    if (snapshot.mode !== 'error' && snapshot.mode !== 'no_data') {
      history.push({ role: 'user', content: turn.question });
      const combined = [snapshot.preTagText, snapshot.postTagText]
        .filter(Boolean).join('\n\n');
      if (combined) history.push({ role: 'model', content: combined });
      // Mirror mo_mock's 4-turn cap
      while (history.length > 4) history.shift();
    }

    // Run assertions against this turn
    const assertionResults = [];
    for (const a of (turn.assertions || [])) {
      let pass = false, errMsg = null;
      try {
        pass = !!a.check(snapshot);
      } catch (err) {
        pass = false;
        errMsg = err.message || String(err);
      }
      assertionResults.push({
        kind: a.kind || 'hard',
        msg: a.msg || '(unnamed)',
        pass,
        errMsg,
      });
    }

    const turnResult = {
      question: turn.question,
      snapshot,
      assertions: assertionResults,
      durationMs,
    };
    turnResults.push(turnResult);
    if (onTurn) onTurn(turnResult, i);
  }

  // Tally
  let hardPassed = 0, hardFailed = 0, softPassed = 0, softFailed = 0;
  for (const t of turnResults) {
    for (const a of t.assertions) {
      if (a.kind === 'soft') {
        a.pass ? softPassed++ : softFailed++;
      } else {
        a.pass ? hardPassed++ : hardFailed++;
      }
    }
  }

  const status = hardFailed > 0 ? 'fail' : (softFailed > 0 ? 'warn' : 'pass');

  return {
    name: scenario.name,
    description: scenario.description || '',
    turns: turnResults,
    hardPassed, hardFailed, softPassed, softFailed,
    status,
  };
}

// Run an array of scenarios, sequentially. Each scenario is a fresh history.
// onScenario fires after each scenario completes, onTurn fires after each turn.
export async function runAllScenarios(scenarios, endpoint, { onScenario = null, onTurn = null } = {}) {
  const results = [];
  for (const scenario of scenarios) {
    const r = await runScenario(scenario, endpoint, { onTurn });
    results.push(r);
    if (onScenario) onScenario(r);
  }
  return results;
}
