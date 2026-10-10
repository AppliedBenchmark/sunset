This document defines key terms related to the lifecycle stages and important dates for Gemini and embedding models that are available on Google Cloud Gemini Enterprise Agent Platform. It also gives you the recommended upgrades for the models and points you to available migration paths.

<br />

## Latest available models

The following tables list the available models and their retirement dates. While
retirement timelines may be extended, they won't be moved to an earlier date
than what is listed.

### Models available for at least 12 months after release

The following table lists the models that will be available for at least 12
months after initial release:

### Gemini models


| Model ID | Release date | Retirement date | Replacement model ID |
|---|---|---|---|
| [`gemini-3.5-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite) | July 21, 2026 | July 21, 2027 or later |   |
| [`gemini-3.5-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash) | May 19, 2026 | May 19, 2027 or later |   |
| [`gemini-3.1-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite) | May 7, 2026 | May 7, 2027 or later |   |
| [`gemini-2.5-pro`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-pro) | June 17, 2025 | October 20, 2026 | [`gemini-3.8-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash) or [`gemini-3.5-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash) |
| [`gemini-2.5-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash) | June 17, 2025 | October 20, 2026 | [`gemini-3.8-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash) or [`gemini-3.5-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite) or [`gemini-3.1-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite) |
| [`gemini-2.5-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite) | July 22, 2025 | October 20, 2026 | [`gemini-3.8-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash) or [`gemini-3.1-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite) or [Gemma 4](https://console.cloud.google.com/agent-platform/publishers/google/model-garden/gemma4) |
| [`gemini-live-2.5-flash-native-audio`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api) | December 12, 2025 | December 13, 2026 |   |

<br />

### Embeddings models


| Model ID | Release date | Retirement date | Replacement model ID |
|---|---|---|---|
| [`gemini-embedding-2`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/embedding-2) | April 22, 2026 |   |   |
| [`gemini-embedding-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings) | May 20, 2025 | No sooner than May 20, 2028 |   |
| [`text-embedding-005`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings) | November 18, 2024 | April 1, 2027 |   |
| [`text-embedding-004`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings) | May 14, 2024 | April 1, 2027 |   |
| [`text-multilingual-embedding-002`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings) | May 14, 2024 | April 1, 2027 |   |
| [`multimodalembedding@001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings) | February 12, 2024 | April 1, 2027 |   |

<br />

### Retired models

#### The following table lists the retired models (click to expand)

| Model ID | Release date | Retirement date | Recommended upgrade |
|---|---|---|---|
| `gemini-2.0-flash` | February 5, 2025 | June 1, 2026 | [`gemini-3.1-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite) |
| `gemini-2.0-flash-lite` | February 25, 2025 | June 1, 2026 | [`gemini-3.1-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite) |
| `gemini-1.5-pro-001` | May 24, 2024 | May 24, 2025 | [`gemini-2.5-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash) |
| `gemini-1.5-pro-002` | September 24, 2024 | September 24, 2025 | [`gemini-2.5-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash) |
| `gemini-1.5-flash-001` | May 24, 2024 | May 24, 2025 | [`gemini-2.5-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite) |
| `gemini-1.5-flash-002` | September 24, 2024 | September 24, 2025 | [`gemini-2.5-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite) |
| `textembedding-gecko@003\*` | December 12, 2023 | May 24, 2025 | [`gemini-embedding-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings) |
| `textembedding-gecko-multilingual@001` | November 2, 2023 | May 24, 2025 | [`gemini-embedding-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings) |
| `gemini-1.0-pro-001` | February 15, 2024 | April 21, 2025 | [`gemini-2.5-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash) |
| `gemini-1.0-pro-002` | April 9, 2024 | April 21, 2025 | [`gemini-2.5-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash) |
| `gemini-1.0-pro-vision-001` | February 15, 2024 | April 21, 2025 | [`gemini-2.5-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash) |
| `text-bison` | May 2023 | April 21, 2025 | [`gemini-2.5-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite) |
| `chat-bison` | May 2023 | April 21, 2025 | [`gemini-2.5-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite) |
| `code-gecko` | May 2023 | April 21, 2025 | [`gemini-2.5-flash-lite`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite) |
| `textembedding-gecko@002` | November 2, 2023 | April 21, 2025 | [`gemini-embedding-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings) |
| `textembedding-gecko@001` | June 7, 2023 | April 21, 2025 | [`gemini-embedding-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings) |
| `imagetext` | June 7, 2023 | September 24, 2025 | [`gemini-2.5-flash-image`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-image) |

