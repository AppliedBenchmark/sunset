# Configuration

Sunset works without configuration. To change what it scans or when it fails, add `.sunset.yml` (or
`.sunset.yaml`) to the scanned directory, or pass a file with `--config` (CLI) or `config:` (Action).

CLI flags and Action inputs override the file, and the file overrides the defaults. The file is validated
against [`schemas/config.schema.json`](schemas/config.schema.json); an unknown key or a bad value stops the
run with exit code 2 and a list of every problem.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/AppliedBenchmark/sunset/main/docs/schemas/config.schema.json
fail-on: warning
platforms: [openai, bedrock]
exclude:
  - examples/**
ignore:
  - paths: [legacy/**]
    reason: frozen until the rewrite
  - models: [gpt-4-0613]
    rules: [model-retiring]
    until: 2027-01-31
    reason: 'migration tracked in #123'
```

Quote a value that contains ` #` or starts with `*`. YAML reads everything after ` #` as a comment, and a
leading `*` as an alias: unquoted, `reason: migration tracked in #123` becomes `migration tracked in`, and
`exclude: [*.json]` isn't valid YAML.

Sunset never scans its own config files: every `.sunset.yml` and `.sunset.yaml`, and the file given with
`--config` or `config:`. Their `ignore` rules name model IDs on purpose.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `include` | all files | Path globs. When set, only matching files are scanned. |
| `exclude` | none | Path globs that are never scanned. Dependency and build directories (`node_modules`, `vendor`, `third_party`, `dist`, `build`, `.next`, `_next`, …), lockfiles, minified files named `*.min.*`, and generated files (`*.generated.*`, `*_pb2.py`, … and any file with a `Code generated … DO NOT EDIT.` or `@generated` comment near its top) are skipped anyway. |
| `docs` | none | Extra path globs that count as documentation. Model IDs in docs are listed as mentions and never fail a run. `*.md`, `*.mdx`, `*.rst`, `*.txt` and `docs/**` always count. |
| `ignore` | none | Findings to suppress; see below. |
| `legacy` | `false` | Also report models the provider calls *legacy* (no retirement announced), as notices. |
| `fail-on` | `error` | The lowest severity that fails the run: `error`, `warning` or `never`. Docs mentions, unresolved references and suppressed findings never fail a run. |
| `fail-scope` | `all` | On pull requests in the Action: `all` fails on every finding at or above `fail-on`; `new` fails only on findings the pull request adds, so existing ones don't block anyone while you work through them. Everywhere else (pushes, the CLI) every finding counts. |
| `registry` | `remote` | Where the model registry comes from; see below. |
| `max-file-size` | `1048576` | Files larger than this many bytes are skipped and counted. For a Jupyter notebook it is the size of the code cells; outputs don't count. |
| `platforms` | all | The platforms the repository uses: `openai`, `anthropic`, `gemini-api`, `vertex`, `bedrock`, `azure-openai`, `mistral`, `deepseek`. Registry entries for other platforms are ignored, so an ID served on several platforms gets the dates of the one you use. |

**When `platforms` isn't set**, Sunset infers the platforms from the repository's dependency manifests
(`package.json`, `requirements*.txt`, `pyproject.toml`, `Pipfile`, `setup.py`/`setup.cfg` and `go.mod`; in
`pyproject.toml`, the `[project]` dependencies, `[dependency-groups]` and Poetry's dependency tables):
`@anthropic-ai/sdk` means Anthropic, `@google-cloud/vertexai` Vertex, and so on. Google's Gen AI SDKs
(`@google/genai`, `google-genai`, `google.golang.org/genai`) count for both the Gemini API and Vertex, since
they call either. Packages that don't say which platform they call, such as `boto3`, don't count. The inferred platforms only matter for an ID that several platforms serve:
Sunset then judges the ID by the platforms the repository uses. If none of them serves it, every platform's
dates still count, so nothing is hidden. The run logs what it inferred and from which file, and the finding
says which platform it was judged for. Setting `platforms` turns this off.

Globs are relative to the scanned directory and use [picomatch](https://github.com/micromatch/picomatch)
syntax. A glob also matches everything under a directory it names, so `legacy` and `legacy/**` are the
same.

### `ignore`

Each rule needs at least one of `paths`, `models` or `rules`, and suppresses a finding when every key it
sets matches:

- `paths`: path globs.
- `models`: the ID as written in the code, the registry's `model_id`, or a registry entry ID such as
  `openai:gpt-4-0613`.
- `rules`: rule IDs, with or without the `sunset/` prefix. See [rules.md](rules.md).
- `until`: the last day the rule applies (`YYYY-MM-DD`). Afterwards it stops applying, and the run
  reports that it expired.
- `reason`: shown with the suppressed finding in the summary and the JSON report.

For a single line, an inline comment is usually better: `sunset-ignore`, `sunset-ignore-next-line` or
`sunset-ignore-file`, each with optional `until=YYYY-MM-DD` and `reason="…"`. In a comment that spans several
lines, `sunset-ignore-next-line` means the line after the comment ends. Directives are read only from
comments, so they don't work in a file that has none, such as a plain JSON file; use an `ignore` rule there.
They do work in `#` lines inside a YAML block scalar, after a command in a `run: |` script, and in a notebook's
code cells, where the next line is the next line of the same cell.

### `registry`

| Value | Behavior |
|---|---|
| `remote` | Fetches the latest `registry/models.yaml` from this repository's `main` branch (3 s timeout, size cap), validates it, and falls back to the copy bundled with this release on any failure, with a warning. An entry it lacks, or has in a form this version can't read, comes from the bundled copy. A registry older than the bundled copy (a lower `registry_version`) isn't used: the bundled copy is, with a warning. |
| `bundled` | Uses the bundled copy. No network calls at all. |
| an `https://` URL | A mirror, fetched and validated like `remote`, with the same fallback. Redirects are followed only to `https://` URLs. A mirror older than the bundled copy is stale, so the bundled copy is used, with a warning. |
| a path | A local `models.yaml`, for air-gapped use. Relative to the config file; for `--registry`, to the working directory; for the Action's `registry` input, to the workspace. A missing or invalid file is a config error. |

Every run logs which registry it used and its version, and warns when the registry's newest check is more
than 30 days old.

The scan never uploads your code. Besides the registry fetch, only the Action makes network calls, on pull
requests: a `git fetch` of the base commit when the checkout doesn't have it, and the GitHub API calls for the
PR comment, which shows findings on that pull request. [SECURITY.md](../SECURITY.md#what-leaves-your-machine)
lists each request.

### Behind a proxy

Node's built-in `fetch`, which Sunset uses for the registry and the GitHub API, ignores `HTTPS_PROXY` unless
`NODE_USE_ENV_PROXY=1` is set ([Node.js docs](https://nodejs.org/api/cli.html#node_use_env_proxy1)). That
needs Node 22.21 or later on Node 22, and works on every Node 24 and later; the Action runs on Node 24.

```yaml
- uses: AppliedBenchmark/sunset@v1
  env:
    NODE_USE_ENV_PROXY: '1'
    HTTPS_PROXY: http://proxy.example.com:8080
```

Otherwise, use `registry: bundled`, which makes no registry request at all.

## CLI

```
sunset scan [path] [--format text|json|sarif|markdown] [--output <file>] [--config <file>]
                   [--registry <mode>] [--fail-on <level>] [--platforms <list>] [--legacy]
                   [--today <date>] [--no-color] [--debug]
sunset registry info [--format text|json] [--config <file>] [--registry <mode>] [--today <date>] [--debug]
sunset registry validate [file] [--today <date>]
```

Reports go to stdout (or `--output`), and logs to stderr. `--debug` adds detail to the log, such as the
settings in effect and how long each stage took. `--today` judges dates as of another day (`YYYY-MM-DD`), to
see what is coming. Paths in reports are relative to the repository's root when the scanned directory is in
a git work tree, and to the scanned directory otherwise. Exit codes: 0 no findings at or above `fail-on`, 1 findings
at or above it, 2 a usage or config error, 3 an internal error.

## Action

```yaml
permissions:
  contents: read
  pull-requests: write # only for the PR comment

steps:
  - uses: actions/checkout@v7
    with:
      persist-credentials: false
  - uses: AppliedBenchmark/sunset@v1
    with:
      sarif-file: sunset.sarif
```

| Input | Default | Meaning |
|---|---|---|
| `path` | `.` | The directory to scan. A path that isn't a directory fails the step. |
| `config` | `.sunset.yml` or `.sunset.yaml` in `path` | A config file. |
| `registry`, `fail-on`, `fail-scope`, `platforms` | from the config file | As above; `platforms` is comma-separated. |
| `sarif-file`, `json-file` | none | Write the SARIF or JSON report there. |
| `annotations` | `true` | Annotate findings (at most 10 per level; the summary has the rest). |
| `summary` | `true` | Write the job summary. |
| `pr-comment` | `true` | On pull requests, keep one comment up to date with the findings the pull request adds. |
| `github-token` | `${{ github.token }}` | For the PR comment, and to fetch the base commit. |

**The PR comment** lists only what the pull request adds. Sunset compares the changed files with the base
revision (the first parent of GitHub's merge commit), fetching it when the checkout is shallow. A finding
counts as new when its rule, model, file and line text aren't in the base, so moving a line doesn't make
it new. The comment is created when there is something new, or when the check fails because of findings
that were already in the code; it then explains that, lists them, and points to `fail-scope: new`. With
`fail-scope: new`, existing findings appear collapsed and don't fail the check. Once the comment exists it is
updated on every run, but only if the token's own account wrote it: anyone can post a comment that looks
like Sunset's. If the base revision can't be read, every finding counts, whatever `fail-scope` says.

When GitHub refuses the comment (HTTP 403), Sunset logs a notice, keeps the job summary, and doesn't fail.
Pull requests from forks get a read-only token; other pull requests need `pull-requests: write`.

**Code scanning:** upload the SARIF file with `github/codeql-action/upload-sarif@v4` in a job with
`security-events: write`, plus `actions: read` in a private repository. See
[code-scanning.md](code-scanning.md).

### Outputs

| Output | Value |
|---|---|
| `errors` | The number of findings at error level. |
| `warnings` | The number of findings at warning level. |
| `notices` | The number of findings at notice level. Unresolved references aren't counted. |
| `sarif-file` | The SARIF file's absolute path, or empty if none was written. |
| `json-file` | The JSON report's absolute path, or empty if none was written. |
| `registry-origin` | Where the registry came from: `remote` (also for a mirror), `bundled` or `file`. |
| `registry-version` | The registry's `registry_version`. |

The counts cover every finding in the scan, not only those the pull request adds, and leave out docs
mentions and suppressed findings. For example, to report on pull requests but fail only the weekly run:

```yaml
- uses: AppliedBenchmark/sunset@v1
  id: sunset
  with:
    fail-on: never
- name: Fail the weekly run on errors
  if: github.event_name == 'schedule' && steps.sunset.outputs.errors != '0'
  env:
    ERRORS: ${{ steps.sunset.outputs.errors }}
  run: |
    echo "::error::Sunset found $ERRORS errors. The job summary lists them."
    exit 1
```
