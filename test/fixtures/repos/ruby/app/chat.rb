# frozen_string_literal: true

MODELS = %w[gpt-fixture-4o gpt-fixture-3].freeze

class Chat
  SYSTEM = <<~TEXT
    You are a helpful assistant. Answers come from gpt-fixture-2-2099-02-15.
  TEXT

  # gpt-fixture-retired was the default until it retired.
  def call(client) = client.chat(model: MODELS.first, system: SYSTEM)
end
