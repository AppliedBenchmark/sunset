class Chat {
  // Spring's placeholder: the property, or the default after the colon.
  @Value("${spring.ai.openai.chat.options.model:gpt-fixture-retired}")
  private String model;

  @Value("${app.fallback-model:claude-fixture-opus-9}")
  private String fallback;
}
