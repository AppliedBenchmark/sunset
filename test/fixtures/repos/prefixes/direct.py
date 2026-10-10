# LiteLLM's `<vendor>/<id>` calls the vendor's own API, so the vendor's dates apply in full.
from litellm import completion

opus = completion(model="anthropic/claude-fixture-opus-9", messages=[])
retired = completion(model="openai/gpt-fixture-retired", messages=[])
