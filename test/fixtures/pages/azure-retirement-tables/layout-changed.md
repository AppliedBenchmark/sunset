---
title: include file
description: include file
author: msakande
ms.author: mopeakande
ms.reviewer: josander
reviewer: johnrsanders
ms.service: microsoft-foundry
ms.subservice: foundry-openai
ms.topic: include
ms.date: 10/05/2026
ms.custom: include, classic-and-new, doc-kit-assisted
ai-usage: ai-assisted
---

This article lists the retirement schedule for Foundry Models, including the current lifecycle stage, retirement date, and suggested replacement. Use it to plan migrations before a model is deprecated or retired. For details on what each lifecycle stage means and how notifications work, see [Microsoft Foundry Models lifecycle and support policy](../concepts/model-retirements.md).

The **Replacement** column identifies Microsoft's recommended replacement and, where supported, the target for automatic upgrades at retirement. You don't need to wait for a replacement to be listed before evaluating or manually migrating to another compatible model. Evaluate available models using your application and data, comparing quality, latency, and cost. For selection criteria and the full migration process, see [Model migration process](../../foundry-models/concepts/model-migration.md).

## Foundry Models sold by Azure

This section lists the retirement lifecycle for Foundry Models sold by Azure.

### Azure OpenAI

| Model | Version | Lifecycle | Retire by | Replacement |
|-------|---------|-----------|-----------------|-------------|
| codex-mini | 2025-05-16 | Deprecated | 2026-11-15 | — |
| gpt-4.1 | 2025-04-14 | Deprecated | 2027-04-14 | — |
| gpt-4.1-mini | 2025-04-14 | Deprecated | 2027-04-14 | — |
| gpt-4.1-nano | 2025-04-14 | Deprecated | 2026-10-14 | — |
| gpt-4o | 2024-05-13 | Deprecated | 2026-12-09 | gpt-5.6-sol |
| gpt-4o | 2024-08-06 | Deprecated | 2027-04-14 | gpt-5.1 |
| gpt-4o | 2024-11-20 | Legacy | 2027-04-14 | gpt-5.1 |
| gpt-realtime-mini | 2025-10-06 | GA | 2027-04-06 | — |
| gpt-realtime-mini | 2025-12-15 | GA | 2027-06-15 | — |
| gpt-realtime-mini | 2025-10-06 | GA | 2026-09-21 | — |
| gpt-realtime-mini | 2025-12-15 | GA | 2026-12-15 | — |
| o3-mini | 2025-01-31 | Deprecated | 2026-11-19 | gpt-5.6-terra |
| sora-2 | 2025-10-06 | Preview | 2026-07-15 | sora-2 (2025-12-08) |
| sora-2 | 2025-12-08 | Preview | 2026-10-15 | — |

#### Fine-tuned models

Fine-tuned models retire in two phases: *training* and *deployment*.

Unless explicitly stated, training retires no earlier than the base model retirement date.

| Model | Version | Training retirement date | Deployment retirement date |
|-------|---------|--------------------------|----------------------------|
| gpt-4.1 | 2025-04-14 | No earlier than 2027-04-14<sup>1</sup> | 2027-10-14 |
| gpt-4.1-mini | 2025-04-14 | No earlier than 2027-04-14<sup>1</sup> | 2027-10-14 |
| gpt-4.1-nano | 2025-04-14 | No earlier than 2027-04-14<sup>1</sup> | 2027-10-14 |
| gpt-4o | 2024-08-06 | No earlier than 2027-04-01<sup>1</sup> | 2027-10-01 |
| gpt-4o-mini | 2024-07-18 | No earlier than 2027-04-01<sup>1</sup> | 2027-10-01 |
| o4-mini | 2025-04-16 | No earlier than 2027-05-19<sup>1</sup> | 2027-11-19 |

<sup>1</sup> For existing customers only. Otherwise, training retirement occurs at base model retirement.

## Foundry Models from partners and community

This section lists the retirement lifecycle for Foundry Models sold by partners via Azure Marketplace.

### Anthropic

Microsoft Foundry offers Claude models in [two versions](../../foundry-models/concepts/claude-models.md#how-claude-models-are-hosted-and-billed):

- Version 1: Hosted on Anthropic infrastructure
- Version 2: Hosted on Azure

| Model | Version | Lifecycle | Retire by | Replacement |
| --- | --- | --- | --- | --- |
| claude-sonnet-5 | 2 | GA | 2027-06-30 | — |
| claude-sonnet-5 | 1 | GA | 2027-06-30 | — |
| claude-sonnet-4-6 | 1 | GA | 2027-02-10 | — |
| claude-sonnet-4-5 | 1 | GA | 2026-11-30 | claude-sonnet-5-5 |
| claude-opus-5 | 2 | GA | 2027-07-08 | — |
| claude-opus-5 | 1 | GA | 2027-07-08 | — |
| claude-opus-4-8 | 2 | GA | 2027-09-01 | — |
| claude-opus-4-8 | 1 | GA | 2027-09-01 | — |
| claude-opus-4-7 | 1 | GA | 2027-04-06 | — |
| claude-opus-4-6 | 1 | GA | 2027-02-02 | — |
| claude-opus-4-5 | 1 | GA | 2026-11-24 | — |
| claude-opus-4-1 | — | Retired | 2026-08-05 | claude-opus-5 |
| claude-haiku-4-5 | 1 | GA | 2026-11-15 | — |
| claude-haiku-4-5 | 2 | GA | 2026-11-15 | — |
| claude-fable-5-1 | 1 | Preview | 2027-12-05 | — |
| claude-fable-5 | 1 | Preview | 2027-12-05 | — |
| claude-mythos-5-1 | 1 | Preview | — | — |
| claude-mythos-preview (gated research preview) | — | Preview | 2027-04-02 | — |

### NTT Data

| Model | Version | Lifecycle | Retire by | Replacement |
|-------|---------|-----------|-----------------|-------------|
| tsuzumi-7b | 2 | Legacy | 2026-08-31 | tsuzumi2 |


