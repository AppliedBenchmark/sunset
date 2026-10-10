# Code scanning

Sunset writes SARIF 2.1.0, so its findings can appear in GitHub's code scanning (**Security → Code
scanning**) next to CodeQL's. That isn't required: without it, the Action still fails the check, annotates
the findings, writes the job summary and comments on pull requests.

## Availability

Code scanning is free on public repositories. Private and internal repositories need GitHub Code Security
(part of GitHub Advanced Security), and the job needs `actions: read` as well. Without Code Security the upload
fails, so leave the upload step out.

## Setup

```yaml
jobs:
  sunset:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # the PR comment; optional
      security-events: write # the SARIF upload
      actions: read # the SARIF upload, in private repositories only
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: AppliedBenchmark/sunset@v1
        with:
          sarif-file: sunset.sarif
      - uses: github/codeql-action/upload-sarif@v4
        if: ${{ !cancelled() && hashFiles('sunset.sarif') != '' }}
        with:
          sarif_file: sunset.sarif
```

- **`if: !cancelled()`**: Sunset fails the step when it finds errors, and the upload has to run anyway. The
  `hashFiles` check skips the upload when Sunset stopped before writing the file (a config error, say).
- **Run it on a schedule** as well as on pushes, as the README's quickstart does. Retirement dates arrive
  without any code change, and code scanning only updates its alerts when a new upload arrives.
- **From the CLI**, write the file with `sunset scan --format sarif --output sunset.sarif`.

The SARIF file doesn't set a code scanning category, so `upload-sarif` picks one per workflow job and matrix
combination. If one job uploads several Sunset files (one per `path`, say), give each upload its own
`category`: `upload-sarif` accepts one upload per tool and category in a job.

## What is uploaded

- One result per finding at its first location, with the rule ID (`sunset/model-retired`, …), the level
  and the message. The levels map to SARIF's `error`, `warning` and `note`.
- Each rule's description and help, with a link to [rules.md](rules.md).
- Per result: the model ID, the registry entry, the platform, the retirement date and the days left.
- Problems with Sunset's input (a malformed `sunset-ignore` directive, an expired `ignore` entry) as tool
  configuration notifications, not as alerts.

Left out: model IDs in documentation and suppressed findings.
To hide a finding, suppress it in the code or in `.sunset.yml` (see [configuration.md](configuration.md))
rather than dismissing the alert: a suppression is reviewed with the code, can expire with `until`, and also
applies to the check, the annotations and the PR comment.

Code scanning accepts at most 25,000 results per run and rejects a file with more; of those, it only includes
the 5,000 most severe ([GitHub docs](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support#file-compatibility)).
Past 25,000, Sunset keeps the most severe and adds a notification that says how many it dropped; the JSON
report and the job summary have them all.

## Alerts over time

Code scanning tracks each alert by fingerprint, computed by `upload-sarif` from the surrounding code, so an
alert survives unrelated edits. An alert closes when a later upload no longer contains it: when you change
the model ID, suppress the finding or exclude the file.

A finding's level follows the date. A `model-retiring` warning becomes an error 30 days before the
retirement and a `model-retired` error on the day; the next upload updates the alert.

## Pull requests from forks

On pull requests from forks, `GITHUB_TOKEN` is read-only. Sunset works as usual (it fails the check on
errors, annotates the findings and writes the job summary), except that it skips the PR comment and logs a
notice. The upload needs no extra condition: code scanning always accepts results from a run that the
`pull_request` event triggered, even without `security-events: write`
([GitHub docs](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/resource-not-accessible)).
