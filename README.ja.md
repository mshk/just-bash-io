# just-bash-io

**大量データを LLM のコンテキストに通さないための道具です。** `just-bash-io` は AI SDK のエージェントに
[`just-bash`](https://www.npmjs.com/package/just-bash) のサンドボックス作業環境を与え、その両端に扉をつけます。

- **入口** — tool の実行結果（MCP レスポンス、API のペイロード、クエリ結果）を仮想ファイルシステムへ直接書き込みます。
  モデルが受け取るのはパスと行数と短いプレビューだけです。
- **出口** — `awk` / `jq` / `python3` で整形したファイルを、そのままユーザーへ届けます。モデルが書き写す必要はありません。

モデルは「どう変換するか」だけを判断します。データ本体を運ぶ必要がありません。

[English README](./README.md)

## ベンチマーク

`gpt-4.1-mini-2025-04-14`、各形式300レコード、各方式3回で測定しました。
CSV・HTML は両方式で出力が完全一致しました。トークン数・時間は実測の中央値、削減率はペアごとの比率の中央値です。
矢印は **just-bash-io なし → あり** を示します。

| 形式 | 総トークン数 | 全体時間 | トークン削減率 | 時間短縮率 |
| --- | ---: | ---: | ---: | ---: |
| CSV | 18,712 → 2,406 | 71.89秒 → 2.68秒 | 87.1% | 96.4% |
| HTML | 33,573 → 2,500 | 138.81秒 → 2.59秒 | 92.6% | 98.0% |

Markdown は通常方式の3回すべてで転記ミスが発生し、just-bash-io は3回すべて完全一致しました。
そのため Markdown の同一出力での性能比較は掲載していません。合成データの文字列置換に限定した測定です。

大きな Markdown・CSV・HTML の編集を通常方式と比較する E2E テストは
[実行ガイド](./e2e/README.md)を参照してください。`.env` の `OPENAI_API_KEY` を設定し
`npm run test:e2e` を実行すると、出力の完全一致・使用トークン数・所要時間を Markdown にまとめます。
実測結果は[日本語](./benchmark-results/README.ja.md)・[英語](./benchmark-results/README.md)で公開しています。

## なぜ必要か

よくあるエージェントのループでは、すべてのバイトがモデルを往復します。

```
MCP tool → 4万トークンの JSON → モデル → モデルが表を書き写す → ユーザー
```

これはトークンを浪費し、結果が大きいと破綻し、書き写しの途中で行が静かに欠落します。`just-bash-io` を使うと:

```
MCP tool → /workspace/data/listCows_1.json  （モデルが見るのは: パス, 1,204 行, 10 行のプレビュー）
モデル   → 「awk -F, '{ s += $3 } END { ... }' … > report.md」と判断するだけ
sink     → report.md → ユーザー
```

モデルのコンテキストにはデータセット全体ではなく数百トークンのメタ情報だけが載り、ユーザーが目にするのは
`awk` が出力したバイトそのものになります。

## インストール

```bash
npm install just-bash-io
```

`ai` (v6) と `zod` (v4) は peer dependency です。

## 使い方

```ts
import { generateText } from "ai";
import { createBashTools, offloadToolOutputs } from "just-bash-io";

// 1. 出力がそのままユーザーへ届くサンドボックス作業環境を作る
const { tools: bashTools, bash } = await createBashTools({
  sink: {
    sink: async ({ content }) => {
      await chat.sendMessage({ text: content });
    },
  },
});

// 2. 既存 tool の大きな結果を、同じ作業環境へ着地させる
const dataTools = offloadToolOutputs(mcpClient.tools, { bash });

await generateText({
  model,
  tools: { ...dataTools, ...bashTools },
  prompt: "今月の牛舎ごとの搾乳量を Markdown の表にまとめて",
});
```

実行例:

| ステップ | 起きること | モデルが見るトークン |
| --- | --- | --- |
| 1 | `listCows` が 1.2MB の JSON を返す → `/workspace/data/listCows_1.json` | 約 120 |
| 2 | `bash`: `jq -r '...' … \| awk … > report.md` | 約 80 |
| 3 | `sendFileToUser({ path: "report.md" })` → あなたの `sink` | 約 30 |

## API

### `createBashTools(options?)`

`{ tools, bash }` を返します。`tools` には常に
[`bash-tool`](https://www.npmjs.com/package/bash-tool) 由来の `bash` / `readFile` / `writeFile` が含まれ、
`sink` を渡したときだけ出口 tool が追加されます。これらはすべて 1 つの `Bash` インスタンス、
つまり 1 つの仮想ファイルシステムを共有します。

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `sink.sink` | — | `({ path, content, characterCount }) => void`。出口 tool を公開するには必須。 |
| `sink.toolName` | `"sendFileToUser"` | モデルが呼ぶ tool 名。 |
| `sink.description` | 組み込みの英語説明 | 日本語の説明に差し替えたい場合に指定。 |
| `sink.maxOutputLength` | `4000` | 超過分は**切り詰めずエラーにします**。黙って切ると行が欠落するため。 |
| `sink.onBeforeSend` | — | 送信直前に呼ばれます。「送信中…」の表示などに。 |
| `workingDirectory` | `"/workspace"` | シェルの作業ディレクトリ。相対パスの基準になります。 |
| `python` | `true` | `python3`（WebAssembly 上の CPython）を有効化。 |
| `javascript` | `true` | `js-exec`（QuickJS）を有効化。 |
| `bashOptions` | — | `just-bash` への追加オプション。最後にマージされます。 |
| `extraInstructions` | — | 自動生成される tool 説明の末尾に追記されます。 |
| `onBeforeCommand` / `onAfterCommand` | — | コマンド実行前後のフック。ログ用。 |

出口 tool が返すのは `{ sent: true, path, characterCount }` だけで、**本文は返しません**。
本文を返すと、この tool が守ろうとしているコンテキストへデータが戻ってしまうためです。

### `offloadToolOutputs(tools, options)`

既存の `ToolSet`（MCP tool、自作 tool、`execute` を持つもの全般）をラップします。

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `bash` | — | `createBashTools` が返したインスタンス。必須。 |
| `directory` | `` `${cwd}/data` `` | 書き出し先ディレクトリ。 |
| `minCharacters` | `800` | これ未満の結果はそのまま返します。短い結果は直接読む方が安上がりなため。 |
| `preview` | 10 行 / 800 文字 | モデルへ返す抜粋。`false` で無効化。 |
| `include` / `exclude` | 全件 / なし | ラップ対象の絞り込み。 |
| `fileName` | `<tool>_<n>.<ext>` | ファイル名のカスタマイズ。 |
| `serialize` | 下記参照 | `{ text, extension }` を返して変換方法を差し替え。 |
| `onOffload` | — | ファイル書き出し後に呼ばれます。 |

既定の変換規則: 文字列はそのまま（`.txt`）、MCP の `content[].text` は連結（JSON として解釈できれば
`.json`、それ以外は `.txt`）、その他は `JSON.stringify(result, null, 2)`（`.json`）。

**エラー結果はオフロードしません。** `isError: true` を持つ結果はそのまま返します。
モデルが失敗内容を見なければ復旧できないためです。

モデルが受け取る値:

```ts
{
  offloaded: true,
  path: "/workspace/data/listCows_1.json",
  characterCount: 1_204_336,
  lineCount: 18_004,
  preview: "[\n  {\n    \"id\": 1,",
  previewTruncated: true,
  hint: "The full result was saved to … Use the bash tool to inspect and process it. …"
}
```

## プロンプトの書き方

システムプロンプトに次の 2 点を書くだけで、ほぼ意図どおりに動きます。

- オフロードされたファイルは実在し、内容は完全であること。データを取り直さず `bash` で処理すること。
- 出口 tool で送った内容はすでにユーザーに見えているので、最終回答に書き写さないこと。

## セキュリティ

- **実マシンには一切触れません。** `just-bash` は仮想ファイルシステム上で動く TypeScript 製のシェルです。
- **ネットワークは既定で無効です。** `bashOptions.network` を渡したときだけ有効になります。
  有効化すると、モデルが仮想FSへ置いたデータの外部送信経路ができるため、意識的な判断として扱ってください。
- `python3` と `js-exec` は WebAssembly（CPython Emscripten / QuickJS）内で動き、ホストのプロセスや
  ファイルには到達しません。集計の正確さの方が、増える攻撃面より価値が高いため既定で有効です。
  不要なら `python: false` / `javascript: false` を渡してください。
- `createBashTools()` の呼び出しごとに仮想FSは独立します。リクエストごとに生成すれば、
  別ユーザーのデータが混ざることはありません。

## バンドルの注意

`just-bash` は `import.meta.url` を基準にコマンドの chunk を動的ロードします。サーバーレス向けに
バンドルする場合は `just-bash` を **external** にして `node_modules` を同梱してください。
バンドルへ取り込むと、テストは通るのに実行時だけ `python3` と `js-exec` が壊れます。

## 開発

```bash
npm install
npm test
npm run build
```

## ライセンス

[MIT](./LICENSE) © mshk
