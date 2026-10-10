-- gpt-fixture-retired was the default until it retired.
require("avante").setup({
  provider = "openai",
  openai = {
    model = "gpt-fixture-2-2099-02-15",
    --[[ sunset-ignore-next-line reason="pinned for the demo" ]]
    fallback = [[gpt-fixture-retired]],
  },
})
