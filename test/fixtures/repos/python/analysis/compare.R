# gpt-fixture-retired was the baseline until it retired.
library(ellmer)

chat <- chat_openai(model = "gpt-fixture-2-2099-02-15")
prompt <- r"(Summarize: "it's done")"
# sunset-ignore-next-line reason="reproduces the published table"
baseline <- 'gpt-fixture-retired'
