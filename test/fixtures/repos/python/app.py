"""Chat service. Uses gpt-fixture-retired in the docstring, which is a string literal."""
import os

from openai import OpenAI

client = OpenAI()
DEFAULT_MODEL = "gpt-fixture-1-2099-01-10"  # retires soon
FALLBACK = 'gpt-fixture-3'  # gpt-fixture-retired in a comment is not a reference
SUMMARY_MODEL = os.environ.get("SUMMARY_MODEL", "gpt-fixture-3-mini")


def chat(prompt: str, model: str = "gpt-fixture-2-2099-02-15") -> str:
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content


def anthropic_call(client, family: str):
    return client.messages.create(model=f"claude-{family}-fixture", max_tokens=10)


raw = r"gemini-fixture-1.0-pro-001"
template = f"{DEFAULT_MODEL},mistral-fixture-large-2099"
multi = """
deepseek-fixture-chat
"""
