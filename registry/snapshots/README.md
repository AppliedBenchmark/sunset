# Page snapshots

Each `<provider>/<slug>.txt` file is the normalized text of a provider's public documentation: a page, or the
files behind it in the provider's public docs repository. It was fetched at the time recorded in the
`.meta.json` file next to it (`fetched_at`). The snapshots are kept so that CI can check that every
`source_excerpt` in `registry/models.yaml` is quoted word for word from its page.

The pages belong to their publishers and aren't covered by this repository's Apache-2.0 license. The
original of each is at the URLs in its `.meta.json` (`urls`); `registry/sources.yaml` names the page a
person would read.

`npm run registry:snapshot` refreshes them, and [docs/registry.md](../../docs/registry.md#sources-and-snapshots)
explains how the text is normalized.
