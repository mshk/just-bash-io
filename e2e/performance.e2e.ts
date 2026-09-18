import { createOpenAI } from "@ai-sdk/openai";
import { generateText, hasToolCall, stepCountIs, tool, type ToolSet } from "ai";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { createBashTools, offloadToolOutputs } from "../src/index.js";
import { fixture, formats, hash, type Format } from "./fixtures.js";
import { renderReport, type Measurement, type Mode } from "./report.js";

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

async function saveReport() {
  const metadata = { generatedAt: new Date().toISOString(), model: modelId, rows, repeats, timeout, maxOutputTokens, node: process.version, instruction, results };
  await writeFile(resolve(outputDir, "results.json"), JSON.stringify(metadata, null, 2) + "\n");
  await writeFile(resolve(outputDir, "REPORT.md"), renderReport(metadata, "en"));
  await writeFile(resolve(outputDir, "REPORT.ja.md"), renderReport(metadata, "ja"));
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
