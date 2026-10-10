# Limitations

What Sunset checks, what it doesn't, and how it reads each kind of file. The README lists the main points.

## Only IDs in the registry are checked

Any other ID produces no finding. If it looks like a model ID of a known family, the JSON report lists it
under `inventory`, and an ID with the words of a known ID in another order (`claude-haiku-3-5`) is reported
as `model-id-unknown`.

## Models chosen at run time

A model chosen from an environment variable, a variable or an interpolated string can't be checked. It is
reported as an unresolved reference, which never fails a run.

## Azure deployments

Azure deployments are matched by model name and version in Terraform (`azurerm_cognitive_deployment`), Bicep
and ARM templates, and `az cognitiveservices account deployment create` commands. Application code calls a
deployment by a name you chose, which doesn't say what model version it runs: a name that is a first-party
model ID is checked as that ID, a model's name in `azure/<name>` or `/openai/deployments/<name>/` is reported
as an unresolved reference (see [Paths, URLs and sentences](#paths-urls-and-sentences)), and other names
aren't checked.

## File types

Sunset reads JavaScript and TypeScript, Python, Java and Groovy, Kotlin, C#, Go, Rust, Swift, C and C++, PHP,
Scala, Dart, Ruby, Lua and R; shell scripts, PowerShell, Dockerfiles, Makefiles and `.env` files; Bicep,
Terraform and HCL; YAML, JSON and JSON Lines, TOML, INI and `.properties` files; HTML, Vue, Svelte and Astro
files; Jupyter notebooks; and documentation. It skips other files, and files over 1 MiB (`max-file-size`).

## Notebooks

Code cells are read as code in the notebook's kernel language, so comments and `sunset-ignore` directives
work there. In a Python notebook, IPython's shell commands (`!python eval.py gpt-4`) and line magics (`%env`)
are read as command lines, and the rest of a cell after a cell magic in the language that magic runs:
`%%bash` as shell, `%%writefile config.yaml` as YAML. Markdown cells count as documentation, and outputs
aren't read. `max-file-size` applies to a notebook's code, not to its outputs.

## Documentation

Documentation (`*.md`, `*.mdx`, `*.rst`, `*.txt`, `docs/**`) is read for mentions only, which never fail a
run.

## OpenRouter and the Vercel AI Gateway

Only slugs of the form `<vendor>/<first-party ID>` are checked, with the upstream model's dates and at most
as a warning: the router may still send a retired model to another provider. Other slugs, such as
OpenRouter's dotted Anthropic ones (`anthropic/claude-sonnet-4.5`), aren't checked.

`<vendor>/<id>` is a router's slug after the router's own segment (`openrouter/`, LiteLLM's
`vercel_ai_gateway/`), or in a file that uses the router and writes no such segment itself: one that
mentions OpenRouter, or else one that imports the AI SDK (`from 'ai'`) or mentions `@ai-sdk/gateway`,
`ai-gateway.vercel.sh` or `AI_GATEWAY_API_KEY`. In such a file, a call to a vendor's own API written the
same way is a warning too. Elsewhere, `<vendor>/<id>` is LiteLLM's way to call the vendor's own API, which
gets the vendor's dates in full.

## Paths, URLs and sentences

An ID in a file path or a URL, or in a sentence inside a string, isn't checked unless it is the value of a
model key or a command-line flag there (`"model": "gpt-4"`, `--model gpt-4`, `-m gpt-4`), or a default in a
template expression or a placeholder (`{{ .Values.model | default "gpt-4" }}`,
`${{ inputs.model || 'gpt-4' }}`, `${MODEL:-gpt-4}`).

A string whose words are all model IDs, separated by spaces, line breaks or commas, is a list rather than a
sentence, so its IDs are checked (`FALLBACK_MODELS="gpt-4 gpt-4o"`); a single-word ID there still needs a
model key.

Forms that name a model are still read: Bedrock ARNs, Vertex resource paths, router slugs, and library
prefixes such as LiteLLM's `bedrock/` or LangChain's `anthropic:`, which are judged by the platform they name
([registry/formats.yaml](../registry/formats.yaml) lists them). An unknown prefix isn't checked; the key of a
placeholder isn't a prefix, so Spring's `${spring.ai.openai.chat.options.model:gpt-4}` is checked. An ID
followed by `*` is a glob (`openai/gpt-4*`), so it isn't checked. An Azure deployment named after a model
(`azure/gpt-4o`, `/openai/deployments/gpt-4o/`) is reported as an unresolved reference, with the dates of
that model's Azure versions.

## Command lines

Command lines are read word by word, as in a shell script, so a model ID passed to a command is checked even
without a flag before it: in shell files; in YAML values under keys that hold commands, such as `run`,
`script`, `command`, `entrypoint` and `args`; in Terraform heredocs that are scripts (`user_data`, a
provisioner's `command`, or one that starts with `#!`); and in a notebook's `!` lines and shell cells. A
command in a string elsewhere, such as `os.system("…")`, is a sentence.

## Words that are also model IDs

OpenAI's `ada`, `babbage`, `curie` and `davinci`, and Vertex's `imagetext`, count only as the value of a
model key or flag, so a list of languages or units doesn't fail a run.

## DeepSeek

DeepSeek publishes a free-text change log, so its coverage is best effort: some of its entries have no dates
(`model-unverified`), and new DeepSeek models are added by hand.

## Tests and data files

Tests and data files are scanned like code, and test fixtures often name retired models on purpose. To leave
them out:

```yaml
exclude:
  - '**/{test,tests,__tests__,spec,specs,testdata,fixtures}/**'
  - '**/*.{test,spec}.*'
  - '**/{data,datasets}/**'
```
