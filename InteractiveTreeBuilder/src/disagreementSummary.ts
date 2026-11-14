/** Sample proportions, using exact model counts so boundary values and tiny
 * minorities are not rounded away by floating-point prediction probabilities. */
export function summarizeDisagreement(rows: { counts: string[] }[]) {
  let any = 0, above10 = 0, above25 = 0;
  for (const row of rows) {
    const counts = row.counts.map(count => BigInt(count));
    const total = counts.reduce((sum, count) => sum + count, 0n);
    const majority = counts.reduce((max, count) => count > max ? count : max, 0n);
    const minority = total - majority;
    if (minority > 0n) ++any;
    if (minority * 10n > total) ++above10;
    if (minority * 4n > total) ++above25;
  }
  const samples = rows.length || 1;
  return { any: any / samples, above10: above10 / samples, above25: above25 / samples };
}
