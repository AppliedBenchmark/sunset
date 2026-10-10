import yaml

# A YAML document in a string argument, not a docstring.
DEFAULTS = yaml.safe_load(
    """
    model: claude-fixture-1-20990101
    temperature: 0.2
    """
)
