[日本語](./REPORT.ja.md)

# just-bash-io E2E performance benchmark

Generated at: 2026-09-18T15:40:03.434Z / Node: v22.22.3
Model: gpt-4.1-mini-2025-04-14 / temperature: 0 / 300 records per format × 3 repetitions / max output 32768 tokens / timeout 180000 ms

## Method

Replace every PENDING_REVIEW with APPROVED in synthetic Markdown, CSV and HTML, preserving every other byte. Expected outputs are generated independently on the host and are not provided to the model.
inline puts the complete loadData result into context and generates the entire edited document as deliverOutput arguments. just-bash-io uses the actual offloadToolOutputs and createBashTools APIs, edits the file using model-selected commands and delivers it through the sink. Both modes use identical inputs, instructions and model settings.
Each run uses a fresh conversation and virtual filesystem. Runs are sequential, alternating mode order by format and repetition. Automatic API retries are disabled; conversations have at most eight steps. Both modes must call loadData first and stop after calling the delivery tool.
Total tokens sum usage across all API steps, including tool definitions, results and conversation history sent again. Cached tokens are a subset of input tokens and are not subtracted. Total time runs from tool environment initialization to completion of the last API step; delivery time ends when the sink/delivery function receives the full document. Fixture generation, validation and disk writes are excluded.

## Measurements

| Format | Run | Mode | Input bytes | Output bytes | Input tokens | Cached | Output tokens | Total tokens | Delivery seconds | Total seconds | API steps | Tool calls | Exact match | Complete usage | Error |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| markdown | 1 | inline | 38477 | 37459 | 14144 | 0 | 13739 | 27883 | 115.21 | 115.22 | 2 | 2 | FAIL | yes | — |
| markdown | 1 | just-bash-io | 38477 | 37277 | 16550 | 0 | 112 | 16662 | 5.84 | 5.84 | 3 | 4 | PASS | yes | — |
| csv | 1 | just-bash-io | 24280 | 23080 | 2333 | 0 | 73 | 2406 | 2.76 | 2.76 | 3 | 3 | PASS | yes | — |
| csv | 1 | inline | 24280 | 23080 | 9210 | 0 | 9502 | 18712 | 79.29 | 79.29 | 2 | 2 | PASS | yes | — |
| html | 1 | inline | 42967 | 41767 | 16737 | 0 | 16836 | 33573 | 138.81 | 138.81 | 2 | 2 | PASS | yes | — |
| html | 1 | just-bash-io | 42967 | 41767 | 2427 | 0 | 73 | 2500 | 2.40 | 2.40 | 3 | 3 | PASS | yes | — |
| markdown | 2 | just-bash-io | 38477 | 37277 | 2375 | 0 | 73 | 2448 | 3.13 | 3.13 | 3 | 3 | PASS | yes | — |
| markdown | 2 | inline | 38477 | 37554 | 14144 | 13824 | 13739 | 27883 | 109.52 | 109.52 | 2 | 2 | FAIL | yes | — |
| csv | 2 | inline | 24280 | 23080 | 9210 | 8960 | 9502 | 18712 | 71.89 | 71.89 | 2 | 2 | PASS | yes | — |
| csv | 2 | just-bash-io | 24280 | 23080 | 2333 | 0 | 73 | 2406 | 2.57 | 2.57 | 3 | 3 | PASS | yes | — |
| html | 2 | just-bash-io | 42967 | 41767 | 2427 | 0 | 73 | 2500 | 2.97 | 2.97 | 3 | 3 | PASS | yes | — |
| html | 2 | inline | 42967 | 41767 | 16737 | 16512 | 16836 | 33573 | 146.61 | 146.61 | 2 | 2 | PASS | yes | — |
| markdown | 3 | inline | 38477 | 37478 | 14144 | 13824 | 13739 | 27883 | 105.76 | 105.76 | 2 | 2 | FAIL | yes | — |
| markdown | 3 | just-bash-io | 38477 | 37277 | 3552 | 1024 | 162 | 3714 | 4.20 | 4.20 | 4 | 5 | PASS | yes | — |
| csv | 3 | just-bash-io | 24280 | 23080 | 2333 | 0 | 73 | 2406 | 2.68 | 2.68 | 3 | 3 | PASS | yes | — |
| csv | 3 | inline | 24280 | 23080 | 9210 | 8960 | 9502 | 18712 | 69.31 | 69.31 | 2 | 2 | PASS | yes | — |
| html | 3 | inline | 42967 | 41767 | 16737 | 16512 | 16836 | 33573 | 132.56 | 132.56 | 2 | 2 | PASS | yes | — |
| html | 3 | just-bash-io | 42967 | 41767 | 2427 | 0 | 73 | 2500 | 2.59 | 2.59 | 3 | 3 | PASS | yes | — |

## Comparison with identical outputs

Only pairs where both modes exactly match the expected output and have complete usage are included. Reductions are the median of the per-pair ratios (1 − just-bash-io / inline). Failed pairs are not treated as successes.

| Format | Successful / planned pairs | Median total token reduction | Median total time reduction |
| --- | ---: | ---: | ---: |
| markdown | 0 / 3 | Not comparable | Not comparable |
| csv | 3 / 3 | 87.1% | 96.4% |
| html | 3 / 3 | 92.6% | 98.0% |

## Scope and limitations

Completed measurements: 18 / 18. Exact matches: 15.
This compares full-document model transcription with the combined offload, command editing and direct delivery workflow. It does not establish superiority of just-bash alone or compare against patch tools or other file-editing agents.
The workload is limited to bulk literal replacement in synthetic data; it does not measure complex semantic editing. Results vary with the small sample size, network conditions, API load, prompt caching and in-process initialization caches. Caching is not disabled. No monetary cost conversion is made.
For failures such as timeouts, usage may cover only completed steps and undercount actual billable tokens. Such rows are marked no under Complete usage and excluded from comparisons.
The same directory contains all measurements and SHA-256 hashes in results.json, plus comparison artifacts in *.input.txt, *.expected.txt and *.actual.txt. API keys and .env contents are not saved.
