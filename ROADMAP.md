# Roadmap

Ideas for after v1, in rough priority order. Nothing here is committed to a date. To discuss one, open an
issue.

## Next

- **Drop-in replacement PRs.** Open a pull request that swaps a model ID for its replacement, but only when
  the provider calls the replacement a drop-in, the match is an exact literal in code, and the replacement
  is on the same platform.
- **OpenRouter as a platform**. v1 gives an OpenRouter slug
  the upstream model's dates only when the slug is `<vendor>/<first-party ID>`. OpenRouter documents its own
  `expiration_date` per model, which would cover every slug, including Anthropic's dotted ones
  (`anthropic/claude-sonnet-4.5`).
- **A single executable.** A `sunset` binary that doesn't need Node.js, built with Node's single
  executable applications: `node --build-sea` exists from Node 25.5, and ESM entry points work from 25.7.
  The feature is still marked "active development", so this waits until it is stable in an LTS line.

## Later

- **Alias drift warnings.** Warn when a floating alias (`gpt-4o`, `*-latest`) has been moved to a new
  snapshot since the last scan.
- **Deprecated APIs, parameters and SDK versions**, not only model IDs.
- **Cost difference** between the current model and its replacement.
- **Multi-repository dashboards** for an organization.
- **An LLM extractor in the updater**, for pages
  without a table, behind the same grounding check as the parsers, so it can only propose values that are
  word for word on the page.

## Exploring

- **Eval-backed migration PRs.** Run the old model and its replacement on the repository's own evals, and
  open a pull request only if quality holds.
- **Prompt adaptation** for the new model.

## Not planned

- Telemetry, or sending code or findings anywhere but your own repository. The scan stays local.
- An LLM in the scan itself.
