<!-- sunset:pr-comment -->
### Sunset: no new findings, but 3 existing findings fail this check

This pull request adds no deprecated, retiring or retired models.

#### Why this check fails: 3 existing findings at or above `fail-on: warning`

These were in the code before this pull request. Fix or suppress them, or set `fail-scope: new` in .sunset.yml to fail only on findings a pull request adds.

| Level | Where | Details |
|---|---|---|
| **error** | [`infra/bedrock.py:1`](https://github.com/o/r/blob/abc123/infra/bedrock.py#L1) | us-gov.anthropic.claude-fixture-1-20990101-v1:0 (bedrock us-gov-west-1; Bedrock us-gov. inference profile) retires on 2099-01-20, in 19 days. Other dates: bedrock other regions: 2099-06-01. |
| **error** | [`infra/main.tf:4`](https://github.com/o/r/blob/abc123/infra/main.tf#L4) | gpt-fixture-4o (azure-openai 2099-01-05; Azure deployment (terraform)) retires on 2099-01-25, in 24 days. |
| warning | [`infra/bedrock.py:2`](https://github.com/o/r/blob/abc123/infra/bedrock.py#L2) | anthropic.claude-fixture-opus-9 (bedrock) retires on 2099-02-20, in 50 days. |

See the [job summary](https://github.com/o/r/actions/runs/1).

<sub>"New" means this pull request adds it; existing findings were in the code before. sunset 1.2.3 · bundled registry v1 (27 entries, last checked 2099-01-01, today) · dates as of 2099-01-01</sub>
