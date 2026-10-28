import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Writes a JSON report, creating its directory if needed.
 *
 * @param reportPath - Where to write the report.
 * @param report - The report fields.
 */
export function writeReport(
  reportPath: string,
  report: Record<string, string>,
): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
