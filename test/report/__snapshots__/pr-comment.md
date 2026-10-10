<!-- sunset:pr-comment -->
### Sunset: 7 new findings (4 errors)

| Level | Where | Details |
|---|---|---|
| **error** | [`src/client.ts:2`](https://github.com/o/r/blob/abc123/src/client.ts#L2) | gpt-fixture-retired (openai) was retired on 2098-06-30. Recommended replacement: gpt-fixture-4o (openai). |
| **error** | [`src/client.ts:3`](https://github.com/o/r/blob/abc123/src/client.ts#L3) | gpt-fixture-1-2099-01-10 (openai) retires on 2099-01-10, in 9 days. |
| **error** | [`src/client.ts:10`](https://github.com/o/r/blob/abc123/src/client.ts#L10) | gpt-fixture-retired (openai) was retired on 2098-06-30. Recommended replacement: gpt-fixture-4o (openai). |
| **error** | [`src/client.ts:11`](https://github.com/o/r/blob/abc123/src/client.ts#L11) | gpt-fixture-retired (openai) was retired on 2098-06-30. Recommended replacement: gpt-fixture-4o (openai). |
| warning | [`src/client.ts:4`](https://github.com/o/r/blob/abc123/src/client.ts#L4) | gpt-fixture-2-2099-02-15 (openai) retires on 2099-02-15, in 45 days. |
| notice | [`src/client.ts:6`](https://github.com/o/r/blob/abc123/src/client.ts#L6) | gpt-fixture-unverified (openai) is in the registry, but its lifecycle isn't verified from an official source yet. |
| notice | [`src/client.ts:10`](https://github.com/o/r/blob/abc123/src/client.ts#L10) | Suppression "sunset-ignore until=2098-12-31" expired on 2098-12-31; what it covered is reported again. Remove it or extend the date. |

<details>
<summary>1 new unresolved reference</summary>

The model here is chosen at run time, so Sunset can't check it.

| Where | Details |
|---|---|
| [`src/client.ts:8`](https://github.com/o/r/blob/abc123/src/client.ts#L8) | `model` comes from the environment (process.env.MODEL). Sunset can't check it; make sure the model it names isn't deprecated or retiring. |

</details>

See the [job summary](https://github.com/o/r/actions/runs/1).

<sub>Only references this pull request adds are listed. sunset 1.2.3 · bundled registry v1 (27 entries, last checked 2099-01-01, today) · dates as of 2099-01-01</sub>
