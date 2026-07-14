# Release And Package Policy

ContextForge treats the package manifest as the canonical release version.
`src/version.js`, CLI/MCP version output, `package-lock.json`, and both README
release summaries must agree with `package.json`.

## Changelog

- Add user-visible changes under `Unreleased` in `CHANGELOG.md`.
- At release time, move those entries under a dated version heading.
- Keep English and Korean README release summaries short and synchronized.
- Put complete operational and provider detail in `docs/`, not the README.

## npm Package Boundary

The published package contains runtime source, public examples, runtime docs,
packaged skills, and install/maintenance scripts. It intentionally excludes:

- explainer images in `docs/assets/`;
- historical design issues in `docs/issues/`;
- tests, CI configuration, generated artifacts, databases, logs, and env files.

The images and historical documents remain in Git; excluding them from npm is a
distribution decision, not repository deletion.

Run the release gate before publishing:

```bash
npm run verify:release
```

The gate validates local Markdown links, documented command file/script
references, version consistency, package allow/deny expectations, and compressed
and unpacked size budgets. It writes the full inventory to
`artifacts/release/package-report.json`; CI uploads the same report.

Current budgets:

- packed tarball: at most 600,000 bytes;
- unpacked package: at most 2,500,000 bytes;
- package entries: at most 150.

Budget increases require an explicit review explaining which published files
grew and why. The July 2026 increase gives the lifecycle worker and packaged
service installers reasonable growth headroom after the distribution reached
about 348,000 packed bytes, 1,536,000 unpacked bytes, and 92 entries. Do not
raise a limit only to turn CI green.
