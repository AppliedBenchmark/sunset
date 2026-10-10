// An Azure Verified Module takes the same deployment objects.
module foundry 'br/public:avm/res/cognitive-services/account:0.15.0' = {
  name: 'foundry'
  params: {
    name: 'foundry'
    kind: 'AIServices'
    deployments: [
      {
        name: 'chat'
        model: {
          format: 'OpenAI'
          name: 'gpt-fixture-4o'
          version: '2099-08-06'
        }
      }
      {
        name: 'unknown-version'
        model: {
          format: 'OpenAI'
          name: 'gpt-fixture-4o'
          version: '2099-12-31'
        }
      }
    ]
  }
}
