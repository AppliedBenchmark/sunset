import boto3

runtime = boto3.client("bedrock-runtime")
ids = [
    "anthropic.claude-fixture-1-20990101-v1:0",          # base ID, region-scoped dates
    "us.anthropic.claude-fixture-1-20990101-v1:0",       # cross-region inference profile
    "us-gov.anthropic.claude-fixture-opus-9",            # GovCloud profile, no -v1:0 suffix
    "global.anthropic.claude-fixture-opus-9",
    "apac.deepseek.fixture-v3.2",
    "anthropic.claude-fixture-v2",                       # prefix of anthropic.claude-fixture-v2:1
    "anthropic.claude-fixture-v2:1",
    "ca.anthropic.claude-fixture-opus-9",                # not a known geo prefix
]
