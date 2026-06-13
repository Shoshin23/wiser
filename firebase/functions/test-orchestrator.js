"use strict";
// LOCAL VERIFICATION for the streaming orchestrator's distiller (NO http server,
// NO deploy). Drives a REAL coding run through orchestrator.makeDistiller() with a
// small prompt that produces edits + a test run + a decision, prints every
// {hud}/{card}/{done} frame the SSE layer would emit, then simulates a steer when
// an ask_user question appears and confirms the run resumes to a done card.
//
//   cd firebase/functions && set -a && . ./.env && set +a && node test-orchestrator.js
//
// PASS criteria: at least one diff OR tests card with real numbers, AND a done
// card, appear; and the simulated steer answers an ask_user and the run reaches
// a done card afterwards.

const orch = require("./orchestrator");

const PROMPT =
  "In the working directory: (1) create calc.py with functions add, sub, and mul (each taking " +
  "two numbers). For the multiply function, the name is ambiguous between 'mul' and 'multiply' — " +
  "call ask_user with that question (options: mul, multiply) and wait for the answer before " +
  "writing it. (2) create test_calc.py with pytest-style asserts covering add, sub, and the " +
  "multiply function. (3) run the tests with `python3 -m pytest test_calc.py -q` (or " +
  "`python3 test_calc.py` if pytest is unavailable). Call report_diff after writing the files and " +
  "report_tests after running them. (4) finish by calling done with a short headline, summary, and " +
  "stats.";

let diffCard = null;
let testsCard = null;
let questionCard = null;
let doneCard = null;
let askToolSeen = false;

function logFrame(f, phase) {
  if (f.ack) {
    console.log(`  [ack -> session] tool=${f.ack.toolUseId}${f.ack.isError ? " (error)" : ""}`);
    return;
  }
  if (!f.frame) return;
  const fr = f.frame;
  if (fr.hud) {
    const h = fr.hud;
    const act = h.activity ? `${h.activity.verb}:${h.activity.target}` : "-";
    console.log(
      `  {hud} status=${h.status} iter=${h.iter} tok=${h.tokens} $${h.costUsd.toFixed(2)} ` +
        `exit=${h.exit.label} ${h.exit.have}/${h.exit.need} act=${act}`
    );
  } else if (fr.card) {
    const c = fr.card;
    console.log(`  {card:${c.kind}} ${JSON.stringify(c)}`);
    if (c.kind === "diff") diffCard = c;
    if (c.kind === "tests") testsCard = c;
    if (c.kind === "question") questionCard = c;
    if (c.kind === "done") doneCard = c;
  } else if (fr.done) {
    console.log(`  {done:true} hud.status=${fr.done && fr.hud ? fr.hud.status : "?"} ${JSON.stringify(fr.hud)}`);
  }
}

async function consume(stream, distiller, { stopOnAsk = false } = {}) {
  for await (const ev of stream) {
    const frames = distiller.feed(ev);
    for (const f of frames) {
      logFrame(f);
      // Replicate the SSE layer: acks go back to the session (the distiller does
      // NOT ack ask_user — that's the steer's job).
      if (f.ack) {
        await orch.ackCustomTool(SESSION_ID, f.ack).catch((e) => console.warn("ack failed:", e.message));
      }
    }
    if (stopOnAsk && distiller.hasPendingQuestion()) {
      console.log("\n*** pending ask_user detected — pausing stream to steer ***\n");
      askToolSeen = true;
      return "ask";
    }
    if (distiller.doneEmitted) return "done";
  }
  return "end";
}

let SESSION_ID = null;

async function main() {
  const hardTimeout = setTimeout(() => {
    console.error("\nTIMEOUT after 300s.");
    process.exit(3);
  }, 300000);

  console.log("creating run (real coding agent, coding env)...");
  const { id } = await orch.createRun({ prompt: PROMPT });
  SESSION_ID = id;
  console.log("RUN/SESSION_ID =", id, "\n");

  const distiller = orch.makeDistiller();

  // --- phase 1: stream until the ask_user pauses us ---
  console.log("=== PHASE 1: stream until ask_user ===");
  let stream = await orch.openEventStream(id);
  let outcome = await consume(stream, distiller, { stopOnAsk: true });

  // --- phase 2: steer the ask_user (simulate a voice answer) ---
  if (outcome === "ask" && questionCard) {
    const answer =
      (questionCard.options && questionCard.options[0]) || "mul";
    console.log(`=== PHASE 2: steer with voiceText="${answer}" (answering ask_user) ===`);
    const steerResult = await orch.steer(id, { voiceText: answer });
    console.log("  steer result:", JSON.stringify(steerResult), "\n");

    // --- phase 3: re-open the stream and continue to done ---
    console.log("=== PHASE 3: resume stream to done ===");
    stream = await orch.openEventStream(id);
    outcome = await consume(stream, distiller, { stopOnAsk: false });
  } else {
    console.log("(no ask_user pause — agent finished without a decision point)");
  }

  clearTimeout(hardTimeout);

  console.log("\n=== VERDICT ===");
  const haveDiffOrTests =
    (diffCard && typeof diffCard.summary === "string") ||
    (testsCard && typeof testsCard.passed === "number");
  console.log("diff card           :", diffCard ? JSON.stringify(diffCard) : "(none)");
  console.log("tests card          :", testsCard ? JSON.stringify(testsCard) : "(none)");
  console.log("ask_user steered    :", askToolSeen);
  console.log("done card           :", doneCard ? JSON.stringify(doneCard) : "(none)");
  const pass = haveDiffOrTests && !!doneCard;
  if (pass && askToolSeen) {
    console.log("\nPASS: real diff/tests card + working steer + done card.");
  } else if (pass) {
    console.log("\nPARTIAL: diff/tests + done present, but no ask_user steer exercised.");
  } else {
    console.log("\nFAIL: missing a diff/tests card or a done card — inspect frames above.");
  }
  console.log("\noutcome:", outcome);
}

main().catch((e) => {
  console.error("\nERROR:", e?.status || "", e?.message || e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
