# Live editing benchmark

Run from the repository root with Node.js 22.6+ (uses `process.loadEnvFile`).

```sh
npm ci
cp .env.example .env
# Edit .env and set OPENAI_API_KEY before running:
npm run test:e2e
```

Set `OPENAI_API_KEY` in the root `.env` or the environment. Existing environment
variables take precedence. This explicitly opted-in suite makes paid OpenAI API
calls; `npm test` runs only offline tests. Never commit `.env`.
If `.env` already exists, keep it and set the key there instead of copying the template.

The [recorded benchmark report](../benchmark-results/README.md) includes the
original metrics, inputs, expected outputs and actual outputs. The harness and
fixtures are reproducible; live model outputs, token usage and latency may vary
between runs, even with temperature set to zero.

Defaults: pinned `gpt-4.1-mini-2025-04-14`, 300 records per format, 3 repetitions,
18 independent conversations total, up to 8 API steps per conversation. Each pair
uses identical synthetic data, instructions and model settings. The inline agent
returns the entire edited document as tool arguments; the just-bash-io agent uses
the real offload wrapper, sandbox tools and sink. This measures the combined
offload/edit/delivery workflow, not shell speed alone or other patching tools.

```sh
BENCH_ROWS=1000 BENCH_REPEATS=5 BENCH_TIMEOUT_MS=300000 npm run test:e2e
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_MODEL` | `gpt-4.1-mini-2025-04-14` | OpenAI Chat Completions model supporting tools and temperature=0 |
| `BENCH_ROWS` | `300` | Records per format |
| `BENCH_REPEATS` | `3` | Repetitions per format and mode |
| `BENCH_TIMEOUT_MS` | `180000` | Per-conversation deadline in milliseconds |
| `BENCH_MAX_OUTPUT_TOKENS` | `32768` | Per-step output limit (must fit selected model) |
| `BENCH_OUTPUT_DIR` | `benchmark-results/<timestamp>` | Report and artifact directory; use a new directory per run |

The generated Japanese `REPORT.md` includes every measurement and paired median
reductions only for byte-identical, successfully measured outputs. `results.json`
contains raw metrics and hashes; input, expected and actual text files allow
independent inspection. A mismatch, timeout, API error or incomplete usage fails
the suite, while completed measurements are checkpointed after each case. API
errors retain only the error class to avoid saving headers or secrets. Partial
token counts from failed requests are excluded from comparisons.

The workload replaces the literal `PENDING_REVIEW` with `APPROVED`, preserving
unrelated content including unique references, Japanese text, CSV quoting, HTML
entities and Markdown formatting. It measures a bulk literal edit, not semantic
reasoning. Ordering alternates, but prompt caching and network/server variability
remain; cached tokens are reported and not subtracted from total usage. No cost
estimate or statistical significance is claimed.
