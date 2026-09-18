import { createOpenAI } from "@ai-sdk/openai";
import { generateText, hasToolCall, stepCountIs, tool, type ToolSet } from "ai";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { createBashTools, offloadToolOutputs } from "../src/index.js";
import { fixture, formats, hash, type Format } from "./fixtures.js";

if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required (.env or environment).");
function positiveInt(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
const rows = positiveInt("BENCH_ROWS", 300);
const repeats = positiveInt("BENCH_REPEATS", 3);
const timeout = positiveInt("BENCH_TIMEOUT_MS", 180_000);
const maxOutputTokens = positiveInt("BENCH_MAX_OUTPUT_TOKENS", 32_768);
const modelId = process.env.BENCH_MODEL ?? "gpt-4.1-mini-2025-04-14";
const outputDir = resolve(process.env.BENCH_OUTPUT_DIR ?? `benchmark-results/${new Date().toISOString().replaceAll(":", "-")}`);
// Explicit OpenAI endpoint: never forward the .env key to a configurable third party.
const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: "https://api.openai.com/v1" }).chat(modelId);
type Mode = "inline" | "just-bash-io";
type Measurement = {
  format: Format; mode: Mode; repetition: number; inputBytes: number; outputBytes: number;
  inputHash: string; expectedHash: string; outputHash: string;
  inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number;
  reasoningTokens: number; usageComplete: boolean; steps: number; toolCalls: number;
  elapsedMs: number; deliveryMs: number | null; exact: boolean; deliveries: number;
  finishReason?: string; error?: string;
};
const results: Measurement[] = [];
const instruction = "Load the source with loadData. Replace every exact literal PENDING_REVIEW with APPROVED. Preserve every other byte, including all rows, order, spaces, markup, quotes, Unicode and the final newline. Deliver the entire edited document exactly once with deliverOutput. Do not summarize, truncate, add code fences, or repeat the delivered content. If the source is offloaded, process the file in the sandbox and deliver its path.";

async function run(format: Format, mode: Mode, repetition: number) {
  const { input, expected } = fixture(format, rows);
  const stem = `${format}-${repetition}-${mode}`;
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, `${format}.input.txt`), input);
  await writeFile(resolve(outputDir, `${format}.expected.txt`), expected);
  const started = performance.now();
  let output = "";
  const m: Measurement = {
    format, mode, repetition, inputBytes: Buffer.byteLength(input), outputBytes: 0,
    inputHash: hash(input), expectedHash: hash(expected), outputHash: hash(""),
    inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0,
    reasoningTokens: 0, usageComplete: true, steps: 0, toolCalls: 0,
    elapsedMs: 0, deliveryMs: null, exact: false, deliveries: 0,
  };
  const deliver = (content: string) => {
    output = content;
    m.deliveries++;
    m.deliveryMs = performance.now() - started;
  };
  try {
    const source: ToolSet = {
      loadData: tool({ description: `Get the complete ${format} source document.`, inputSchema: z.object({}), execute: async () => input }),
    };
    let tools: ToolSet;
    if (mode === "just-bash-io") {
      const sandbox = await createBashTools({ sink: {
        toolName: "deliverOutput", maxOutputLength: expected.length * 2,
        sink: ({ content }) => deliver(content),
      } });
      tools = { ...offloadToolOutputs(source, { bash: sandbox.bash }), ...sandbox.tools };
    } else {
      tools = { ...source, deliverOutput: tool({
        description: "Deliver the complete edited document to the user.",
        inputSchema: z.object({ content: z.string() }),
        execute: async ({ content }) => { deliver(content); return { sent: true, characterCount: content.length }; },
      }) };
    }
    const result = await generateText({
      model, tools, prompt: instruction, temperature: 0, maxOutputTokens, maxRetries: 0,
      abortSignal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout - (performance.now() - started)))),
      stopWhen: [hasToolCall("deliverOutput"), stepCountIs(8)],
      prepareStep: ({ stepNumber }) => stepNumber === 0 ? { toolChoice: { type: "tool", toolName: "loadData" } } : {},
      onStepFinish: ({ usage, toolCalls }) => {
        m.steps++;
        m.toolCalls += toolCalls.length;
        if (usage.inputTokens == null || usage.outputTokens == null || usage.totalTokens == null) m.usageComplete = false;
        m.inputTokens += usage.inputTokens ?? 0;
        m.outputTokens += usage.outputTokens ?? 0;
        m.totalTokens += usage.totalTokens ?? 0;
        m.cachedInputTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
        m.reasoningTokens += usage.outputTokenDetails?.reasoningTokens ?? 0;
      },
    });
    m.finishReason = result.finishReason;
  } catch (error) {
    // Provider errors can embed request bodies or headers. Save only safe classification.
    m.error = error instanceof Error ? error.name : "UnknownError";
    m.usageComplete = false;
  } finally {
    m.elapsedMs = performance.now() - started;
    m.outputBytes = Buffer.byteLength(output);
    m.outputHash = hash(output);
    m.exact = output === expected && m.deliveries === 1 && !m.error;
    results.push(m);
    await writeFile(resolve(outputDir, `${stem}.actual.txt`), output);
    await saveReport();
  }
  expect(m.error, `${stem}: API/tool failure; see report`).toBeUndefined();
  expect(m.usageComplete, `${stem}: incomplete token accounting`).toBe(true);
  expect(m.exact, `${stem}: output must match every expected byte; see artifacts`).toBe(true);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
async function saveReport() {
  const metadata = { generatedAt: new Date().toISOString(), model: modelId, rows, repeats, timeout, maxOutputTokens, node: process.version, instruction, results };
  await writeFile(resolve(outputDir, "results.json"), JSON.stringify(metadata, null, 2) + "\n");
  const lines = [
    "# just-bash-io E2E パフォーマンス検証", "",
    `実行日時: ${metadata.generatedAt} / Node: ${process.version}`,
    `モデル: ${modelId} / temperature: 0 / 各形式 ${rows} レコード × ${repeats} 回 / 最大出力 ${maxOutputTokens} tokens / timeout ${timeout} ms`, "",
    "## 方法", "",
    "合成 Markdown・CSV・HTML 内の PENDING_REVIEW を APPROVED に一括置換する。変更対象以外の全バイトを保持する。期待値はホスト側で独立に生成し、モデルには渡さない。",
    "inline は loadData の全文をコンテキストに入れ、編集後の全文を deliverOutput の引数として生成する。just-bash-io は実際の offloadToolOutputs と createBashTools を使用し、モデルが選んだコマンドで編集したファイルを sink へ配信する。両方式で同じ入力・指示・モデルを使用する。",
    "各回は独立した会話と仮想FS。直列実行し、形式・反復ごとに方式の順序を交互にする。API自動リトライなし、最大8ステップ。初回の loadData は両方式で強制し、配信ツール呼び出し後に停止する。",
    "総トークンは全APIステップの usage の合算（ツール定義・結果・会話の再入力も含む）。cached は入力の内数で差し引かない。時間はツール環境作成開始から最後のAPIステップ終了まで、配信時間は sink/配信関数に全文が到着するまで。fixture生成・検証・ディスク保存は計測外。", "",
    "## 実測", "",
    "| 形式 | 回 | 方式 | 入力 bytes | 出力 bytes | 入力 tokens | cached | 出力 tokens | 総 tokens | 配信 秒 | 全体 秒 | API steps | tool calls | 完全一致 | usage完全 | エラー |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...results.map(m => `| ${m.format} | ${m.repetition} | ${m.mode} | ${m.inputBytes} | ${m.outputBytes} | ${m.inputTokens} | ${m.cachedInputTokens} | ${m.outputTokens} | ${m.totalTokens} | ${m.deliveryMs == null ? "—" : (m.deliveryMs / 1000).toFixed(2)} | ${(m.elapsedMs / 1000).toFixed(2)} | ${m.steps} | ${m.toolCalls} | ${m.exact ? "PASS" : "FAIL"} | ${m.usageComplete ? "yes" : "no"} | ${m.error ?? "—"} |`), "",
    "## 同一アウトプットの比較", "",
    "両方式が期待値と完全一致し usage が取得できたペアのみ集計。削減率はペアごとの (1 − just-bash-io / inline) の中央値。失敗ペアを成功として扱わない。", "",
    "| 形式 | 成功ペア / 予定 | 総トークン削減率 中央値 | 全体時間短縮率 中央値 |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const format of formats) {
    const pairs = results.filter(m => m.format === format && m.mode === "inline").flatMap(a => {
      const b = results.find(m => m.format === format && m.mode === "just-bash-io" && m.repetition === a.repetition);
      return b && a.exact && b.exact && a.usageComplete && b.usageComplete && a.totalTokens > 0 ? [{ a, b }] : [];
    });
    const tokens = pairs.length ? (100 * median(pairs.map(({ a, b }) => 1 - b.totalTokens / a.totalTokens))).toFixed(1) + "%" : "比較不可";
    const time = pairs.length ? (100 * median(pairs.map(({ a, b }) => 1 - b.elapsedMs / a.elapsedMs))).toFixed(1) + "%" : "比較不可";
    lines.push(`| ${format} | ${pairs.length} / ${repeats} | ${tokens} | ${time} |`);
  }
  lines.push("", "## 検証範囲と制約", "",
    `完了測定: ${results.length} / ${formats.length * repeats * 2}。完全一致: ${results.filter(m => m.exact).length}。`,
    "これは全文をモデルが読み書きする通常方式と、ファイルへの退避・コマンド編集・直接配信を組み合わせた方式の比較。just-bash 単体、差分編集ツール、他のファイル編集エージェントに対する優位性は検証していない。",
    "一括文字列置換の合成データに限定した測定であり、意味理解を伴う複雑な編集性能は示さない。少数回の実行・ネットワーク・API負荷・プロンプトキャッシュ・プロセス内の初期化キャッシュによる変動がある。キャッシュは無効化していない。金額への換算は行わない。",
    "タイムアウト等の失敗では完了ステップ分しか usage が取得できず、実際の課金トークンを過小計上する可能性がある。その行の usage完全は no とし比較から除外する。",
    "同じディレクトリの results.json に全測定・SHA-256を、*.input.txt / *.expected.txt / *.actual.txt に比較対象を保存。キーや .env の内容は保存しない。", "");
  await writeFile(resolve(outputDir, "REPORT.md"), lines.join("\n"));
}

for (let repetition = 1; repetition <= repeats; repetition++) {
  for (const [index, format] of formats.entries()) {
    const order: Mode[] = (repetition + index) % 2 ? ["inline", "just-bash-io"] : ["just-bash-io", "inline"];
    for (const mode of order) test(`${format} ${mode} repetition ${repetition}`, () => run(format, mode, repetition), timeout + 30_000);
  }
}
afterAll(async () => {
  await saveReport();
  console.log(`Benchmark report: ${resolve(outputDir, "REPORT.md")}`);
});
