#!/usr/bin/env bash
az cognitiveservices account deployment create \
  --name my-account --resource-group rg \
  --deployment-name chat \
  --model-name gpt-fixture-4o --model-version "2099-01-05" --model-format OpenAI
az cognitiveservices account deployment create --name a --resource-group rg --deployment-name d --model-name "$MODEL_NAME" --model-format OpenAI
# az cognitiveservices account deployment create --model-name gpt-fixture-4o
