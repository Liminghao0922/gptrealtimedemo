targetScope = 'resourceGroup'

@description('Name of the Linux page and relay host. The separate Function issues tokens.')
param appName string = 'app-realtime-f1-mh0922'

@description('Name of the Free F1 Linux App Service plan. There is no paid SKU parameter or fallback.')
param planName string = 'asp-realtime-f1-mh0922'

@description('Approved region for the new App Service resources, independent of the existing AOAI region.')
@allowed([
  'japaneast'
])
param location string = 'japaneast'

@description('Existing Azure OpenAI account in this resource group. Its endpoint is read, never reconstructed.')
param aoaiAccountName string = 'aoai-robotics'

@description('Name of the existing realtime model deployment. No model or account changes are made.')
@minLength(1)
param aoaiRealtimeDeployment string

@description('Nonsecret HTTPS token API URL of the existing Function. Do not include a Function key or query parameters.')
@minLength(1)
param functionAccessUrl string

@description('Demo access key. Supply through a protected temporary parameters file, never a command-line value.')
@secure()
@minLength(1)
param demoAccessKey string

resource aoai 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: aoaiAccountName
}

// Based on the version-tagged AVM Linux examples. Override paid/AlwaysOn defaults explicitly.
module plan 'br/public:avm/res/web/serverfarm:0.7.0' = {
  name: 'appservice-f1-plan'
  params: {
    name: planName
    location: location
    kind: 'linux'
    reserved: true
    skuName: 'F1'
    skuCapacity: 1
    zoneRedundant: false
    perSiteScaling: false
    elasticScaleEnabled: false
    maximumElasticWorkerCount: 1
    enableTelemetry: false
  }
}

module site 'br/public:avm/res/web/site:0.24.0' = {
  name: 'appservice-f1-site'
  params: {
    name: appName
    location: location
    kind: 'app,linux'
    reserved: true
    serverFarmResourceId: plan.outputs.resourceId
    managedIdentities: {
      systemAssigned: true
    }
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    clientAffinityEnabled: false
    clientAffinityProxyEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      // package.json start must be exactly "node server.cjs"; no PM2 or multiple workers.
      appCommandLine: 'npm start'
      alwaysOn: false
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      // No healthCheckPath: F1 uses an external /health check, not App Service Health Check.
    }
    basicPublishingCredentialsPolicies: [
      {
        name: 'ftp'
        allow: false
      }
      {
        name: 'scm'
        allow: false
      }
    ]
    configs: [
      {
        name: 'logs'
        properties: {
          applicationLogs: {
            fileSystem: {
              level: 'Information'
            }
          }
          httpLogs: {
            fileSystem: {
              enabled: true
              retentionInDays: 3
              retentionInMb: 25
            }
          }
          detailedErrorMessages: {
            enabled: false
          }
          failedRequestsTracing: {
            enabled: false
          }
        }
      }
    ]
    enableTelemetry: false
  }
}

resource app 'Microsoft.Web/sites@2025-03-01' existing = {
  name: appName
}

// AVM site 0.24.0 configs/siteConfig and its config child's properties are NOT secure
// parameters. Keep the secret in this deployment's secure parameter path instead of
// exposing it as a plaintext nested-deployment parameter. No list/appsettings is used.
resource appSettings 'Microsoft.Web/sites/config@2025-03-01' = {
  parent: app
  name: 'appsettings'
  properties: {
    AOAI_ENDPOINT: aoai.properties.endpoint
    AOAI_REALTIME_DEPLOYMENT: aoaiRealtimeDeployment
    FUNCTION_ACCESS_URL: functionAccessUrl
    DEMO_ACCESS_KEY: demoAccessKey
    NODE_ENV: 'production'
    SCM_DO_BUILD_DURING_DEPLOYMENT: 'true'
    // Do not set WEBSITE_RUN_FROM_PACKAGE: this ZIP requires an Oryx/npm remote build.
    // PUBLIC_ORIGIN is inferred by readConfig from the platform's WEBSITE_HOSTNAME.
  }
  dependsOn: [
    site
  ]
}

var openAiUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
)

// Preserve this existing assignment during the issuer cutover; the relay does not use it.
// An extension resource is required for this exact existing-account scope.
// A stable account/app/role GUID makes repeated incremental deployments idempotent.
resource openAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aoai.id, app.id, openAiUserRoleId)
  scope: aoai
  properties: {
    roleDefinitionId: openAiUserRoleId
    principalId: site.outputs.systemAssignedMIPrincipalId!
    principalType: 'ServicePrincipal'
  }
}

// Canonical nonsecret outputs for deployment automation; retain the existing aliases below.
output resourceId string = site.outputs.resourceId
output defaultHostName string = site.outputs.defaultHostname

output appResourceId string = site.outputs.resourceId
output planResourceId string = plan.outputs.resourceId
output appDefaultHostname string = site.outputs.defaultHostname
output appUrl string = 'https://${site.outputs.defaultHostname}'
output healthUrl string = 'https://${site.outputs.defaultHostname}/health'
