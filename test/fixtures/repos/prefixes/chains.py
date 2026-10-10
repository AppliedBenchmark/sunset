from langchain.chat_models import init_chat_model

opus = init_chat_model("anthropic:claude-fixture-opus-9")
flash = init_chat_model("google_vertexai:gemini-fixture-1.0-flash")
gpt = init_chat_model("azure_openai:gpt-fixture-4o")
# A fine-tuned model runs until its base model is retired.
tuned = "ft:gpt-fixture-retired:my-org::abc123"
cache_key = "usage:gpt-fixture-retired"
