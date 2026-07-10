# Memory Quality Evals

ContextForge keeps deterministic offline quality evaluation separate from live
provider smoke tests. Offline evaluation is safe for ordinary CI: it uses only
synthetic public fixtures, an isolated temporary SQLite store, and no external
provider or network call. The fixture provider still runs through the real
checkpoint persistence and candidate suggestion paths, so these cases detect
pipeline and policy regressions instead of merely comparing expected fixture
fields with fixture-supplied answers.

Run the baseline suite:

```bash
npm run eval:quality
```

The command writes the complete explainable report to
`artifacts/eval/quality-report.json` and exits non-zero when a fixture or
threshold fails. CI uploads this report as `quality-eval-report`.

## Covered Metrics

Retrieval reports:

- Recall@k, MRR, and nDCG@k;
- repo/shared/local scope and forbidden-key leakage;
- Korean, English, and mixed-query slices;
- exact command, path, API endpoint, and error-string preservation;
- average retrieval latency and maximum returned context items.

Distillation reports fixture-level and fact-category detail for names, numbers,
paths, commands, error strings, decisions, rationale, conditions, and next
actions. Source-linked claims must reference evidence containing their required
support terms. The evaluator also checks forbidden/unsupported claims,
live-state warnings, and retrieval hooks retained after a truncated raw window.

Candidate evaluation reports durable promotion precision, acceptance and
rejection accuracy, repeated-preference handling, duplicate/conflict
classification, and durable-memory/checkpoint/candidate trust ordering. A stale
checkpoint ordering case prevents handoff state from outranking reviewed
durable memory.

## Fixtures And Baseline

- Quality suite: `docs/examples/quality-eval/contextforge-quality.synthetic.json`
- Multilingual retrieval: `docs/examples/quality-eval/multilingual-retrieval.synthetic.json`
- Reused workspace retrieval: `docs/examples/workspace-eval/wastelite.synthetic.json`
- Reviewed baseline and thresholds: `evals/quality-baseline.json`

The report includes the exact query, returned keys/scopes, missing terms,
leaked scopes, unsupported claims, missing warnings/hooks, candidate mismatch,
and failed threshold. This makes regressions actionable instead of producing a
single opaque score.

Baseline changes require review. Do not lower a threshold merely to turn CI
green: update the fixture or implementation, explain any intentionally changed
ranking, and record the new observed baseline. Latency has a generous CI ceiling
because hosted runners vary; ranking, leakage, preservation, hallucination, and
classification thresholds are strict.

## Live Provider Evals

Live-provider quality work remains outside ordinary CI and requires the same
explicit opt-in as other live tests:

```bash
CONTEXTFORGE_LIVE_TESTS=true npm run test:live
```

Never put provider credentials, customer content, or private runtime evidence
in committed eval fixtures or reports.
