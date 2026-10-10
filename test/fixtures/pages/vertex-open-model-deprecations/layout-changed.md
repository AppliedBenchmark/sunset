This page lists deprecation and retirement details for open models offered
through Model as a Service (MaaS).

## Key terms

- **Deprecation** : When a model reaches its **deprecation date**, notice is given that the model is planned for retirement. During the deprecation period, the model endpoint remains functional for existing workloads so that you can plan and implement migrations, but no new features or updates are added and new use of the endpoint may be restricted.
- **Retirement** : When a model reaches its **retirement date**, the model endpoint is permanently deactivated and is no longer accessible or supported. API requests calling a retired model ID will fail.

## Minimum availability for Preview models

Open models offered at the Preview launch stage are available for at least
45 days from their release date. Google might extend availability beyond this
period based on usage and demand.

This period is a minimum, not a scheduled deprecation. If a model is
deprecated, the deprecation is announced on this page along with the model's
retirement date, and the endpoint remains functional throughout the
deprecation period so that you can plan and implement a migration.

## Deprecation and retirement details

The following table lists the deprecation and retirement schedules for
open models offered through Model as a Service (MaaS), as well as a
recommended self-deploy alternative. To learn more about self-deploying
a model on Model Garden, see [Overview of self-deployed
models](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-garden/self-deployed-models).
Alternatively, you can migrate your workloads to alternative managed endpoints
before the retirement date.

| Model ID | Deprecation date | Shutdown date | Self-deploy alternative |
|---|---|---|---|
| `deepseek-ocr-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy DeepSeek-OCR on Model Garden](https://console.cloud.google.com/agent-platform/publishers/deepseek-ai/model-garden/deepseek-ocr) |
| `deepseek-r1-0528-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy DeepSeek-R1 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/deepseek-ai/model-garden/deepseek-r1) |
| `deepseek-v3.2-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy DeepSeek-V3.2 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/deepseek-ai/model-garden/deepseek-v3-2) |
| `deepseek-v3.1-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy DeepSeek-V3.1 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/deepseek-ai/model-garden/deepseek-v3-1) |
| `glm-5-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy GLM 5 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/zai-org/model-garden/glm-5) |
| `glm-4.7-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy GLM 4.7 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/zai-org/model-garden/glm-4.7) |
| `gpt-oss-20b-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy GPT OSS on Model Garden](https://console.cloud.google.com/agent-platform/publishers/openai/model-garden/gpt-oss) |
| `kimi-k2-thinking-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy Kimi K2 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/moonshotai/model-garden/kimi-k2) |
| `llama-3.3-70b-instruct-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy Llama 3.3 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/meta/model-garden/llama3-3) |
| `minimax-m2-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy MiniMax M2 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/minimaxai/model-garden/minimax-m2) |
| `multilingual-e5-large-instruct-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy E5 Text Embedding on Model Garden](https://console.cloud.google.com/agent-platform/publishers/intfloat/model-garden/e5) |
| `multilingual-e5-small-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy E5 Text Embedding on Model Garden](https://console.cloud.google.com/agent-platform/publishers/intfloat/model-garden/e5) |
| `qwen3-235b-a22b-instruct-2507-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy Qwen3 on Model Garden](https://console.cloud.google.com/agent-platform/publishers/qwen/model-garden/qwen3) |
| `qwen3-coder-480b-a35b-instruct-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy Qwen3 Coder on Model Garden](https://console.cloud.google.com/agent-platform/publishers/qwen/model-garden/qwen3-coder) |
| `qwen3-next-80b-a3b-instruct-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy Qwen3 Next on Model Garden](https://console.cloud.google.com/agent-platform/publishers/qwen/model-garden/qwen3-next) |
| `qwen3-next-80b-a3b-thinking-maas` | July 21, 2026 | October 21, 2026 | [Self-deploy Qwen3 Next on Model Garden](https://console.cloud.google.com/agent-platform/publishers/qwen/model-garden/qwen3-next) |