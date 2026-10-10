def provider(model: str) -> str:
    # Checks against a model's name, not references to a model.
    if model.startswith("gpt-fixture-retired") or "ft:gpt-fixture-retired" in model:
        return "openai"
    return "other"


DEFAULT = {"model": "gpt-fixture-retired"}
