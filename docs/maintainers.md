# Maintainers' guide

Releases, the registry updater, and the repository settings they depend on. For day-to-day development,
see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Releases

The CLI and the Action share one version (SemVer). A release publishes:

- `@appliedbenchmark/sunset` on npm, with provenance, through trusted publishing (no npm token anywhere);
- an immutable GitHub release `vX.Y.Z` with the npm tarball, listed on the Marketplace;
- the major tag `v1`, which is what `uses: AppliedBenchmark/sunset@v1` resolves. A maintainer moves it by
  hand once the release is published.

The registry isn't tied to releases. Scans fetch the latest `registry/models.yaml` from `main`, and each
release carries the registry as it was at its commit, as the fallback: the CLI has it built in, and the
Action reads `registry/` from its own checkout.

### Cutting a release

1. **Bump the version** in a pull request titled `chore: release vX.Y.Z`:

   ```sh
   npm version X.Y.Z --no-git-tag-version
   npm run build   # dist/action embeds the version
   ```

   Commit `package.json`, `package-lock.json` and `dist/action/index.js`, and merge once CI passes.
2. **Tag the merge commit** on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

   Only repository admins can create, move or delete `v*` tags (see the tag ruleset under
   [Repository settings](#repository-settings)).

3. **The `Release` workflow** (`.github/workflows/release.yml`) checks that the tag matches `package.json`
   and is on `main`, rebuilds, checks that `dist/action` is unchanged, runs the tests and packs. Then it:
   - stages the tarball on npm (`npm stage publish --provenance`);
   - attests the tarball and the Action bundle (`gh attestation verify <file> -R AppliedBenchmark/sunset`);
   - creates a **draft** GitHub release with generated notes and the tarball.

   It doesn't move `v1`.
4. **Approve the npm version** with 2FA: `npm stage list @appliedbenchmark/sunset`, then
   `npm stage approve <stage-id>`, or the **Staged Packages** tab on npmjs.com. Until then nothing is
   public on npm.
5. **Publish the draft release** under Releases: edit the notes, tick **Publish this Action to the GitHub
   Marketplace**, and publish. The release is immutable from then on: its tag and assets can't change. The
   Marketplace checkbox only exists in the web UI, which is why the workflow leaves a draft.
6. **Move `v1`** to the release, but only if `vX.Y.Z` is the newest release of major version 1; a patch to
   an older minor version leaves it alone. `^{commit}` points `v1` at the commit, not at the annotated tag:

   ```sh
   git fetch --tags --force
   git tag -f v1 'vX.Y.Z^{commit}'
   git push -f origin refs/tags/v1
   ```

7. **Check:** `npx @appliedbenchmark/sunset@X.Y.Z --version`, `npm view @appliedbenchmark/sunset dist-tags`,
   the provenance badge on the npm page, and that `git ls-remote origin refs/tags/v1` shows the release's
   commit.

A **pre-release** (`vX.Y.Z-rc.N`) goes the same way, except that npm gets the dist-tag `next`, the GitHub
release is marked as a pre-release, and `v1` stays where it is.

**If something fails** before the npm version is approved:

1. Reject the staged version, with 2FA: `npm stage list @appliedbenchmark/sunset`, then
   `npm stage reject <stage-id>` ([npm docs](https://docs.npmjs.com/cli/v11/commands/npm-stage)). A staged
   version holds its version number, so staging it again would fail.
2. Delete the draft release and its tag: `gh release delete vX.Y.Z --cleanup-tag --yes`. If the workflow
   stopped before it created the draft, delete the tag alone: `git push origin :refs/tags/vX.Y.Z`.
3. Fix the problem on `main`, and tag again.

Once a version is approved on npm, it can't be published again: fix forward with the next patch version.
A published release can't be changed either; mark it as not the latest, and release a patch.

### First publish (once)

Trusted publishing can only be configured for a package that already exists on npm, so the very first
version goes out by hand.

1. Remove `"private": true` from `package.json` (it prevented an accidental publish while the repository was
   private), and set the version to a pre-release such as `1.0.0-rc.0`. Merge that.
2. From a clean checkout of that commit, with 2FA: `npm ci && npm run build && npm publish --access public
   --tag next`. This version has no provenance, which is why it isn't `1.0.0`.
3. On npmjs.com, under the package's **Settings → Trusted publishing**, add GitHub Actions: organization
   `AppliedBenchmark`, repository `sunset`, workflow `release.yml`, no environment. New configurations allow
   `npm stage publish`; leave direct publishing off. The first publish through it must happen **within 2
   days**, or the configuration expires.
4. Under **Settings → Publishing access**, choose "Require two-factor authentication and disallow tokens".
5. Release `1.0.0` as above.

## Registry updater

The `Registry update` workflow (`.github/workflows/registry-update.yml`) runs daily at 05:17 UTC. What it
does and the rules it follows are in [registry.md](registry.md#updater).

### Setup

The workflow uses a GitHub App's installation token rather than `GITHUB_TOKEN`, because pull requests opened
with `GITHUB_TOKEN` don't run workflows without a manual approval, and `Validate registry` has to run on them.

1. **Create the App:** organization settings → Developer settings → GitHub Apps → New GitHub App.
   - Name: e.g. `sunset-registry-updater`. Homepage: the repository URL.
   - Webhook: off.
   - Repository permissions: **Contents**, **Pull requests** and **Issues**, all read and write. Nothing
     else.
   - Where can it be installed: only on this account.
2. **Generate a private key** on the App's page (a `.pem` file), and note its **Client ID**.
3. **Install** the App on `AppliedBenchmark/sunset` only.
4. **Create the environment:** Settings → Environments → New environment `registry-updater`.
   - Deployment branches and tags: **Selected branches and tags**, with the rule `main`, so jobs on other
     branches can't use it or its secrets. No required reviewers and no wait timer.
   - Environment secrets: `UPDATER_APP_PRIVATE_KEY` (the whole `.pem` file) and the list-models
     credentials below.
5. Under **Settings → Secrets and variables → Actions → Variables**, add the **repository** variable
   `UPDATER_APP_CLIENT_ID` (the Client ID). It can't be an environment variable: the jobs' `if` is evaluated
   before the environment is loaded, so both jobs would be skipped without a word.
6. Delete any repository secret with the same name as an environment secret (a secret is limited to `main`
   only while it exists in the environment alone), and delete the local `.pem`.
7. Run the workflow by hand with `dry-run` on, then off (see below), and check that it opens PRs or reports
   nothing to do.

Until the variable exists, both jobs are skipped.

Each step holds only the credentials it needs. The App's token is split in two, so the step that runs npm
packages and parses third-party pages can't push code or move a tag:

| Step of the `update` job | Credentials |
|---|---|
| Mint the issues token | the App's private key |
| Checkout, setup, `npm ci --ignore-scripts` | the workflow token, `contents: read` |
| Run the updater (npm packages, page parsers) | App token: issues write |
| Mint the pull request token | the App's private key |
| `create-pull-request` (pinned) | App token: contents and pull requests write |

The `check-models` job holds an issues-only App token and the provider keys.

**List-models check (optional).** The `check-models` job compares the providers' list-models APIs with the
registry and files issues for differences. Each provider is skipped unless its credentials are set. Add
them as secrets of the `registry-updater` environment, and use read-only keys with no spending allowed where
the provider supports it:

| Provider | Secrets (and variables) |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Gemini API | `GEMINI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Bedrock | `UPDATER_AWS_ACCESS_KEY_ID`, `UPDATER_AWS_SECRET_ACCESS_KEY`, variable `UPDATER_AWS_REGION`. The IAM user needs only `bedrock:ListFoundationModels`. |
| OpenRouter | none |

### Running it by hand

Actions → Registry update → Run workflow, from `main`: the environment refuses other branches, also for a
dry run. `dry-run` (the default) fetches and parses every page, prints what would change, and opens nothing.
To try an updater change on a branch, run `npm run registry:update -- --dry-run` locally.

### Reviewing its pull requests

There is one pull request per provider (`registry-update/<provider>`, labels `registry` and
`registry-update`). Review it like a hand-made change: the body shows each change with its excerpt and a
link, the rows the HTML page marks differently, and the snapshot diff; `Validate registry` re-checks every
excerpt and writes a review table with changed values as old → new. It can only merge with a
maintainer's approval (see [Repository settings](#repository-settings)). Every provider PR bumps
`registry_version`, so after one merges the others conflict; the next daily run rebuilds them from `main`,
or run the workflow by hand.

- **Closing a pull request doesn't reject its change.** The next run opens it again for as long as the page
  says the same. If a proposed change is wrong, fix the cause: the parser, or the source record.
- **Never push to a `registry-update/*` branch.** Every run force-updates it from `main`, so your commits
  would be lost. Change `main` instead, and let the next run rebuild the pull request.

### Failure issues

A failing source leaves its snapshot and entries alone and opens or updates the provider's issue (label
`updater-failure`); the provider's other sources still apply. The causes: a fetch error, a layout change, a
parse failure, an ungrounded row, a model gone from the page, entries that would not validate, or a change
that would bring a retired model back. If the registry as a whole wouldn't validate, nothing is written, the
errors go into the issue, and the job fails. The issue closes itself when the provider succeeds again, and
the updater only edits and closes issues its own App opened. To fix a parser, see
[registry.md](registry.md#updater).

### Disabled schedule

GitHub disables scheduled workflows in public repositories after 60 days without repository activity.

- **Symptoms:** no new `registry-update` pull requests or `updater-failure` issues, the workflow shows as
  disabled under Actions, and scans warn that the registry's newest check is over 30 days old.
- **Fix:** Actions → Registry update → **Enable workflow**, then run it once by hand with `dry-run` off.
  The same applies to `Scorecard`.

While the updater runs, it moves `verified_on` forward every 14 days even when nothing changed, which is
repository activity and keeps the schedule alive as long as those PRs are merged.

## Repository settings

Applied when the repository goes public:

- **Ruleset on `main`:** require a pull request with 1 approval and review from Code Owners, and the status
  check `CI passed`; block force pushes and deletion. Add **Repository admin** to the bypass list in
  **For pull requests only** mode. A maintainer can then merge their own pull requests, which GitHub doesn't
  let them approve, but only through a pull request, and the updater App can't merge its own. Approval is
  what enforces review: `CODEOWNERS` only requests one, and with 0 required approvals a pull request can
  merge without it. Don't require `Validate registry`: it only runs when `registry/` changes, so a required
  check would block every other pull request.
- **Tag ruleset on `refs/tags/v*`:** restrict creations, updates and deletions, with **Repository admin** as
  the only bypass. Neither the updater App's token nor a workflow can then create, move or delete a release
  tag or `v1`.
- **Private vulnerability reporting:** on (Security → Advisories). See [SECURITY.md](../SECURITY.md).
- **Release immutability:** on (Settings → General → Releases).
- Squash merges only, with the pull request title as the default commit message; head branches deleted on
  merge.
- Labels: `registry`, `registry-update`, `updater-failure`.
- `CODEOWNERS`: changes under `registry/` request a maintainer's review.
- Dependabot: weekly npm and GitHub Actions updates, grouped, with a 7-day cooldown.

Third-party actions are pinned to full commit SHAs. Dependabot updates the SHA and the version comment
together.

## Repository security settings

Also turned on when the repository goes public.

- **Dependabot alerts and security updates:**
  `gh api -X PUT repos/AppliedBenchmark/sunset/vulnerability-alerts`, then
  `gh api -X PUT repos/AppliedBenchmark/sunset/automated-security-fixes`
  ([alerts](https://docs.github.com/en/rest/repos/repos#enable-vulnerability-alerts),
  [security updates](https://docs.github.com/en/rest/repos/repos#enable-dependabot-security-updates)).
- **Secret scanning and push protection:** Settings → Advanced Security, or

  ```sh
  gh api -X PATCH repos/AppliedBenchmark/sunset \
    -f 'security_and_analysis[secret_scanning][status]=enabled' \
    -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
  ```

  ([Update a repository](https://docs.github.com/en/rest/repos/repos#update-a-repository)).
- **CodeQL default setup:** Settings → Advanced Security → CodeQL analysis → Set up → Default, or
  `gh api -X PATCH repos/AppliedBenchmark/sunset/code-scanning/default-setup -f state=configured`
  ([REST](https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration)).
- **Full-SHA pinning for actions:** Settings → Actions → General → **Require actions to be pinned to a
  full-length commit SHA**, or
  `gh api -X PUT repos/AppliedBenchmark/sunset/actions/permissions -F enabled=true -F sha_pinning_required=true`
  ([REST](https://docs.github.com/en/rest/actions/permissions#set-github-actions-permissions-for-a-repository)).
  `gh api repos/AppliedBenchmark/sunset/actions/permissions` shows the result. Every action in this
  repository's workflows is already pinned.
- **Two-factor authentication** for everyone in the `AppliedBenchmark` organization: organization Settings →
  Authentication security → **Require two-factor authentication for everyone in your organization**.
