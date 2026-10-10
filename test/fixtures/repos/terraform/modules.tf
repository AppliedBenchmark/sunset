# Deployments through modules: Azure Verified Module inputs, and the Azure/openai/azurerm module's.
module "foundry" {
  source = "Azure/avm-res-cognitiveservices-account/azurerm"
  cognitive_deployments = {
    chat = {
      name = "chat"
      model = {
        format  = "OpenAI"
        name    = "gpt-fixture-4o"
        version = "2099-01-05"
      }
    }
  }
}

module "openai" {
  source = "Azure/openai/azurerm"
  deployment = {
    "legacy" = {
      name          = "legacy"
      model_format  = "OpenAI"
      model_name    = "gpt-fixture-retired" # not an Azure model name: Azure's dates are unknown
      model_version = "0613"
    }
  }
}
