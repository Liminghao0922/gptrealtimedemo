targetScope = 'resourceGroup'

param accountName string
param managedIdentityPrincipalId string
param managedIdentityResourceId string
param roleDefinitionId string

resource azureOpenAI 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: accountName
}

resource azureOpenAIRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(azureOpenAI.id, managedIdentityResourceId, roleDefinitionId)
  scope: azureOpenAI
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
