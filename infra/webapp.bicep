targetScope = 'resourceGroup'

@description('Name of the Static Web App.')
param name string = 'stapp-realtime-${take(uniqueString(subscription().id, resourceGroup().id), 8)}'

@description('Azure region for the Static Web App.')
param location string = 'eastasia'

resource webapp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    allowConfigFileUpdates: true
    publicNetworkAccess: 'Enabled'
  }
}

output name string = webapp.name
output defaultHostname string = webapp.properties.defaultHostname
