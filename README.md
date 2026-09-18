# just-bash-io

**Keep bulk data out of the LLM's context.** `just-bash-io` gives an AI SDK agent a sandboxed
[`just-bash`](https://www.npmjs.com/package/just-bash) workspace with a door on each side:

- **In** — tool results (MCP responses, API payloads, query dumps) are written straight into the
  virtual filesystem. The model receives a path, a line count and a short preview.
- **Out** — a file the agent formatted with `awk` / `jq` / `python3` is delivered straight to the
  user. The model never re-types it.

The model decides *how* to transform the data. It never has to carry the data itself.

[日本語版 README](./README.ja.md)

## Why

The usual agent loop makes every byte round-trip through the model:

```
MCP tool → 40k tokens of JSON → model → model retypes a table → user
```

That is expensive, it truncates on large results, and the model silently drops rows while
transcribing. With `just-bash-io`:

```
MCP tool → /workspace/data/listCows_1.json   (model sees: path, 1,204 lines, 10-line preview)
model    → "awk -F, '{ s += $3 } END { ... }' … > report.md"
sink     → report.md → user
```

The model's context holds a few hundred tokens of metadata instead of the whole dataset, and the
bytes the user sees are the bytes `awk` produced.

## Install

```bash
npm install just-bash-io
```

`ai` (v6) and `zod` (v4) are peer dependencies.

## Usage

```ts
import { generateText } from "ai";
import { createBashTools, offloadToolOutputs } from "just-bash-io";

// 1. A sandboxed workspace whose output goes directly to the user.
const { tools: bashTools, bash } = await createBashTools({
  sink: {
    sink: async ({ content }) => {
      await chat.sendMessage({ text: content });
    },
  },
});

// 2. Large results from your existing tools land in that same workspace.
const dataTools = offloadToolOutputs(mcpClient.tools, { bash });

await generateText({
  model,
  tools: { ...dataTools, ...bashTools },
  prompt: "Summarise this month's milk yield per barn as a Markdown table.",
});
```

A plausible run:

| step | what happens | tokens the model sees |
| --- | --- | --- |
| 1 | `listCows` returns 1.2 MB of JSON → `/workspace/data/listCows_1.json` | ~120 |
| 2 | `bash`: `jq -r '...' … \| awk … > report.md` | ~80 |
| 3 | `sendFileToUser({ path: "report.md" })` → your `sink` | ~30 |

## API

### `createBashTools(options?)`

Returns `{ tools, bash }`. `tools` always contains `bash`, `readFile` and `writeFile` (from
[`bash-tool`](https://www.npmjs.com/package/bash-tool)), plus the sink tool when `sink` is given.
All of them share one `Bash` instance — and therefore one virtual filesystem.

| option | default | meaning |
| --- | --- | --- |
| `sink.sink` | — | `({ path, content, characterCount }) => void`. Required to expose the sink tool. |
| `sink.toolName` | `"sendFileToUser"` | Name the model calls. |
| `sink.description` | built-in English text | Override to rephrase, or to write it in another language. |
| `sink.maxOutputLength` | `4000` | Longer files are **rejected, not truncated** — silent truncation drops rows. |
| `sink.onBeforeSend` | — | Fires just before delivery; handy for a "sending…" indicator. |
| `workingDirectory` | `"/workspace"` | Shell cwd; relative paths resolve against it. |
| `python` | `true` | Enables `python3` (CPython on WebAssembly). |
| `javascript` | `true` | Enables `js-exec` (QuickJS). |
| `bashOptions` | — | Extra `just-bash` options, merged last. |
| `extraInstructions` | — | Appended to the generated tool description. |
| `onBeforeCommand` / `onAfterCommand` | — | Command lifecycle hooks for logging. |

The sink tool returns `{ sent: true, path, characterCount }` — deliberately **not** the content,
which would put it back into the context the tool exists to protect.

### `offloadToolOutputs(tools, options)`

Wraps an existing `ToolSet` (MCP tools, your own tools, anything with an `execute`).

| option | default | meaning |
| --- | --- | --- |
| `bash` | — | The instance from `createBashTools`. Required. |
| `directory` | `` `${cwd}/data` `` | Where offloaded files go. |
| `minCharacters` | `800` | Shorter results stay inline; reading them directly is cheaper. |
| `preview` | 10 lines / 800 chars | Excerpt returned to the model, or `false` for none. |
| `include` / `exclude` | all / none | Restrict which tools are wrapped. |
| `fileName` | `<tool>_<n>.<ext>` | Custom naming. |
| `serialize` | see below | Return `{ text, extension }` to override the conversion. |
| `onOffload` | — | Called after a file is written. |

Default serialization: strings as-is (`.txt`); MCP `content[].text` joined (`.json` when it parses
as JSON, otherwise `.txt`); anything else `JSON.stringify(result, null, 2)` (`.json`).

**Error results are never offloaded.** Anything with `isError: true` is returned untouched, because
the model has to see the failure to recover from it.

The model receives:

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

## Prompting notes

Two lines in your system prompt do most of the work:

- Tell the model that offloaded files are real and complete, so it should process them with `bash`
  rather than asking for the data again.
- Tell it that content sent through the sink is already visible to the user, so it must not repeat
  it in the final answer.

## Security

- **Nothing touches the real machine.** `just-bash` is a TypeScript shell over a virtual filesystem.
- **Network access is off** unless you pass `bashOptions.network`. Enabling it gives the sandbox an
  outbound path for whatever the model put in the filesystem — treat it as a deliberate decision.
- `python3` and `js-exec` run inside WebAssembly (CPython Emscripten / QuickJS) and cannot reach host
  processes or files. They are enabled by default because accurate arithmetic matters more than the
  narrow surface they add; pass `python: false` / `javascript: false` to drop them.
- Each `createBashTools()` call gets its own filesystem, so one user's data cannot leak into another
  session — provided you create the tools per request.

## Bundling

`just-bash` loads command chunks relative to `import.meta.url`. If you bundle for a serverless
runtime, mark `just-bash` as **external** and ship `node_modules` alongside the bundle; inlining it
breaks `python3` and `js-exec` at runtime while tests still pass.

## Development

```bash
npm install
npm test
npm run build
```

## License

[MIT](./LICENSE) © mshk
