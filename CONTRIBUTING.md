# Contributing

Thanks for helping. Bug reports, registry corrections and pull requests are all welcome. For a larger change,
open an issue first so we can agree on the approach. Security problems go through
[SECURITY.md](SECURITY.md), not issues. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node.js 24 (`.node-version`) and git. Tests and scripts run the TypeScript directly; only the
bundles need a build.

```sh
git clone https://github.com/AppliedBenchmark/sunset.git
cd sunset
npm ci
npm test
```

The CLI supports Node 22.13 and later, and CI tests 22.13.0, 22, 24 and 26, so don't use APIs newer than
22.13 (`RegExp.escape`, for one, is missing on 22).

## Commands

| Command | What it does |
|---|---|
| `npm test` | All tests, the registry validation, and coverage (fails under 90% of lines in `src/core`) |
| `npx vitest run <file>` | One test file, without coverage |
| `npm run lint` | Biome (format, lint, layer rules, import cycles) and oxlint's type-aware rules |
| `npm run typecheck` | `tsc` with TypeScript 7 |
| `npm run format` | Format everything with Biome |
| `npm run build` | Bundle `dist/action/index.js` and `dist/cli/index.js` |
| `npm run gen:types` | Regenerate `src/core/registry/types.gen.ts` from `registry/schema.json` |
| `npm run registry:format` | Rewrite `registry/models.yaml` in the updater's layout after a hand edit |
| `npm run registry:validate` | Check the registry against its schema, sources and snapshots |
| `npm run bench` | The 100k-line scan benchmark (CI fails over 10 s) |
| `node dist/cli/index.js scan <dir>` | Run the CLI you just built |

## Before you open a pull request

- `npm run lint`, `npm run typecheck` and `npm test` pass.
- **If you changed anything under `src/`**, run `npm run build` and commit `dist/action/index.js`. The Action
  runs that file, and CI fails if it differs from a fresh build. `dist/cli` is built at release time and isn't
  committed.
- Registry data (`models.yaml`, `sources.yaml`, `formats.yaml`, the snapshots) needs no build: the Action
  reads `registry/` from its own checkout. Run `npm run registry:format` and `npm run registry:validate`.
- If you changed `registry/schema.json`, run `npm run gen:types`, and `npm run build` too: the schema is
  compiled into the bundle.
- If you changed a reporter's output on purpose, update its snapshots with `npx vitest run test/report -u`
  and check the diff.
- New behavior has a test. Scanner changes usually get a fixture repo under `test/fixtures/repos/` with an
  `expected.json`. Fixtures use the fake IDs in `test/fixtures/registry/models.yaml`, so they don't change when
  the real registry does.
- Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `docs:`, …). Pull requests are squash-merged, so the title becomes the commit message.
- User-facing changes update the docs (`README.md`, `docs/configuration.md`, `docs/rules.md`).

## Layout

| Path | What's there |
|---|---|
| `src/core/` | The domain and the scan pipeline. Pure: no `node:*` imports, no `fetch`, `process` or `console`. |
| `src/report/` | Reporters (text, JSON, SARIF, annotations, job summary, PR comment). Pure functions of the scan result. |
| `src/adapters/` | Everything that does I/O: files, git, HTTP, the GitHub API, the config and registry files. |
| `src/app/`, `src/cli/`, `src/action/` | Wiring for the CLI and the Action. No business logic. |
| `updater/` | The registry updater. Never bundled. |
| `registry/` | The model registry, its schema, the provider sources and the page snapshots. |
| `test/` | Vitest tests, fixture repos and saved provider pages. |

Biome enforces these layer rules, and `npm run test:boundaries` checks that each rule still fires.
[docs/architecture.md](docs/architecture.md) explains the architecture.

## Registry changes

The registry is only as good as its sources, so it has stricter rules than the code. In short:

- **Every date, replacement and status comes from the provider's official page**, quoted word for word in
  `source_excerpt`, and the excerpt must be in the committed snapshot of that page. Never invent or infer a
  date; never combine values from different rows.
- No official source means no entry, or an `unverified` entry with no dates and no replacements.
- Aliases are exact synonyms only. A floating alias such as `gpt-4o` or a Gemini or Mistral `*-latest`
  name is its own entry. An Anthropic alias that a live Anthropic page ties to a snapshot is an alias of
  that snapshot's entry ([docs/registry.md](docs/registry.md) has the details).
- `drop_in: true` only when the provider says so.
- Run `npm run registry:format`, and make sure `npm run registry:validate` passes. `CODEOWNERS` requests a
  maintainer's review for changes under `registry/`, and a pull request needs a maintainer's approval to
  merge.

[docs/registry.md](docs/registry.md) has the full schema, the rules and the steps to add an entry. To report
a wrong date without fixing it yourself, use the
[registry correction form](https://github.com/AppliedBenchmark/sunset/issues/new?template=registry-correction.yml),
with a link to the provider's page.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
