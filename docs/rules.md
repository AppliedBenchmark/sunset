# Rules

Every result Sunset reports has one of these rule IDs. The IDs are stable: they appear in SARIF, the
JSON report and the CLI's text report, and they won't be renamed within a major version. Annotations are
titled with the rule's name and what it found instead, such as `Retired model: <model ID>`.

The level depends on the date, not only on the rule. Days are whole UTC days from the day of the scan.

| Rule | Level | Reported when |
|---|---|---|
| [`sunset/model-retired`](#model-retired) | error | The model is retired. |
| [`sunset/model-retiring`](#model-retiring) | error under 30 days, otherwise warning under 90 days | The model has an announced retirement date. |
| [`sunset/model-deprecated`](#model-deprecated) | notice | The model is deprecated; retirement is 90 days or more away, or not announced. |
| [`sunset/model-unverified`](#model-unverified) | notice | The model's lifecycle isn't verified from an official source. |
| [`sunset/model-legacy`](#model-legacy) | notice, only with `legacy` enabled | The provider lists the model as legacy. |
| [`sunset/model-reference-unresolved`](#model-reference-unresolved) | notice | The model is chosen at run time. |
| [`sunset/model-id-unknown`](#model-id-unknown) | notice | A model ID no provider lists, with a known ID's parts in another order. |
| [`sunset/suppression-expired`](#suppression-expired) | notice | A suppression passed its `until` date. |

Model IDs in documentation files are never reported under these rules. They are listed as "Mentioned in
docs" in the job summary and the JSON report, with the level they would have in code.

## model-retired

The code references a model whose retirement date has passed, or that its provider lists as retired.
Requests that use it fail or are served by another model.

**What to do:** move to the recommended replacement, if the message names one, and test the change:
replacements are not always drop-in. If the reference is intentional, suppress it with `sunset-ignore` and a
`reason`.

## model-retiring

The model has an announced retirement date. The finding is an error under 30 days and a warning under 90
days. A date the provider gives as "no earlier than" is the earliest it can happen. For a model that is still
`active`, such a date is at most a warning, also once it has passed ("may be retired at any time").

When an ID is served on several platforms and only some of them retire it soon, the finding is a warning
that names the platforms where it isn't an error. An ID after a library prefix that can name either of two
platforms is judged on both the same way: `google:` calls the Gemini API in promptfoo and Vertex AI in
aisuite. A model router's slug is a warning at most too: OpenRouter and the Vercel AI Gateway may still send
a model its first-party provider retired to another provider. `<vendor>/<id>` is a router's slug after the
router's own segment (`openrouter/deepseek/deepseek-chat`), or in a file that uses the router (it mentions
OpenRouter, or uses the AI SDK or the Gateway) and writes no such segment itself. Elsewhere it is LiteLLM's
way to call the vendor's own API (`deepseek/deepseek-chat`), which gets the vendor's dates in full.

**What to do:** plan the migration before the date in the message. Use `sunset-ignore until=YYYY-MM-DD` to
defer the finding without losing track of it.

## model-deprecated

The provider has deprecated the model, but its retirement is 90 days or more away, or not yet announced.

**What to do:** nothing yet. Plan a move to the recommended replacement; the finding becomes a warning 90
days before retirement.

## model-unverified

The model is in Sunset's registry, but its lifecycle couldn't be tied to an official source yet, so Sunset
can't say whether it is at risk.

**What to do:** check the provider's documentation for the model's status.

## model-legacy

The provider lists the model as legacy but has announced no deprecation. Reported only with `legacy: true` in
the config.

**What to do:** consider moving to a current model before it is deprecated.

## model-reference-unresolved

A model parameter is set from the environment, a variable or an interpolated string; a Bedrock ARN names an
application inference profile or a provisioned model, which hides the model ID; an Azure deployment has no
model version (Azure then picks its default version at deployment time), or names a model or version that
isn't in the registry; or the code calls an Azure deployment by name (`azure/<name>` in LiteLLM,
`/openai/deployments/<name>/` in a URL), whose model version is set where the deployment is created. The
notice lists the dates of the model's known Azure versions where there are any. Sunset reports these
instead of skipping them silently. They never fail a run.

A call such as `openai('gpt-4o')` isn't one of these: the literal in it is checked like any other.

**What to do:** make sure the model that ends up here isn't deprecated or retiring. Suppress the notice
with `sunset-ignore` once you have checked it, or with an `ignore` rule in `.sunset.yml` for a file without
comments, such as JSON.

## model-id-unknown

The string isn't in the registry, but it has the same words and numbers as a model ID that is, in another
order: `claude-haiku-3-5` for `claude-3-5-haiku`. Requests with it will most likely fail. Only reorderings
are reported. Other IDs that aren't in the registry are listed in the inventory of the JSON report, since a
new model may not be in the registry yet.

**What to do:** check the provider's model list and use the exact ID. If the ID is right (a custom name on
a gateway, say), suppress the notice with `sunset-ignore`.

## suppression-expired

An inline `sunset-ignore` directive has an `until` date that has passed, so what it covered is reported
again.

**What to do:** remove the directive, or extend its `until` date if the migration is still pending.

## Problems with Sunset's input

These aren't rules, but they are reported as notices too: in SARIF as tool configuration notifications, in
the job summary under "Directive and config problems".

- `malformed-directive`: a `sunset-ignore` comment Sunset can't parse. It doesn't apply.
- `expired-config-ignore`: an `ignore` entry in `.sunset.yml` whose `until` date has passed. It no longer
  applies.
