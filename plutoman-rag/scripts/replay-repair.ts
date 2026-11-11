/**
 * Offline check of the answer repair: re-apply repairFromTables to the answers
 * of a finished evaluation run (the repair is a pure function of question,
 * answer and tables) and write the result next to it.
 *   npx tsx scripts/replay-repair.ts <run.json> <out.json>
 */
import { readFileSync, writeFileSync } from "fs";
import { repairFromTables, CheckTable } from "../src/data/answerChecks";
import { pool } from "../src/db";
import { cacheClient } from "../src/cache";

const [, , src, out] = process.argv;
const run = JSON.parse(readFileSync(src, "utf-8")) as { id: string; question: string; answer: string | null; tables?: (CheckTable & { sql?: string })[] }[];
let changed = 0;
for (const r of run) {
  if (!r.answer || !r.tables) continue;
  const tables = r.tables.filter((t) => !t.title.startsWith("The report's own conclusion"));
  const fixed = repairFromTables(r.question, r.answer, tables);
  if (fixed !== r.answer) {
    changed++;
    console.log(`${r.id} repaired`);
    r.answer = fixed;
  }
}
writeFileSync(out, JSON.stringify(run, null, 1));
console.log(`changed ${changed} of ${run.length}`);
void pool.end().catch(() => undefined);
cacheClient.disconnect();
