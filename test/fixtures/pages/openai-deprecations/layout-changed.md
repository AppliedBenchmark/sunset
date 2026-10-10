# Deprecations

> For the complete documentation index, see [llms.txt](/llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

## Upcoming deprecations

Upcoming deprecations are listed below, with the most recent announcements at the top.

### 2026-10-01: GPT-5.3-Codex, GPT-5.1, GPT-5.4-Nano

The following models are deprecated and will be removed from the API on April 1, 2027, with six months' notice. Migrate to the recommended replacements before the shutdown date.

| Retirement    | Model / system  | Recommended replacement |
| ------------- | --------------- | ----------------------- |
| Apr 1, 2027   | `gpt-5.3-codex` | `gpt-6-sol`             |
| Apr 1, 2027   | `gpt-5.4-nano`  | `gpt-6-luna`            |
| Apr 1, 2027   | `gpt-5.1`       | `gpt-6-sol`             |

## Past deprecations

Past deprecations are listed below, with the most recent announcements at the top.

### 2026-09-11: GPT-5.4-Cyber

The `gpt-5.4-cyber` model is deprecated and will be removed from the API on October 1, 2026. Migrate to the most capable cyber model available to you before the shutdown date.

| Retirement    | Model / system  | Recommended replacement                        |
| ------------- | --------------- | ---------------------------------------------- |
| Oct 1, 2026   | `gpt-5.4-cyber` | The most capable cyber model available to you. |

### 2026-05-08: `gpt-5.2-chat-latest` and `gpt-5.3-chat-latest` model snapshots

On May 8th, 2026, we notified developers using `gpt-5.2-chat-latest` and `gpt-5.3-chat-latest` model snapshots of their deprecation and removal from the API.

| Retirement    | Model / system        | Recommended replacement |
| ------------- | --------------------- | ----------------------- |
| Aug 10, 2026  | `gpt-5.2-chat-latest` | `gpt-5.6-sol`           |
| Aug 10, 2026  | `gpt-5.3-chat-latest` | `gpt-5.6-sol`           |

### 2026-04-22: Legacy GPT model snapshots

To improve reliability and make it easier for developers to choose the right models, we are deprecating a set of older OpenAI models. Access to these models will be shut down on the dates below.

| Retirement       | Model snapshot                                                         | Substitute model                                  |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| October 23, 2026 | `gpt-3.5-turbo-0125` \| `gpt-3.5-turbo`, `gpt-3.5-turbo-completions`   | `gpt-5.6-terra`                                   |
| October 23, 2026 | `gpt-4-0613` \| `gpt-4`, `gpt-4-0613-completions`, `gpt-4-completions` | `gpt-5.6-sol`                                     |
| October 23, 2026 | `gpt-4-1106-preview`                                                   | `gpt-5.6-sol`                                     |
| October 23, 2026 | `gpt-4-turbo` \| `gpt-4-turbo-2024-04-09`, `gpt-4-turbo-completions`   | `gpt-5.6-sol`                                     |
| October 23, 2026 | `gpt-4.1-nano` \| `gpt-4.1-nano-2025-04-14`                            | `gpt-5.6-luna`                                    |
| October 23, 2026 | `gpt-4o-2024-05-13`                                                    | `gpt-5.6-sol`                                     |
| October 23, 2026 | `gpt-image-1`                                                          | `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare` |
| October 23, 2026 | `o1-2024-12-17` \| `o1`                                                | `gpt-5.6-sol`                                     |
| October 23, 2026 | `o1-pro-2025-03-19` \| `o1-pro`                                        | `gpt-5.6-sol` (`reasoning.mode: pro`)             |
| October 23, 2026 | `o3-mini-2025-01-31` \| `o3-mini`                                      | `gpt-5.6-sol`                                     |
| October 23, 2026 | `ft-o4-mini-2025-04-16`                                                | `gpt-5.6-terra`                                   |
| October 23, 2026 | `o4-mini-2025-04-16` \| `o4-mini`                                      | `gpt-5.6-terra`                                   |

We are also removing fine-tuned versions as below:

| Retirement       | Model snapshot               | Recommended replacement base model |
| ---------------- | ---------------------------- | ---------------------------------- |
| October 23, 2026 | `ft-gpt-3.5-turbo`           | `gpt-5.6-terra`                    |
| October 23, 2026 | `ft-gpt-4`                   | `gpt-5.6-sol`                      |
| October 23, 2026 | `ft-gpt-4.1-nano-2025-04-14` | `gpt-5.6-luna`                     |
| October 23, 2026 | `ft-babbage-002`             | `gpt-5.6-terra`                    |
| October 23, 2026 | `ft-davinci-002`             | `gpt-5.6-terra`                    |

### 2026-03-24: Sora 2 video generation models and Videos API

On March 24th, 2026, we notified developers using the Videos API and Sora 2 video generation model aliases and snapshots of their deprecation and removal from the API on September 24, 2026.

| Retirement    | Model / system          | Recommended replacement |
| ------------- | ----------------------- | ----------------------- |
| 2026-09-24    | Videos API              | ---                     |
| 2026-09-24    | `sora-2`                | ---                     |
| 2026-09-24    | `sora-2-pro`            | ---                     |
| 2026-09-24    | `sora-2-2025-10-06`     | ---                     |
| 2026-09-24    | `sora-2-2025-12-08`     | ---                     |
| 2026-09-24    | `sora-2-pro-2025-10-06` | ---                     |

### 2025-09-26: Legacy GPT model snapshots

To improve reliability and make it easier for developers to choose the right models, we are deprecating a set of older OpenAI models with declining usage over the next six to twelve months. Access to these models will be shut down on the dates below.

| Retirement    | Model / system           | Recommended replacement |
| ------------- | ------------------------ | ----------------------- |
| 2026-09-28    | `gpt-3.5-turbo-instruct` | `gpt-5.6-terra`         |
| 2026-09-28    | `babbage-002`            | `gpt-5.6-terra`         |
| 2026-09-28    | `davinci-002`            | `gpt-5.6-terra`         |
| 2026-09-28    | `gpt-3.5-turbo-1106`     | `gpt-5.6-terra`         |

### 2025-09-26: Legacy GPT model snapshots (March 2026 shutdown)

To improve reliability and make it easier for developers to choose the right models, we deprecated a set of older OpenAI models with declining usage. Access to these models was shut down on March 26, 2026.

| Retirement    | Model / system                                                                                                             | Recommended replacement |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 2026‑03‑26    | `gpt-4-0314`                                                                                                               | `gpt-5` or `gpt-4.1*`   |
| 2026‑03‑26    | `gpt-4-1106-preview`                                                                                                       | `gpt-5` or `gpt-4.1*`   |
| 2026‑03‑26    | `gpt-4-0125-preview` (including `gpt-4-turbo-preview` and `gpt-4-turbo-preview-completions`, which point to this snapshot) | `gpt-5` or `gpt-4.1*`   |

\*For tasks that are especially latency sensitive and don't require reasoning

### 2024-08-29: Fine-tuning training on babbage-002 and davinci-002 models

On August 29th, 2024, we notified developers fine-tuning `babbage-002` and `davinci-002` that new fine-tuning training runs on these models will no longer be supported starting October 28, 2024.

Fine-tuned models created from these base models are not affected by this deprecation, but you will no longer be able to create new fine-tuned versions with these models.

| Retirement    | Model / system                            | Recommended replacement |
| ------------- | ----------------------------------------- | ----------------------- |
| 2024-10-28    | New fine-tuning training on `babbage-002` | `gpt-4o-mini`           |
| 2024-10-28    | New fine-tuning training on `davinci-002` | `gpt-4o-mini`           |

### 2023-08-22: Fine-tunes endpoint

On August 22nd, 2023, we [announced](https://openai.com/blog/gpt-3-5-turbo-fine-tuning-and-api-updates) the new fine-tuning API (`/v1/fine_tuning/jobs`) and that the original `/v1/fine-tunes` API along with legacy models (including those fine-tuned with the `/v1/fine-tunes` API) will be shut down on January 04, 2024. This means that models fine-tuned using the `/v1/fine-tunes` API will no longer be accessible and you would have to fine-tune new models with the updated endpoint and associated base models.

#### Fine-tunes endpoint

| Retirement    | System           | Recommended replacement |
| ------------- | ---------------- | ----------------------- |
| 2024-01-04    | `/v1/fine-tunes` | `/v1/fine_tuning/jobs`  |

#### Edit models & endpoint

| Retirement    | Model / system          | Recommended replacement |
| ------------- | ----------------------- | ----------------------- |
| 2024-01-04    | `text-davinci-edit-001` | `gpt-4o`                |
| 2024-01-04    | `code-davinci-edit-001` | `gpt-4o`                |
| 2024-01-04    | `/v1/edits`             | `/v1/chat/completions`  |

### 2023-06-13: Updated chat models

On June 13, 2023, we announced new chat model versions in the [Function calling and other API updates](https://openai.com/blog/function-calling-and-other-api-updates) blog post. The three original versions will be retired in June 2024 at the earliest. As of January 10, 2024, only existing users of these models will be able to continue using them.

| Retirement             | Legacy model | Legacy model price                                   | Recommended replacement |
| ---------------------- | ------------ | ---------------------------------------------------- | ----------------------- |
| at earliest 2024-06-13 | `gpt-4-0314` | $30.00 / 1M input tokens + $60.00 / 1M output tokens | `gpt-4o`                |

| Retirement    | Deprecated model     | Deprecated model price                                | Recommended replacement |
| ------------- | -------------------- | ----------------------------------------------------- | ----------------------- |
| 2024-09-13    | `gpt-3.5-turbo-0301` | $15.00 / 1M input tokens + $20.00 / 1M output tokens  | `gpt-3.5-turbo`         |
| 2025-06-06    | `gpt-4-32k-0314`     | $60.00 / 1M input tokens + $120.00 / 1M output tokens | `gpt-4o`                |

