/**
 * "And in the other Polycab report?" came back with the report already being
 * discussed, even though excludedByContrast() names it correctly: chatTurn
 * asked the data engine first and returned its answer, so the exclusion was
 * computed further down the function and never reached anything.
 *
 * The bug was purely one of ORDER, which no unit test of the pure helpers can
 * catch. These read chatTurn's source and pin the order and the guard, so the
 * data engine cannot quietly be moved back in front of the contrast check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "..", "src", "retrieval", "retrievalService.ts"), "utf8");
// chatTurn only — /search calls the same helpers with no history to contrast against.
const AT = SRC.indexOf("async function chatTurn(");
const CHAT_TURN = SRC.slice(AT);

test("the test can find chatTurn at all", () => {
  assert.ok(AT > 0, "chatTurn was renamed or moved; these guards need updating");
});

test("the contrast is worked out before the data engine is consulted", () => {
  const contrast = CHAT_TURN.indexOf("excludedByContrast(");
  const engine = CHAT_TURN.indexOf("tryDataEngine(");
  assert.ok(contrast > 0, "chatTurn should compute the contrastive exclusion");
  assert.ok(engine > 0, "chatTurn should still consult the data engine");
  assert.ok(
    contrast < engine,
    "excludedByContrast must come BEFORE tryDataEngine, or a contrastive turn is " +
      "answered from the tables about the report the user asked to move off"
  );
});

test("the data engine is skipped on a contrastive turn", () => {
  const at = CHAT_TURN.indexOf("tryDataEngine(");
  const guarded = CHAT_TURN.slice(Math.max(0, at - 200), at);
  assert.match(
    guarded,
    /excluding[\s\S]{0,30}\?[\s\S]{0,30}null/,
    "the tryDataEngine call should be gated on `excluding ? null : ...`"
  );
});

test("the compute path is skipped on a contrastive turn too", () => {
  const at = CHAT_TURN.indexOf("tryCompute(");
  assert.ok(at > 0, "chatTurn should still have the compute path");
  const guarded = CHAT_TURN.slice(Math.max(0, at - 260), at);
  assert.match(
    guarded,
    /excluding/,
    "the tryCompute call should sit out contrastive turns for the same reason"
  );
});
