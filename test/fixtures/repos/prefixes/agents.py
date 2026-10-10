from pydantic_ai import Agent

flash = Agent("google-gla:gemini-fixture-1.0-flash")
on_vertex = Agent("google-vertex:gemini-fixture-1.0-flash")
on_cloud = Agent("google-cloud:gemini-fixture-1.0-flash")
chat = Agent("openai-chat:gpt-fixture-retired")
# The OpenAI Agents SDK's route to LiteLLM.
routed = "litellm/anthropic/claude-fixture-opus-9"
