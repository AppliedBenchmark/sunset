# The model registry

The registry is the list of model IDs Sunset knows about, with their lifecycle dates. Every value in it
comes from an official provider page and can be checked against a stored copy of that page.

| File | What it holds |
|---|---|
| `registry/models.yaml` | The entries |
| `registry/sources.yaml` | One record per provider page: its URL, the variant to fetch, and the allowlist |
| `registry/formats.yaml` | ID-format data: Bedrock geo prefixes and ARN partitions, the vendor slugs of OpenRouter and the Vercel AI Gateway, and libraries' platform prefixes |
| `registry/snapshots/<provider>/<slug>.txt` | The normalized text of each source page, plus a `.meta.json` |
| `registry/schema.json` | JSON Schema 2020-12 for all three YAML files (`$defs/SourcesFile`, `$defs/PlatformFormats`) |

`src/core/registry/types.gen.ts` is generated from the schema with `npm run gen:types`; CI fails if it is
stale.

## Commands

```sh
npm run registry:snapshot                          # fetch and normalize every source page
npm run registry:snapshot -- openai/deprecations   # only the named sources
npm run registry:snapshot -- --dry-run             # report what changed without writing
npm run registry:format                            # rewrite models.yaml in the updater's layout
npm run registry:validate                          # validate everything; exit 1 on errors
npm run registry:validate -- --base <models.yaml>  # also print the review table for what changed
npm run registry:update -- --dry-run               # fetch and parse every source; print what would change
npm run registry:update -- --provider openai       # update one provider's snapshots and entries
npm run registry:check-models -- --dry-run         # compare the list-models APIs with the registry
```

`npm test` runs the same validation, and checks that `models.yaml` is in the layout the updater writes, so
a broken or hand-formatted registry fails CI. After editing `models.yaml` by hand, run
`npm run registry:format`. On PRs that touch `registry/`, the `Validate registry` workflow also writes a review
table (entry, dates, excerpt, link) to the job summary.

## Entries

```yaml
- id: 'anthropic:claude-sonnet-4-5-20250929'   # computed; see below
  provider: anthropic          # who makes the model
  platform: anthropic          # where it is served: openai | anthropic | gemini-api | vertex | bedrock | azure-openai | mistral | deepseek
  model_id: claude-sonnet-4-5-20250929         # exactly as written in code
  version: null                # azure-openai only: the model version
  aliases: []                  # exact synonyms only
  status: deprecated           # active | legacy | deprecated | retired | unverified
  deprecation_date: null       # YYYY-MM-DD, only if the excerpt contains it
  retirement_date: '2026-11-30'
  retirement_date_qualifier: exact             # exact | no_earlier_than | approximate
  recommended_replacements:
    - { model_id: claude-sonnet-5-5, platform: anthropic }
  drop_in: false               # true only if the provider says "drop-in"
  source: anthropic/model-deprecations         # a record in sources.yaml
  source_url: https://platform.claude.com/docs/en/about-claude/model-deprecations
  source_excerpt: '| November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5` |'
  verified_on: '2026-10-08'
  notes: null
```

An entry whose dates apply only in some regions also has `regions`, after `version`; see "Region scope"
below.

### The `id`

`id` is never chosen by hand. The validator computes it as `platform:model_id[@version][#regions]`, with
the regions sorted and comma-separated, and rejects entries whose `id` differs. Examples:
`openai:gpt-4o-2024-08-06`, `azure-openai:gpt-4o@2024-08-06`,
`bedrock:anthropic.claude-3-haiku-20240307-v1:0#us-gov-east-1,us-gov-west-1`.

### Seeding rules

Never invent dates or replacements.

- **Excerpts.** `source_excerpt` is copied word for word from the normalized snapshot of `source`,
  normally one table row or one sentence. It must contain the model ID, every date the entry sets, and every
  replacement ID. Values are never combined from different rows. A date in a heading above a table isn't
  part of the row, so `deprecation_date` stays null unless the excerpt contains it.
- **Status.**
  - `retired`: the retirement date is today or earlier, or the page says it is retired (and gives a date).
  - `deprecated`: the page deprecates it and gives a later retirement date.
  - `active`: the page lists it as available. It may still carry an announced date, such as Anthropic's
    "not sooner than" dates, Vertex's "or later" dates and the Gemini API's earliest possible shutdown dates,
    which use `retirement_date_qualifier: no_earlier_than`. The Gemini API page announces deprecations in its
    release notes, not in its table, so a dated row there that isn't marked as shut down is `active`.
  - `legacy`: the page calls it legacy (no longer updated). Not reported by default.
  - `unverified`: anything that can't be tied to a quote. Without an excerpt, an entry has no dates and no
    replacements.

  Severity comes from the dates first, so a `legacy` or `active` entry with a near date is still reported.
  One exception: an `active` entry with a `no_earlier_than` date is at most a warning, even once the date has
  passed, because the provider still lists the model. When an ID is shared by several platforms, it is an
  error only if every platform says so; otherwise a warning names the platforms where it isn't at risk.
- **Lifecycle words.** Providers use their own words for a model's state. Where they differ from the
  registry's:

  | Page | Word | Status |
  |---|---|---|
  | Bedrock lifecycle tables | Legacy (the Legacy date is the `deprecation_date`, the EOL date the `retirement_date`) | `deprecated`, or `retired` once the EOL date has passed |
  | Azure retirement schedule | GA, Preview | `active` |
  | Azure retirement schedule | Legacy | `legacy` |

  Each parser in `updater/extract/` says how it reads its page.
- **Qualifiers.** `no_earlier_than` needs the excerpt to say so ("not sooner than", "or later", "at
  earliest"), or the source to state it once for the whole page in `page_qualifier` (Gemini API's dates are
  the earliest possible shutdown dates).
- **Replacements** are only IDs the excerpt names; display names such as "Codestral" are left out.
- **Aliases** are exact synonyms only. A floating alias (one that moves to newer models: OpenAI `gpt-4o`,
  Gemini `*-latest`, Mistral `*-latest`) is its own entry with its own status, or is left out. Anthropic's
  Claude API aliases for models before the 4.6 generation point to the newest snapshot of their minor
  version. One that a live Anthropic page ties to a snapshot in the registry (`claude-sonnet-4-5`,
  `claude-3-5-haiku-latest`) is an alias of that snapshot's entry, whose `notes` link the page; one that no
  live page documents (`claude-3-7-sonnet-latest`) is left out. The validator warns about aliases that look
  floating, these included.
- **Region scope**. When a platform lists different
  dates for the same model in different regions (Bedrock), each row becomes its own entry with a sorted
  `regions` list, and the regions are part of its `id`:

  ```yaml
  - id: 'bedrock:anthropic.claude-3-haiku-20240307-v1:0#us-gov-east-1,us-gov-west-1'
    regions: [us-gov-east-1, us-gov-west-1]
  ```

  A region is written as the platform writes it, in lowercase letters, digits and hyphens (`us-gov-west-1`,
  `eusc-de-east-1`, `us-central1`). Regions of sibling entries must not overlap, and at most one sibling has
  no `regions`: it covers every other region. The scanner reports the earliest date and lists the others in
  the message.
- **Azure** entries are keyed by model name and version, because Azure deployments are matched on both. Every per-model table of the retirement
  schedule is seeded except fine-tuned models; rows without a version are left out.
- **Vertex** IDs are written as Google's page writes them. Claude models before 4.6 appear without their
  `@YYYYMMDD` version (`claude-3-haiku`); the matcher also matches them with a version
  (`claude-3-haiku@20240307`). Open models served as a service (MaaS) are written without their publisher
  (`llama-3.3-70b-instruct-maas`); the matcher also reads them as `meta/llama-3.3-70b-instruct-maas` and in
  `publishers/…/models/…` paths.

## Adding or changing an entry

For every provider except DeepSeek, let the updater do it: it adds the new models it finds on the pages in
`registry/sources.yaml`, with the excerpt and the dates filled in.

```sh
npm run registry:update -- --provider openai   # refresh the snapshots and merge what changed
npm run registry:validate
```

A model with a page of its own (a Bedrock model card, a Vertex page for a Claude, Grok or Imagen model) only
gets an entry once that page is a source: add a record to `registry/sources.yaml`, as in step 1 below, and
run the updater.

By hand (a DeepSeek model, a correction, an alias or a note):

1. Find the page in `registry/sources.yaml`. A new page needs a source record: its `url`, the variant to
   fetch, the provider's allowlist and the `expect` text. Then fetch it with `npm run registry:snapshot --
   <provider>/<slug>`.
2. Copy the excerpt word for word from `registry/snapshots/<provider>/<slug>.txt`, not from the browser: the
   snapshot is normalized (see below). Take one table row or one sentence that contains the model ID, every
   date you set and every replacement.
3. Write the entry by the rules above. Set `verified_on` to today. For the `id`, write
   `platform:model_id`; the validator prints the expected value if it is wrong.
4. Run `npm run registry:format`, then `npm run registry:validate`, and fix every error. Warnings are worth
   reading too.
5. Open a pull request. `Validate registry` posts a review table with each changed entry, its excerpt and a
   link to the page, and a maintainer reviews it.

A model that no official page mentions stays out, or is added as `unverified` with no dates or
replacements.

## Sources and snapshots

Each source names the human page (`url`, used as `source_url`) and the machine-readable variant to fetch: a
Markdown endpoint, an HTML page, a file in a public docs repository (`github-file`), or a directory of files
(`github-dir`, Mistral). Every URL fetched, including each redirect, must start with one of the provider's
allowlisted prefixes (scheme, host and path). Fetched files are only read as text, never executed.

An entry belongs to one source, and a row for an entry another source owns fails the source. Two pages only
add models: Azure's retired-models page repeats the retirement schedule's retired versions, and the Gemini
API release notes repeat the shutdowns in the deprecations table. Their rows for another source's entries
are left to that source.

Snapshots are normalized so they diff cleanly and excerpts can be checked against them:

- Unicode NFC; look-alike hyphens and spaces become ASCII; zero-width characters are removed.
- Markdown links and images keep only their text; HTML comments are removed.
- HTML pages are reduced to text from their main content. Tables become one `| … |` line per row, with
  rowspan and colspan cells repeated, so each row stands alone (Bedrock's per-region rows).
- Lines are trimmed and runs of spaces and blank lines collapse.

`.meta.json` records the URLs fetched, the time, the ETag, the SHA-256 of the normalized text and the
normalizer version. A snapshot whose text hasn't changed is left alone. A source with `markup` names an HTML
page whose table-row classes carry state the fetched variant lacks; the meta file records the first cell of
each such row under `row_classes` (the Gemini API page marks shut-down models only with `row-gray`). The
`expect` field of a source is text the page, and its markup page, must contain, which catches soft 404s
(DeepSeek returns its home page with a 200 for unknown paths) and pages in another language. Google's HTML
docs answer Node's `Accept-Language: *` with a redirect to a random language, so a Google HTML URL is pinned
with `?hl=en`. A request that fails with a network error, a timeout, a 429 or a 5xx is retried once; a
response over 5 MiB is refused while it is read. The pages belong to their publishers; see
[registry/snapshots/README.md](../registry/snapshots/README.md).

## Validation

| Check | Level |
|---|---|
| Schema (all three files) | error |
| `id` matches the computed id; regions sorted | error |
| Azure entries have a version; others don't | error |
| Dates parse; deprecation ≤ retirement; `verified_on` not in the future (one day of slack) | error |
| `retired` and `deprecated` entries have a date | error |
| Only `unverified` entries may omit the excerpt, and then have no dates or replacements | error |
| Duplicate ids; an alias or model ID colliding with another entry's; overlapping regions | error |
| An alias that repeats the entry's own model ID | error |
| `drop_in` without a replacement; an entry replacing itself | error |
| `source` exists, covers the platform, and `source_url` is its URL and on the allowlist | error |
| Source, fetch and `markup` URLs on the provider's allowlist; source ids unique and prefixed by the provider | error |
| The source has a snapshot; the excerpt is in it; the model ID, version, dates and replacements are in the excerpt | error |
| A `page_qualifier` excerpt is in its snapshot | error |
| Every ID in a source's `models` is in its snapshot | error |
| Floating-looking aliases; a replacement not in the registry; `no_earlier_than` or `drop_in` the excerpt doesn't state | warning |

`npm run registry:validate`, `npm test` and `sunset registry validate` check the registry strictly.

When a scan loads a registry, it runs the schema and key checks; the source and excerpt checks need the
snapshots, which only the repository has. A registry from outside the release (the remote one, a mirror, or
a local file given with `registry:`) is read within limits and forward-compatibly:

- At most 8 MiB is fetched, within 3 seconds, and the file may have at most 1,000,000 YAML tokens and no
  aliases.
- Fields this version of Sunset doesn't know are dropped, and so are replacements on a platform it doesn't
  know.
- An entry is skipped when its platform, status or date qualifier is one this version doesn't know, or when
  it fails a check of its own: the schema (a region name this version's schema doesn't accept, say), or any
  check that needs no other entry, such as its computed `id`, its dates, its replacements or its aliases.
  The log says how many entries were skipped and suggests updating Sunset; the debug log names each one and
  why.
- The remote registry and a mirror never know less than the bundled copy. One whose `registry_version` is
  lower than the bundled copy's, such as a stale mirror, isn't used: the scan uses the bundled copy and
  warns. Otherwise, for every `id` they lack once read, because its entry was skipped or removed, the
  bundled copy's entry is kept, and the log says how many. A local file is used as it is, whatever its
  version: skipped entries are a warning, and a file with no entry this version can read is a config
  error.
- A registry with a problem across entries (a duplicate `id`, a model ID or alias that names two models on
  one platform, overlapping regions), a problem outside the entries, or a `schema_version` other than 1 isn't
  used: the remote registry and a mirror fall back to the bundled copy with a warning, and a local file is a
  config error. CI rejects a registry with a problem across entries, and skipping entries never causes one,
  but keeping a bundled entry can: when a newer version moved an alias from an entry this version skips to
  another one, say.

The bundled copy is always read strictly.

### Changing the format

Every released version of Sunset fetches `registry/models.yaml` from `main` for as long as it is used. So
within `schema_version` 1, the registry may only grow:

- new optional fields, which older versions drop;
- new platforms, statuses or date qualifiers, whose entries older versions skip;
- values an older version's schema doesn't accept, whose entries it skips.

An older version keeps its bundled copy's entry for every `id` whose entry it skips, or that is gone: an
entry deleted from `main` stays in the releases that bundle it. The rules across entries can't change:
unique `id`s, each model ID and alias naming one model per platform, and regions that don't overlap. Older
versions check them on the whole file, their kept entries included. So moving a model ID or alias away from
an entry they skip makes them fall back to their bundled copy, and so can changing an entry's `regions`,
which changes its `id`: their old entry is kept, and may overlap the new one. Anything an older version
can't safely ignore, such as a renamed or removed field or a field whose meaning changes, needs
`schema_version` 2. A version 2 registry has to be published at a new path, so that `registry/models.yaml`
stays readable by every 1.x release.

`Validate registry` checks this on every pull request: it reads the changed `models.yaml` the way a release
does whose bundled copy is the base branch's, and fails if that release couldn't use it.

## Updater

The `Registry update` workflow (`.github/workflows/registry-update.yml`) runs daily. For each provider it
fetches the sources, refreshes their snapshots, parses them with deterministic code, never a language model, and opens one PR per provider
(`registry-update/<provider>`, titled `chore(registry): update <provider> (…)`) with the changes, each shown
with its excerpt and a link, plus the snapshot diff. `Validate registry` runs
on those PRs like on any other; review them as you would a hand-made change. The rules:

- **Grounding.** A row is used only if its excerpt is word for word on the normalized page, the excerpt
  contains its ID, version, date strings and replacements, and each date string parses to the stored date.
  The accepted date formats are `YYYY-MM-DD`, `Month D, YYYY` and `Mon D, YYYY`, optionally with `at
  earliest`, `Not sooner than`, `No sooner than`, `No earlier than` or `or later` (which mean
  `no_earlier_than`). `To be announced`, `No shutdown date announced`, `No retirement date announced`, `N/A`
  and `—` mean no date. Anything else is a parse failure.
- **Merging.** New models are added. An entry's values change only together with the new excerpt. Aliases,
  notes and `drop_in` are yours: the updater keeps them, never sets `drop_in`, and clears it when the
  replacements change. Nothing is deleted. A change that takes an entry out of `retired`, or drops its
  retirement date, is never applied: providers don't bring retired models back, so the source fails for a
  person to check the page and the parser. The two pages that only add models (see
  [Sources and snapshots](#sources-and-snapshots)) leave rows for other sources' entries alone.
- **Checks before writing.** What `sources.yaml` says about a page (its `page_qualifier` sentence, a model
  card's `models`) must still be on it, or the source fails as a layout change. The source's entries, as the
  merge leaves them, must pass the validator against the new page, or the source fails with "entries that
  would not validate" (for example, a new model the page lists as deprecated with "To be announced"). Last,
  the registry as it would be committed goes through the same check as `Validate registry`; if that fails,
  nothing is written, the errors go into the provider's issue, and the job fails.
- **Failures.** A fetch error, a layout change (the parser's headers are gone, there are no rows, or the
  Gemini API HTML page marks no row as shut down), a parse failure (also a table with some of a parser's
  columns but not all of them, or a model ID without code formatting), an ungrounded row, a model no longer
  on the page, or entries that would not validate fail that source: its snapshot and entries stay as they
  are, the provider's other sources still apply, and the provider's issue (label `updater-failure`) says why.
  The issue is updated on every failing run and closed when the provider succeeds again. The updater only
  edits and closes issues its own App opened.
- **Page text** in PRs and issues (excerpts, IDs, parser messages, the snapshot diff) is shown in code spans
  and code blocks, so a page can't add links, images, mentions or issue references.
- **Freshness.** Once a source's newest `verified_on` is 14 days old, the updater moves the `verified_on` of
  its unchanged entries to today, so the scanner's staleness warning (30 days) means the updater really
  stopped. `generated_at` changes only when the models do, and is midnight UTC of that day.
- **DeepSeek** is free text: the updater proposes nothing from
  it and lists IDs it finds that aren't in the registry in the DeepSeek issue. When the change log rewords a
  sentence a DeepSeek entry quotes, the source fails until the entry's excerpt is updated by hand.
- **List-models check.** A second job compares the providers' list-models APIs with the registry and opens one
  issue per provider for differences. It never changes the registry. Each provider is skipped unless its
  secret is set (OpenRouter needs none).

To fix a parser after a layout change: save the new page as `test/fixtures/pages/<parser>/current.*`, update
`updater/extract/<parser>.ts` until `test/updater/registry-pages.test.ts` and the parser's own test pass,
then run `npm run registry:update -- --provider <provider>` and open the PR yourself (or wait for the next run).

Setting up the updater's GitHub App, running it by hand, and recovering a disabled schedule are in
[maintainers.md](maintainers.md#registry-updater).

## Known gaps

- **DeepSeek** publishes a change log in free text, so an entry has dates only where a sentence on that page
  states them. Some of its entries are `unverified`, and new
  DeepSeek models are added by hand.
- **Azure rows without a version** (Meta, some partner models, and every maker but Azure OpenAI on the
  retired-models page) aren't in the registry, because Azure deployments are matched on name and version.
  So `Mistral-large` version 1 follows the retirement schedule, which lists it as GA, although the
  retired-models page lists `Mistral-large`, without a version, as retired.
- **Pinned OpenAI snapshots** behind a deprecated alias or family aren't listed on OpenAI's page, so they
  aren't in the registry and aren't matched: `gpt-5.1` is, `gpt-5.1-2025-11-13` isn't.
- **Models dropped from the providers' current pages** are covered only where another official page still
  dates them, as the Gemini API release notes do for `gemini-1.5-flash` and Azure's retired-models page for
  `gpt-35-turbo` 0613. Still out: `gemini-pro`; `gemini-2.5-pro-exp-03-25`, whose shutdown note isn't the
  first under its date; Bedrock's `anthropic.claude-v2`; Bedrock's Titan Image Generator v2, whose model
  card is gone; and Bedrock's Llama 3.1 405B, whose card gives "Model EOL date: Legacy: July 7, 2026".
- **Bedrock and Vertex model pages** are one source per model, so the updater only finds a new model once its
  page is added to `registry/sources.yaml`. The cards of Bedrock models launched before 2026-09-07 are
  sources only when they say Legacy with a `Model EOL date`, so the other older models' "EOL no sooner
  than" dates aren't in the registry.
- **Anthropic aliases** that no live Anthropic page documents, such as `claude-3-7-sonnet-latest`,
  `claude-3-5-sonnet-latest` and `claude-opus-4-1`, aren't in the registry, so code that uses them isn't
  matched.
- **Mistral `*-latest` names** follow the model file that lists them. When Mistral points a retired one at
  a newer model, its entry stays `retired` until a maintainer updates it, because the updater never takes an
  entry out of `retired`.
- **Managed agents** aren't models, and are out of scope.
