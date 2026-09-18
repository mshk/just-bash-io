import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderReport, type ReportMetadata } from "../e2e/report.js";

it("preserves recorded measurements and failed-pair exclusions in both languages", () => {
  const directory = new URL("../benchmark-results/2026-09-18T15-23-25.189Z/", import.meta.url);
  const metadata: ReportMetadata = JSON.parse(readFileSync(new URL("results.json", directory), "utf8"));
  const english = renderReport(metadata, "en");
  const japanese = renderReport(metadata, "ja");
  for (const report of [english, japanese]) {
    expect(report).toContain("| csv | 3 / 3 | 87.1% | 96.4% |");
    expect(report).toContain("| html | 3 / 3 | 92.6% | 98.0% |");
    expect(report.split("\n").filter(line => /\| (PASS|FAIL) \|/.test(line))).toHaveLength(18);
  }
  expect(english).toContain("| markdown | 0 / 3 | Not comparable | Not comparable |");
  expect(japanese).toContain("| markdown | 0 / 3 | 比較不可 | 比較不可 |");
  expect(english).toBe(readFileSync(new URL("REPORT.md", directory), "utf8"));
  expect(japanese).toBe(readFileSync(new URL("REPORT.ja.md", directory), "utf8"));
});
