# just-bash-io performance benchmark results

[日本語](./README.ja.md)

On September 19, 2026 (JST), 18 cases were run against the live OpenAI API using `OPENAI_API_KEY` from `.env`.
**CSV and HTML used fewer tokens and finished faster while preserving identical outputs. The inline Markdown runs introduced transcription errors, so an identical-output performance comparison was not possible.**

Model: `gpt-4.1-mini-2025-04-14`. Each format contains 300 records; each mode was run three times.
Input sizes: Markdown 38,477 bytes, CSV 24,280 bytes, HTML 42,967 bytes.
The edit replaces every `PENDING_REVIEW` with `APPROVED`, preserving all other content.

| Format | Inline exact matches | just-bash-io exact matches | Total token reduction | Total time reduction |
| --- | ---: | ---: | ---: | ---: |
| Markdown | 0 / 3 | 3 / 3 | Not comparable | Not comparable |
| CSV | 3 / 3 | 3 / 3 | 87.1% | 96.4% |
| HTML | 3 / 3 | 3 / 3 | 92.6% | 98.0% |

Reductions are medians of per-pair ratios, using only pairs where both modes exactly matched the expected output.

| Format | Inline median total tokens | just-bash-io median total tokens | Inline median total seconds | just-bash-io median total seconds |
| --- | ---: | ---: | ---: | ---: |
| CSV | 18,712 | 2,406 | 71.89 | 2.68 |
| HTML | 33,573 | 2,500 | 138.81 | 2.59 |

In the inline Markdown runs, unchanged text `**Keep**` became `**Keep」`.
The first mismatches occurred on lines 123, 28 and 100 in the respective runs. The tests detected these as failures.
The E2E result was therefore **15 passed / 3 failed**, with command exit code 1.
There were no API errors, timeouts or missing usage records. All nine just-bash-io cases passed.

These findings are limited to a small sample of synthetic data and literal replacement tasks. Total tokens include cached input tokens; the percentages are not monetary cost reductions.
Other patch tools and semantic editing workloads were not evaluated.

- [All measurements, methodology and limitations](./2026-09-18T15-23-25.189Z/REPORT.md)
- [Machine-readable metrics and SHA-256 hashes](./2026-09-18T15-23-25.189Z/results.json)
- [Reproduction instructions and settings](../e2e/README.md)

Run with `npm run test:e2e`. The regular `npm test` command does not call external APIs.
At the time of the benchmark, all 28 offline tests, type checking and the build passed.
Input/output hashes, expected-output equality, token totals and timing consistency were independently verified for all 18 measurements.
