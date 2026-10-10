param modelName string = 'gpt-fixture-4o'

resource chat 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: 'chat'
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-fixture-4o'
      version: '2099-01-05'
    }
  }
}

resource unpinned 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: 'unpinned'
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-fixture-4o'
    }
  }
}

resource parameterized 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: 'param'
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: '2099-01-05'
    }
  }
}

var note = '${modelName},gpt-fixture-retired'
