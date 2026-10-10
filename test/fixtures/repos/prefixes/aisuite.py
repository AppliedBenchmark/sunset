import aisuite as ai

client = ai.Client()
# aisuite writes `<provider>:<model>`: `aws:` is Bedrock, and its `google:` is Vertex AI.
client.chat.completions.create(model="aws:anthropic.claude-fixture-v2", messages=[])
client.chat.completions.create(model="google:gemini-fixture-1.0-flash", messages=[])
