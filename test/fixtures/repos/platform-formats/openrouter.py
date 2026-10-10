MODELS = [
    "openai/gpt-fixture-2-2099-02-15",
    "anthropic/claude-fixture-opus-9",
    "google/gemini-fixture-1.0-flash",
    "mistralai/mistral-fixture-large-2099",
    "anthropic/claude-sonnet-4.5",
    "unknown-vendor/gpt-fixture-3",
]
# The file calls OpenRouter, so `<vendor>/<id>` above is an OpenRouter slug.
client = OpenAI(base_url="https://openrouter.ai/api/v1")
