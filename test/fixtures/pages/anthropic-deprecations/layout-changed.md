---
title: Model deprecations
url: https://platform.claude.com/docs/en/about-claude/model-deprecations
description: See which Claude models are active, deprecated, or retired, and find retirement dates and recommended replacements for models and API parameters.
---

As safer and more capable models launch, Anthropic regularly retires older ones. Applications relying on Anthropic models may need occasional updates to keep working. Impacted customers will always be notified by email and in the documentation.

This page lists all API deprecations, along with recommended replacements.

## Model status

Current and recently retired models are listed in the following table with their status:

| Model | Lifecycle | Deprecated         | Tentative retirement date          |
| :------------------------- | :------------ | :----------------- | :--------------------------------- |
| claude-fable-5-1           | Active        | N/A                | Not sooner than September 1, 2027  |
| claude-mythos-5-1          | Active        | N/A                | Not sooner than September 1, 2027  |
| claude-fable-5             | Active        | N/A                | Not sooner than June 9, 2027       |
| claude-mythos-5            | Active        | N/A                | Not sooner than June 9, 2027       |
| claude-mythos-preview      | Deprecated    | June 9, 2026       | To be announced                    |
| claude-opus-5-5            | Active        | N/A                | Not sooner than September 22, 2027 |
| claude-opus-5              | Active        | N/A                | Not sooner than July 24, 2027      |
| claude-opus-4-8            | Active        | N/A                | Not sooner than May 28, 2027       |
| claude-opus-4-7            | Active        | N/A                | Not sooner than April 16, 2027     |
| claude-opus-4-6            | Active        | N/A                | Not sooner than February 5, 2027   |
| claude-opus-4-5-20251101   | Active        | N/A                | Not sooner than November 24, 2026  |
| claude-opus-4-1-20250805   | Retired       | June 5, 2026       | August 5, 2026                     |
| claude-opus-4-20250514     | Retired       | April 14, 2026     | June 15, 2026                      |
| claude-sonnet-5-5          | Active        | N/A                | Not sooner than September 28, 2027 |
| claude-sonnet-5            | Active        | N/A                | Not sooner than June 30, 2027      |
| claude-sonnet-4-6          | Active        | N/A                | Not sooner than February 17, 2027  |
| claude-sonnet-4-5-20250929 | Deprecated    | September 30, 2026 | November 30, 2026                  |
| claude-sonnet-4-20250514   | Retired       | April 14, 2026     | June 15, 2026                      |
| claude-3-7-sonnet-20250219 | Retired       | October 28, 2025   | February 19, 2026                  |
| claude-haiku-5-5           | Active        | N/A                | Not sooner than October 7, 2027    |
| claude-haiku-4-5-20251001  | Active        | N/A                | Not sooner than October 15, 2026   |
| claude-3-5-haiku-20241022  | Retired       | December 19, 2025  | February 19, 2026                  |
| claude-3-haiku-20240307    | Retired       | February 19, 2026  | April 20, 2026                     |

## Deprecation history

All deprecations are listed in the following sections, with the most recent announcements first.

### 2026-09-30: Claude Sonnet 4.5 model

On September 30, 2026, Anthropic notified developers using Claude Sonnet 4.5 of its upcoming retirement on the Claude API.

| Retirement date   | Deprecated model             | Recommended replacement |
| ----------------- | ---------------------------- | ----------------------- |
| November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5`     |

### 2026-06-05: Claude Opus 4.1 model

<Note>
  This model was retired August 5, 2026.
