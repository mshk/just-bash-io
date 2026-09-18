import { createHash } from "node:crypto";

export const formats = ["markdown", "csv", "html"] as const;
export type Format = (typeof formats)[number];
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Reproducible, non-sensitive data with unique values and formatting to preserve. */
export function fixture(format: Format, rows: number) {
  const records = Array.from({ length: rows }, (_, i) => {
    const id = String(i + 1).padStart(5, "0");
    const ref = hash(`benchmark-record-${id}`).slice(0, 16);
    const status = i % 3 === 0 ? "COMPLETE" : "PENDING_REVIEW";
    if (format === "markdown") return `| ${id} | [Item ${ref}](https://example.invalid/${id}) | ${status} | **Keep** 日本語 & punctuation: \`x_${id}\` |`;
    if (format === "csv") return `${id},${ref},${status},"Keep 日本語, commas and ""quotes""",${i * 17 + 101}`;
    return `  <li data-id="${id}" data-status="${status}"><a href="/${ref}">Item ${id}</a><span>Keep 日本語 &amp; &lt;tags&gt;</span></li>`;
  });
  const input = format === "markdown"
    ? `# Review inventory\n\n| ID | Item | Status | Notes |\n| --- | --- | --- | --- |\n${records.join("\n")}\n`
    : format === "csv"
      ? `id,reference,status,notes,amount\n${records.join("\n")}\n`
      : `<!doctype html>\n<html lang="ja">\n<body>\n<ul>\n${records.join("\n")}\n</ul>\n</body>\n</html>\n`;
  return { input, expected: input.replaceAll("PENDING_REVIEW", "APPROVED") };
}
