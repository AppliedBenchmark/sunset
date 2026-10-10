# Architecture

How Sunset is put together. [CONTRIBUTING.md](../CONTRIBUTING.md) has the setup and the commands.

## Layers

| Path | What it does | Rules |
|---|---|---|
| `src/core/` | The domain: configuration, the registry (ID formats, matching, validation), the scan pipeline and severity. | Pure: no `node:*` imports, no `fetch`, `process` or `console`, and nothing from the other layers. |
| `src/report/` | The reporters: text, JSON, SARIF, annotations, job summary, PR comment, and the review table for registry changes. | Pure functions of the scan result. Imports only from `src/core/`. |
| `src/adapters/` | All I/O, behind the interfaces in `src/core/ports.ts`: files, git, HTTP, the GitHub API, the config and registry files, the clock. | |
| `src/app/`, `src/cli/`, `src/action/` | Wiring: read the flags or inputs, run the scan, write the reports. | No business logic. |
| `updater/` | The registry updater. | Imports from `src/`, but nothing in `src/` imports it, so it is never bundled. |

Biome enforces the import rules (`noRestrictedImports`, `noRestrictedGlobals`) and rejects import cycles
(`noImportCycles`). `npm run test:boundaries` lints files that break each rule on purpose and fails unless
every rule fires, so a config change can't turn a rule off unnoticed.

esbuild builds two bundles. `dist/action/index.js` is committed, because the Action runs it.
`dist/cli/index.js` is built at release time and published to npm. The CLI bundle has the registry built in;
the Action reads `registry/` from its own checkout, at the ref the workflow uses, so a registry change doesn't
change the bundle. A test checks that neither bundle contains updater code.

## A scan

`src/core/pipeline.ts` runs these stages. It gets the files and today's date through ports, so it never
touches the disk or the system clock itself.

1. **List** (`src/adapters/file-source.ts`). Inside a git work tree, `git ls-files` lists the tracked files
   and the untracked ones that aren't ignored. Elsewhere, a directory walk applies every `.gitignore` on the
   way down. Symlinks, submodules and binary files are skipped.
2. **Classify** (`src/core/scan/classify.ts`). Each path is code, config, test, docs, vendored or generated,
   with a language picked by extension or file name. Vendored and generated files, files without a lexer and
   files over `max-file-size` aren't read. A Jupyter notebook is split into its code cells and its markdown
   cells (`src/core/scan/notebook.ts`), and locations are mapped back into the `.ipynb` file.
3. **Prefilter** (`src/core/registry/matcher.ts`). One regular expression covers every form of every registry
   ID. A file with no match, no model-like string and none of the keywords the other detectors look for
   stops here.
4. **Lex** (`src/core/scan/lexers/`). A lexer per language family marks string literals, comments and config
   values. Commands inside other files are lexed as shell: YAML values under keys that hold commands (`run`,
   `command`), Terraform heredocs that are scripts, and a Python notebook's `!` lines and line magics such as
   `%env`. The rest of a notebook cell after a cell magic is lexed in the language the magic runs, such as
   `%%bash` (`src/core/scan/lexers/ipython.ts`). Docs files aren't lexed.
5. **Detect** (`src/core/scan/`). The literal detector finds registry IDs in strings and config values, and
   model-like strings that aren't in the registry (the inventory). The dynamic detector reports model
   parameters set from the environment or a variable. The Azure detector matches deployments by model name
   and version.
6. **Resolve** (`src/core/registry/formats.ts`). The text around a match, such as a Bedrock inference profile
   or ARN, a Vertex resource path, a model router's slug or a library prefix (`bedrock/`, `anthropic:`),
   narrows the platforms it can refer to. A match inside any other path, URL or sentence isn't a reference.
7. **Suppress** (`src/core/scan/suppress.ts`). Inline `sunset-ignore` directives, read only from comments,
   and the `ignore` rules of the config.
8. **Assess** (`src/core/severity.ts`). Each reference gets a rule and a level from its registry entries.
   Days are whole UTC days from the date of the scan.
9. **Report** (`src/report/`). The reporters turn the result into text, JSON, SARIF, annotations, the job
   summary and the PR comment, and the adapters write them.

On a pull request, the Action also scans the base version of the changed files with the same settings
(`src/app/pr-delta.ts`) and keeps the findings the pull request adds (`src/core/delta.ts`).

## The registry updater

`updater/run.ts` keeps `registry/models.yaml` in step with the providers' pages. The `Registry update`
workflow runs it every day, one job per provider. For each source in `registry/sources.yaml`, it:

1. **Fetches** the page (`updater/fetch-source.ts`). Every URL, including each redirect, must be on the
   provider's allowlist. Responses are size-capped and only read as text.
2. **Normalizes** it to plain text (`src/core/registry/normalize.ts`, `updater/html-to-text.ts`), with one line
   per table row.
3. **Snapshots** the text to `registry/snapshots/` (`updater/snapshot-store.ts`). A page that hasn't changed
   leaves its snapshot alone.
4. **Parses** it with a deterministic parser for its layout (`updater/extract/`). There is no LLM.
5. **Grounds** every row: its excerpt must be word for word on the page and contain the row's model ID,
   dates and replacements (`src/core/registry/grounding.ts`).
6. **Merges** the rows into the registry (`updater/merge.ts`). New models are added, values change only
   together with their new excerpt, and nothing is deleted. The result is validated against the snapshots
   before anything is written.

The workflow then opens or updates one pull request per provider, and a maintainer reviews it. A source that
fails (a fetch error, a layout change, a parse failure, an ungrounded row, a model gone from the page)
changes nothing; the provider's issue says why. A second job
compares the providers' list-models APIs with the registry and only files issues
(`updater/check-models.ts`). [registry.md](registry.md#updater) has the rules in full.
