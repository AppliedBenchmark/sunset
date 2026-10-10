var a = @"C:\models\gpt-fixture-retired";
var b = $"{model},gpt-fixture-3";
var c = """
    "claude-fixture-1-20990101"
    """;
var client = new ChatClient(model: Environment.GetEnvironmentVariable("MODEL"));
