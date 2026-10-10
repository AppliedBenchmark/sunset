#Requires -Version 7.0
<#
.SYNOPSIS
  Runs the nightly evaluation. gpt-fixture-retired was the default until it retired.
#>
param(
    [string]$Model = 'gpt-fixture-2-2099-02-15'
)

# sunset-ignore-next-line reason="baseline"
$baseline = "gpt-fixture-retired"
$body = @"
{ "model": "$Model", "note": "Don't stop" }
"@
python eval.py --model gpt-fixture-3 `
  --baseline $baseline
