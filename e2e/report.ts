import { formats, type Format } from "./fixtures.js";

export type Mode = "inline" | "just-bash-io";
export type Measurement = {
  format: Format; mode: Mode; repetition: number; inputBytes: number; outputBytes: number;
  inputHash: string; expectedHash: string; outputHash: string;
  inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number;
  reasoningTokens: number; usageComplete: boolean; steps: number; toolCalls: number;
  elapsedMs: number; deliveryMs: number | null; exact: boolean; deliveries: number;
  finishReason?: string; error?: string;
};

export interface ReportMetadata {
  generatedAt: string; model: string; rows: number; repeats: number;
  timeout: number; maxOutputTokens: number; node: string;
  instruction: string; results: Measurement[];
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
export function renderReport(metadata: ReportMetadata, language: "en" | "ja"): string {
  const { model: modelId, rows, repeats, timeout, maxOutputTokens, results } = metadata;
  const t = (ja: string, en: string) => language === "ja" ? ja : en;
  const lines = [
    language === "en" ? "[日本語](./REPORT.ja.md)" : "[English](./REPORT.md)", "",
    t("# just-bash-io E2E パフォーマンス検証", "# just-bash-io E2E performance benchmark"), "",
    t(`実行日時: ${metadata.generatedAt} / Node: ${metadata.node}`, `Generated at: ${metadata.generatedAt} / Node: ${metadata.node}`),
    t(`モデル: ${modelId} / temperature: 0 / 各形式 ${rows} レコード × ${repeats} 回 / 最大出力 ${maxOutputTokens} tokens / timeout ${timeout} ms`, `Model: ${modelId} / temperature: 0 / ${rows} records per format × ${repeats} repetitions / max output ${maxOutputTokens} tokens / timeout ${timeout} ms`), "",
    t("## 方法", "## Method"), "",
    t("合成 Markdown・CSV・HTML 内の PENDING_REVIEW を APPROVED に一括置換する。変更対象以外の全バイトを保持する。期待値はホスト側で独立に生成し、モデルには渡さない。", "Replace every PENDING_REVIEW with APPROVED in synthetic Markdown, CSV and HTML, preserving every other byte. Expected outputs are generated independently on the host and are not provided to the model."),
    t("inline は loadData の全文をコンテキストに入れ、編集後の全文を deliverOutput の引数として生成する。just-bash-io は実際の offloadToolOutputs と createBashTools を使用し、モデルが選んだコマンドで編集したファイルを sink へ配信する。両方式で同じ入力・指示・モデルを使用する。", "inline puts the complete loadData result into context and generates the entire edited document as deliverOutput arguments. just-bash-io uses the actual offloadToolOutputs and createBashTools APIs, edits the file using model-selected commands and delivers it through the sink. Both modes use identical inputs, instructions and model settings."),
    t("各回は独立した会話と仮想FS。直列実行し、形式・反復ごとに方式の順序を交互にする。API自動リトライなし、最大8ステップ。初回の loadData は両方式で強制し、配信ツール呼び出し後に停止する。", "Each run uses a fresh conversation and virtual filesystem. Runs are sequential, alternating mode order by format and repetition. Automatic API retries are disabled; conversations have at most eight steps. Both modes must call loadData first and stop after calling the delivery tool."),
    t("総トークンは全APIステップの usage の合算（ツール定義・結果・会話の再入力も含む）。cached は入力の内数で差し引かない。時間はツール環境作成開始から最後のAPIステップ終了まで、配信時間は sink/配信関数に全文が到着するまで。fixture生成・検証・ディスク保存は計測外。", "Total tokens sum usage across all API steps, including tool definitions, results and conversation history sent again. Cached tokens are a subset of input tokens and are not subtracted. Total time runs from tool environment initialization to completion of the last API step; delivery time ends when the sink/delivery function receives the full document. Fixture generation, validation and disk writes are excluded."), "",
    t("## 実測", "## Measurements"), "",
    t("| 形式 | 回 | 方式 | 入力 bytes | 出力 bytes | 入力 tokens | cached | 出力 tokens | 総 tokens | 配信 秒 | 全体 秒 | API steps | tool calls | 完全一致 | usage完全 | エラー |", "| Format | Run | Mode | Input bytes | Output bytes | Input tokens | Cached | Output tokens | Total tokens | Delivery seconds | Total seconds | API steps | Tool calls | Exact match | Complete usage | Error |"),
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...results.map(m => `| ${m.format} | ${m.repetition} | ${m.mode} | ${m.inputBytes} | ${m.outputBytes} | ${m.inputTokens} | ${m.cachedInputTokens} | ${m.outputTokens} | ${m.totalTokens} | ${m.deliveryMs == null ? "—" : (m.deliveryMs / 1000).toFixed(2)} | ${(m.elapsedMs / 1000).toFixed(2)} | ${m.steps} | ${m.toolCalls} | ${m.exact ? "PASS" : "FAIL"} | ${m.usageComplete ? "yes" : "no"} | ${m.error ?? "—"} |`), "",
    t("## 同一アウトプットの比較", "## Comparison with identical outputs"), "",
    t("両方式が期待値と完全一致し usage が取得できたペアのみ集計。削減率はペアごとの (1 − just-bash-io / inline) の中央値。失敗ペアを成功として扱わない。", "Only pairs where both modes exactly match the expected output and have complete usage are included. Reductions are the median of the per-pair ratios (1 − just-bash-io / inline). Failed pairs are not treated as successes."), "",
    t("| 形式 | 成功ペア / 予定 | 総トークン削減率 中央値 | 全体時間短縮率 中央値 |", "| Format | Successful / planned pairs | Median total token reduction | Median total time reduction |"),
    "| --- | ---: | ---: | ---: |",
  ];
  for (const format of formats) {
    const pairs = results.filter(m => m.format === format && m.mode === "inline").flatMap(a => {
      const b = results.find(m => m.format === format && m.mode === "just-bash-io" && m.repetition === a.repetition);
      return b && a.exact && b.exact && a.usageComplete && b.usageComplete && a.totalTokens > 0 ? [{ a, b }] : [];
    });
    const tokens = pairs.length ? (100 * median(pairs.map(({ a, b }) => 1 - b.totalTokens / a.totalTokens))).toFixed(1) + "%" : t("比較不可", "Not comparable");
    const time = pairs.length ? (100 * median(pairs.map(({ a, b }) => 1 - b.elapsedMs / a.elapsedMs))).toFixed(1) + "%" : t("比較不可", "Not comparable");
    lines.push(`| ${format} | ${pairs.length} / ${repeats} | ${tokens} | ${time} |`);
  }
  lines.push("", t("## 検証範囲と制約", "## Scope and limitations"), "",
    t(`完了測定: ${results.length} / ${formats.length * repeats * 2}。完全一致: ${results.filter(m => m.exact).length}。`, `Completed measurements: ${results.length} / ${formats.length * repeats * 2}. Exact matches: ${results.filter(m => m.exact).length}.`),
    t("これは全文をモデルが読み書きする通常方式と、ファイルへの退避・コマンド編集・直接配信を組み合わせた方式の比較。just-bash 単体、差分編集ツール、他のファイル編集エージェントに対する優位性は検証していない。", "This compares full-document model transcription with the combined offload, command editing and direct delivery workflow. It does not establish superiority of just-bash alone or compare against patch tools or other file-editing agents."),
    t("一括文字列置換の合成データに限定した測定であり、意味理解を伴う複雑な編集性能は示さない。少数回の実行・ネットワーク・API負荷・プロンプトキャッシュ・プロセス内の初期化キャッシュによる変動がある。キャッシュは無効化していない。金額への換算は行わない。", "The workload is limited to bulk literal replacement in synthetic data; it does not measure complex semantic editing. Results vary with the small sample size, network conditions, API load, prompt caching and in-process initialization caches. Caching is not disabled. No monetary cost conversion is made."),
    t("タイムアウト等の失敗では完了ステップ分しか usage が取得できず、実際の課金トークンを過小計上する可能性がある。その行の usage完全は no とし比較から除外する。", "For failures such as timeouts, usage may cover only completed steps and undercount actual billable tokens. Such rows are marked no under Complete usage and excluded from comparisons."),
    t("同じディレクトリの results.json に全測定・SHA-256を、*.input.txt / *.expected.txt / *.actual.txt に比較対象を保存。キーや .env の内容は保存しない。", "The same directory contains all measurements and SHA-256 hashes in results.json, plus comparison artifacts in *.input.txt, *.expected.txt and *.actual.txt. API keys and .env contents are not saved."), "");
  return lines.join("\n");
}
