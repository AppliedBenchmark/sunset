resource "azurerm_cognitive_deployment" "chat" {
  name                 = "chat"
  cognitive_account_id = azurerm_cognitive_account.main.id
  model {
    format  = "OpenAI"
    name    = "gpt-fixture-4o"
    version = "2099-01-05"
  }
  sku {
    name = "Standard"
  }
}

resource "azurerm_cognitive_deployment" "default_version" {
  name = "default"
  model {
    format = "OpenAI"
    name   = "gpt-fixture-4o"
  }
}

resource "azurerm_cognitive_deployment" "current" {
  name = "current"
  model {
    format  = "OpenAI"
    name    = "gpt-fixture-4o"
    version = "2099-08-06"
  }
}

locals {
  bedrock_model = "anthropic.claude-fixture-opus-9" # Bedrock, no -v1:0 suffix
  prompt        = <<-EOT
    model: us.anthropic.claude-fixture-1-20990101-v1:0
    EOT
  model         = var.model_name
  # model = "gpt-fixture-retired"
}

resource "aws_instance" "worker" {
  ami           = var.ami
  instance_type = "t3.small"
  user_data     = <<-EOF
    #!/bin/bash
    python worker.py gpt-fixture-3
  EOF
}
