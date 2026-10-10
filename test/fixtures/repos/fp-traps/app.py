# Prefix of a longer ID: only the full ID is reported, and gpt-fixture-3-mini is active.
a = "gpt-fixture-3-mini"
b = "gpt-fixture-3-nano"          # unknown longer ID: not gpt-fixture-3
c = "gpt-fixture-30"
# IDs inside identifiers and longer tokens
my_gpt_fixture_3 = 1
d = "xgpt-fixture-3"
e = "gpt-fixture-3_backup"
f = "v.gpt-fixture-3"
g = "prefix-gpt-fixture-3"
# IDs in comments: gpt-fixture-retired claude-fixture-opus-9
# Model family words as plain text
h = "We like gpt models, claude and gemini for chat."
i = "gpt fixture 3"
# Date-like and version-like strings
j = "2099-01-10"
k = "v1:0"
l = "20990101"
m = "gpt-fixture-1-2099-01-10-preview"
n = "anthropic.claude-fixture-v2:9"
o = "gemini-fixture-1.0-flash.json"
p = "claude-fixture-opus-9@0001"     # neither @YYYYMMDD nor @NNN
