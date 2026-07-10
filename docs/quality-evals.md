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

Recall, MRR, and nDCG aggregate only queries with explicit `relevantKeys`.
Queries that assert terms, scope roles, or leakage without relevance labels stay
visible as `unjudgedQueries`, but they cannot inflate ranking metrics. Missing a
declared relevant key also fails that query directly.

Offline distillation reports fixture-level persistence and source-link contract
detail for names, numbers, paths, commands, error strings, decisions, rationale,
conditions, and next actions. The deterministic fixture provider supplies the
golden summary, so these scores do not measure a live LLM's writing quality.
They verify that the real checkpoint pipeline preserves that output and links
claims to stored raw evidence. The suite also contains an intentionally broken
negative fixture; CI fails if missing facts, unsupported/forbidden claims,
missing live-state warnings, or missing truncation retrieval hooks are no longer
detected.

Candidate evaluation reports durable promotion precision, acceptance and
rejection accuracy, repeated-preference handling, and duplicate/conflict
classification. Cross-source trust checks use the actual bootstrap contract.
The stale-state case seeds a real structured checkpoint and asserts that it is
returned as a verification-required handoff with a `live_state_may_be_stale`
warning alongside a `reviewed_durable` memory; the evaluator does not invent a
separate stale ranking policy.

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

The same offline suite runs once inside the full Node test suite for contract
coverage and once as the dedicated CI job so the complete JSON report can be
uploaded independently.

## Live Provider Evals

Live-provider quality work remains outside ordinary CI and requires the same
explicit opt-in as other live tests:

```bash
CONTEXTFORGE_LIVE_TESTS=true npm run test:live
```

Never put provider credentials, customer content, or private runtime evidence
in committed eval fixtures or reports.
