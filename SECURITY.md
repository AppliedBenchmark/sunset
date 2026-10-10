# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)).
Please don't open a public issue. We aim to reply within 5 working days and to agree on a disclosure date
with you.

Supported versions: the latest release of the current major version (`v1`).

In scope: the Action, the CLI, the npm package, the registry and its updater, and this repository's
workflows. A wrong date or a missing model in the registry isn't a vulnerability; open an issue or a pull
request.

## What leaves your machine

The scan reads your files locally, has no telemetry, and doesn't use an LLM. Nothing is sent to us. The
table lists every request a run can involve; the only ones that carry findings go to your own repository on
GitHub.

| When | Request | What it contains |
|---|---|---|
| `registry: remote` (the default) or an `https://` mirror | One `GET` of `registry/models.yaml` from `raw.githubusercontent.com/AppliedBenchmark/sunset/main` (or the mirror) | Nothing about your repository. The host sees your IP address and Node's default request headers. |
| `registry: bundled` or a local path | none | |
| The Action on a pull request, when it needs the base commit and the checkout doesn't have it | `git fetch` of that commit from your repository on GitHub, with the workflow's token | |
| The Action on a pull request, with `pr-comment` on | GitHub API calls, with the workflow's token, to find, create or update one comment on that pull request, and at most one query for the account the token belongs to | The findings the pull request adds, and the existing ones when they fail the check, posted to your repository |
| Your workflow uploads the SARIF file | Your own `upload-sarif` step sends it to your repository's code scanning | The findings |

The CLI makes no network call other than the registry fetch.

## Threat model

**A tampered or broken remote registry.** The fetched registry is untrusted input. Sunset reads it within
size, time and parsing limits (at most 8 MiB, a 3-second timeout, and at most 1,000,000 YAML tokens with no
aliases), parses it as YAML that can't run code, and validates it against the schema and the registry's own
rules (computed IDs, consistent dates, no duplicates). Fields and entries that this version of Sunset
can't read, entries that fail a check of their own among them, are left out, and the registry that comes
with the release fills in every ID the fetched one then lacks, so the fetched registry never knows less than
the release; the log says how many. If a check across entries fails (a duplicate ID, say), the file's
`schema_version` isn't one this version reads, or its `registry_version` is lower than that of the registry
that comes with the release, the scan uses the registry that comes with the release, and says so.

A registry can't run code, but it decides what is reported. Someone who could change
`registry/models.yaml` on `main` could hide a retirement, or mark common model IDs as retired and fail the
CI of every repository that uses the remote registry. The review of every registry change, below, guards
against that. To rule it out, pin `registry: bundled`, or point `registry` at a copy you control.

**Registry content.** Every dated entry carries a word-for-word excerpt from an allowlisted provider page,
and CI checks each excerpt against the stored snapshot of that page. `CODEOWNERS` requests a maintainer's
review for changes under `registry/`, and the ruleset on `main` requires an approval for every pull request
that a maintainer didn't open, the updater's included. Fetched pages are treated as data: they are never
executed, and Mistral's TypeScript model files are read as text.

**Text from the scanned repository.** File names, `.sunset.yml` and code end up in the terminal and in the
workflow log. In the CLI's output and the Action's log, Sunset shows the control characters and
bidirectional overrides in them as `\uXXXX` escapes, so they can't move the cursor, clear the screen or
write to the clipboard. It escapes a `::` that would start a line and any `##[` the same way, so that text
can't start a workflow command, and it parses YAML from the repository without warnings, which would
quote it to stderr unescaped. The JSON, SARIF and Markdown reports are data for other tools, and keep these
characters.

**Supply chain.**

- From 1.0.0 on, releases are published to npm with trusted publishing (OIDC, no long-lived token) and
  provenance. A maintainer approves each staged version with 2FA, and npm is set to require 2FA and disallow
  tokens for the package.
- GitHub releases are immutable. The release tarball and the Action bundle carry build attestations
  (`gh attestation verify`).
- The Action runs the committed `dist/action/index.js`; CI fails if it differs from a fresh build of the
  source. Its fallback registry is `registry/` in its own release, at the ref your workflow uses.
- Only repository admins can create, move or delete release tags, `v1` included.
- Every third-party action is pinned to a full commit SHA. Workflows have minimal `permissions`, are
  checked with actionlint and zizmor, and never use `pull_request_target`. Secrets exist only in the
  scheduled updater workflow.
- The CLI and the Action are self-contained bundles; the npm package has no runtime dependencies.
  Dependabot updates the dependencies and the actions weekly with a cooldown, and OpenSSF Scorecard runs
  on `main`.

**Your token.** The Action uses the workflow's `GITHUB_TOKEN` only for the pull request comment and to fetch
the base commit, and passes it to git through the environment, never on the command line. It needs
`contents: read`, plus `pull-requests: write` for the comment. It only updates a comment that the token's
own account wrote. When GitHub refuses the comment, as it does on pull requests from forks, whose token is
read-only, Sunset logs a notice instead of failing.
