/**
 * Verdict normalisation regression suite (pure — no DB / Redis / Ollama).
 *
 * Every case below is a real answer string from the demo inspection reports.
 * Several are the exact values the golden evaluation set depends on:
 *   - Q13 / Q21: "below acceptance; retest pending" is neither a pass nor a
 *     stated fail -> CONDITIONAL (never OK — the old regex said OK).
 *   - Q15: Oxygen Index "27% – below min 30%; oxygen index fail" -> NOT OK.
 *   - Q03: "OI 31.5% – Pass" -> OK (the old regex returned null for Pass).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVerdict } from "../src/ingestion/chunk";

const cases: Array<[string, string | null]> = [
  // --- explicit failures -> NOT OK ------------------------------------------
  ["Not Ok", "NOT OK"],
  ["Canopy -3mm|Not OK", "NOT OK"],
  ["Rejected", "NOT OK"],
  ["OI 27% – below min 30%; oxygen index fail", "NOT OK"],
  ["0.118 Ω/km @ 20°C – above max; conductor resistance fail", "NOT OK"],
  ["Sheath elongation after ageing below min – fail", "NOT OK"],
  ["Flame propagated beyond mark – flammability fail", "NOT OK"],
  ["Halogen acid above limit – fail", "NOT OK"],
  ["Lot not meeting QAP acceptance criteria.", "NOT OK"],
  [
    "Acceptance tests / visual checks not meeting specification. Material is rejected for the offered lot.",
    "NOT OK",
  ],
  ["Water blocking missing in mid strand layer – deviation / NCR", "NOT OK"],

  // --- neither pass nor stated fail -> CONDITIONAL ---------------------------
  ["IR phase–earth 80 MΩ – below acceptance; retest pending", "CONDITIONAL"],
  ["Subject to rectification of minor defects", "CONDITIONAL"],

  // --- passes -> OK -----------------------------------------------------------
  ["Ok", "OK"],
  ["Yes", "OK"],
  ["OI 31.5% – Pass", "OK"],
  ["Passed", "OK"],
  ["Canopy -3mm Others 2mm- OK", "OK"],
  ["Present and continuous along conductor – OK", "OK"],
  ["500 mtr ±0.5% – OK", "OK"],
  ["250 mtr – verified", "OK"],
  ["Lot cleared for dispatch.", "OK"],
  ["Diameter check with digital Vernier – conforms to approved construction", "OK"],

  // --- not a verdict at all -> null -------------------------------------------
  ["45.0 mm", null],
  ["Sector shaped", null],
  ["Non-compacted circular", null],
  ["Attached", null],
  ["Not Attached", null],
  ["Black", null],
  ["", null],
];

for (const [input, expected] of cases) {
  test(`verdict: ${JSON.stringify(input).slice(0, 70)} -> ${expected}`, () => {
    assert.equal(normalizeVerdict(input), expected);
  });
}

test("verdict: 'acceptance' is not a pass word (old /\\baccept/ bug)", () => {
  assert.notEqual(normalizeVerdict("80 MΩ – below acceptance"), "OK");
});
