/** Parsing for DEMO_ACCESS_CODES — kept dependency-free so it is unit-testable. */

/** "tenantA=code1;tenantB=code2" -> [{tenant, code}] (malformed entries ignored). */
export function parseAccessCodes(raw: string): { tenant: string; code: string }[] {
  return raw
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return i > 0 ? { tenant: pair.slice(0, i).trim(), code: pair.slice(i + 1).trim() } : null;
    })
    .filter((x): x is { tenant: string; code: string } => !!x && !!x.tenant && x.code.length >= 6);
}
