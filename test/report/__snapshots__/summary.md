## Sunset

**6 errors**, **2 warnings**, 2 notices in 4 files · 1 unresolved reference · 1 mention in docs · 2 suppressed

### Findings

| Severity | Model | Rule | Retirement | Replacement | Where |
|---|---|---|---|---|---|
| **error** | `gpt-fixture-retired` (openai) | Retired model | 2098-06-30 (185 days ago) | `gpt-fixture-4o` | [`src/client.ts:2`](https://github.com/o/r/blob/abc123/src/client.ts#L2), [`src/client.ts:10`](https://github.com/o/r/blob/abc123/src/client.ts#L10), [`src/client.ts:11`](https://github.com/o/r/blob/abc123/src/client.ts#L11) |
| **error** | `gpt-fixture-1-2099-01-10` (openai) | Retiring model | 2099-01-10 (in 9 days) |  | [`src/client.ts:3`](https://github.com/o/r/blob/abc123/src/client.ts#L3) |
| **error** | `anthropic.claude-fixture-1-20990101-v1:0` (bedrock)<br>written as `us-gov.anthropic.claude-fixture-1-20990101-v1:0` | Retiring model | 2099-01-20 (in 19 days) |  | [`infra/bedrock.py:1`](https://github.com/o/r/blob/abc123/infra/bedrock.py#L1) |
| **error** | `gpt-fixture-4o` (azure-openai 2099-01-05) | Retiring model | 2099-01-25 (in 24 days) |  | [`infra/main.tf:4`](https://github.com/o/r/blob/abc123/infra/main.tf#L4) |
| warning | `gpt-fixture-2-2099-02-15` (openai) | Retiring model | 2099-02-15 (in 45 days) |  | [`src/client.ts:4`](https://github.com/o/r/blob/abc123/src/client.ts#L4) |
| warning | `anthropic.claude-fixture-opus-9` (bedrock) | Retiring model | 2099-02-20 (in 50 days) |  | [`infra/bedrock.py:2`](https://github.com/o/r/blob/abc123/infra/bedrock.py#L2) |
| notice | `gpt-fixture-unverified` (openai) | Unverified model |  |  | [`src/client.ts:6`](https://github.com/o/r/blob/abc123/src/client.ts#L6) |
| notice | `sunset-ignore until=2098-12-31` | Expired suppression |  |  | [`src/client.ts:10`](https://github.com/o/r/blob/abc123/src/client.ts#L10) |

<details>
<summary>Directive and config problems (2)</summary>

These suppressions are malformed or expired, so they no longer apply.

| Where | Problem |
|---|---|
| `src/client.ts:11` | Malformed "sunset-ignore": "soon" is not a valid date (YYYY-MM-DD) |
| _config_ | Config ignore #1 (expired ignore) expired on 2098-06-01; it no longer applies. |

</details>

<details>
<summary>Unresolved references (1)</summary>

The model here is chosen at run time, so Sunset can't check it.

| Where | Details |
|---|---|
| [`src/client.ts:8`](https://github.com/o/r/blob/abc123/src/client.ts#L8) | `model` comes from the environment (process.env.MODEL). Sunset can't check it; make sure the model it names isn't deprecated or retiring. |

</details>

<details>
<summary>Mentioned in docs (1)</summary>

Model IDs in documentation never fail a run. The level is what they'd be in code.

| Where | Model | Level in code | Details |
|---|---|---|---|
| [`docs/migration.md:1`](https://github.com/o/r/blob/abc123/docs/migration.md#L1) | `gpt-fixture-retired` (openai) | error | gpt-fixture-retired (openai) was retired on 2098-06-30. Recommended replacement: gpt-fixture-4o (openai). |

</details>

<details>
<summary>Not in the registry (1)</summary>

These look like model IDs, but Sunset's registry doesn't know them, so their lifecycle is unknown.

| Model | Where |
|---|---|
| `gpt-9-turbo` | [`src/client.ts:7`](https://github.com/o/r/blob/abc123/src/client.ts#L7) |

</details>

<details>
<summary>Suppressed (2)</summary>

Findings hidden by an inline directive or a config ignore.

| Where | Model | Rule | By | Until | Reason |
|---|---|---|---|---|---|
| [`src/client.ts:5`](https://github.com/o/r/blob/abc123/src/client.ts#L5) | `gpt-fixture-3` | Deprecated model | config | 2099-06-30 | tracked in #42 |
| [`src/client.ts:9`](https://github.com/o/r/blob/abc123/src/client.ts#L9) | `gpt-fixture-retired` | Retired model | inline |  | pinned for replay tests |

</details>

<sub>sunset 1.2.3 · bundled registry v1 (27 entries, last checked 2099-01-01, today) · dates as of 2099-01-01</sub>
