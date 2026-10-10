import os

client.chat.completions.create(model=os.environ["OPENAI_MODEL"], messages=[])
client.chat.completions.create(model=settings.model_name, messages=[])
client.messages.create(model=f"claude-{tier}-fixture", max_tokens=5)
model = model.to(device)
model_id = os.getenv("MODEL_ID")
response_model = Item
