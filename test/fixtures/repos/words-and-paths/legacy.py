import openai

# The old completions API took the model as `engine`.
completion = openai.Completion.create(engine="quokka", prompt="Say hi")
embedding = openai.Embedding.create(model="quokka", input="hi")
SETTINGS = {"model": "quokka", "language": "quokka"}
