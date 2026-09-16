#requires -Version 7.4
<#
.SYNOPSIS
Validates, or explicitly deploys, the approved Japan East F1 unified App Service.
.DESCRIPTION
The default action (also -ValidateOnly) is ARM validation, NOT deployment. -Deploy
is required for any cloud writes. Sign in separately with Azure CLI; this script
never changes the default subscription and supplies --subscription to every Azure
command. Use a current Azure CLI (2.48.1+ for Entra-authenticated ZIP deployment
with basic publishing disabled) and Bicep. The existing resource group and AOAI
account must exist; the caller needs deployment permissions and permission to
assign Cognitive Services OpenAI User at that account.

Key precedence: -DemoAccessKey (SecureString), process DEMO_ACCESS_KEY, then a
hidden prompt. DEMO_ACCESS_KEY is temporarily removed from the process environment
so Azure CLI children cannot inherit it, and restored in finally. A random,
owner-only temporary directory holds the ARM secure-string parameters JSON. Only
its path reaches CLI arguments. Raw Azure output is suppressed, including errors,
because validation errors can echo parameter values. Do not use CLI debug logging
or PowerShell tracing/transcripts with secrets. All temporary files are deleted in
finally; as with any local secret file, forced process termination prevents cleanup.

Deployments use Incremental mode and stable names. No resource group, model,
Function, SWA, paid SKU, storage, monitoring service, or fallback is provisioned.
ZIPs are built locally WITHOUT npm installs; App Service performs a production npm
remote build. No run-from-package mode. npm start launches only node server.cjs.
If Node 24 remote build/F1 fails, stop and investigate; never upgrade the SKU.
Health checks are external and unauthenticated; no access key is sent to /health.
/health establishes process liveness only, not AOAI authorization or relay readiness.
RuntimeDirectory and WebRoot default to the current unified runtime in webapp.
Returns only nonsecret resourceId/defaultHostName and status/URL fields. Validation
returns a target resourceId and null defaultHostName: it does not create/query a site.
.EXAMPLE
./scripts/deploy-appservice.ps1 -AoaiRealtimeDeployment '<existing-deployment>' -ValidateOnly
.EXAMPLE
$key = Read-Host 'Demo access key' -AsSecureString
./scripts/deploy-appservice.ps1 -AoaiRealtimeDeployment '<existing-deployment>' -DemoAccessKey $key -Deploy
#>
[CmdletBinding(DefaultParameterSetName = 'Validate')]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $AoaiRealtimeDeployment,

    [Parameter(ParameterSetName = 'Validate')]
    [switch] $ValidateOnly,

    [Parameter(Mandatory, ParameterSetName = 'Deploy')]
    [switch] $Deploy,

    [System.Security.SecureString] $DemoAccessKey,

    [Alias('Subscription')]
    [ValidateSet('a5095cf8-c1ec-4a7e-9ee7-22103870844b')]
    [string] $SubscriptionId = 'a5095cf8-c1ec-4a7e-9ee7-22103870844b',

    [ValidateSet('rg-pec-robotics')]
    [string] $ResourceGroup = 'rg-pec-robotics',

    [ValidateSet('app-realtime-f1-mh0922')]
    [string] $AppName = 'app-realtime-f1-mh0922',

    [ValidateSet('asp-realtime-f1-mh0922')]
    [string] $PlanName = 'asp-realtime-f1-mh0922',

    [ValidateSet('japaneast')]
    [string] $Location = 'japaneast',

    [ValidateSet('aoai-robotics')]
    [string] $AoaiAccountName = 'aoai-robotics',

    [string] $RuntimeDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'webapp'),
    [string] $WebRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) 'webapp')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$null = Get-Command az -ErrorAction Stop
$templatePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'infra/appservice.bicep'
if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    throw 'infra/appservice.bicep is missing.'
}

function Invoke-AzureQuiet {
    param([string[]] $Arguments, [string] $Operation)
    # Never return diagnostics: ARM/CLI errors may contain resolved parameter values.
    $diagnostics = $null
    try {
        $diagnostics = @(& az @Arguments --subscription $SubscriptionId --only-show-errors --output none 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw 'Azure CLI returned a nonzero exit code.'
        }
    }
    catch {
        throw "$Operation failed. Azure output was suppressed to protect the demo key. Check the deployment status in Azure; do not enable secret-bearing debug output. No paid fallback was attempted."
    }
    finally { $diagnostics = $null }
}

$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "appservice-deploy-$([guid]::NewGuid().ToString('N'))"
$parameterPath = Join-Path $tempDirectory 'parameters.json'
$ownsDemoAccessKey = $false
$environmentDemoKey = $null
$restoreEnvironmentDemoKey = $false
$targetResourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$AppName"
$parameters = $null
$parameterJson = $null
try {
    # Read no settings files or Azure secrets. This process env var is an optional input.
    # Preserve it as a SecureString while keeping it out of all child-process environments.
    $environmentKeyText = [System.Environment]::GetEnvironmentVariable('DEMO_ACCESS_KEY', 'Process')
    try {
        if ($null -ne $environmentKeyText) {
            $environmentDemoKey = if ($environmentKeyText.Length -gt 0) {
                ConvertTo-SecureString -String $environmentKeyText -AsPlainText -Force
            }
            else { [System.Security.SecureString]::new() }
            # Provider removal avoids newer .NET binding $null as an empty environment value.
            Remove-Item -LiteralPath 'Env:DEMO_ACCESS_KEY'
            $restoreEnvironmentDemoKey = $true
        }
    }
    finally { $environmentKeyText = $null }

    if ($IsWindows) {
        [System.IO.Directory]::CreateDirectory($tempDirectory) | Out-Null
        # Restrict inheritance BEFORE writing any secret. Files inherit this owner-only ACL.
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $tempDirectory -AclObject $acl
    }
    else {
        $mode = [System.IO.UnixFileMode]::UserRead -bor [System.IO.UnixFileMode]::UserWrite -bor [System.IO.UnixFileMode]::UserExecute
        [System.IO.Directory]::CreateDirectory($tempDirectory, $mode) | Out-Null
    }

    # Fail missing/invalid package inputs BEFORE making any Azure changes.
    $package = $null
    if ($Deploy) {
        $package = & (Join-Path $PSScriptRoot 'package-appservice.ps1') `
            -RuntimeDirectory $RuntimeDirectory -WebRoot $WebRoot `
            -OutputPath (Join-Path $tempDirectory 'appservice.zip')
        Write-Host "Verified $($package.FileCount) allowlisted ZIP entries; production dependencies will be installed remotely."
    }

    if ($null -eq $DemoAccessKey) {
        if ($null -ne $environmentDemoKey -and $environmentDemoKey.Length -gt 0) {
            $DemoAccessKey = $environmentDemoKey.Copy()
        }
        else {
            $DemoAccessKey = Read-Host 'Demo access key (input hidden)' -AsSecureString
        }
        $ownsDemoAccessKey = $true
    }
    if ($DemoAccessKey.Length -eq 0) {
        throw 'DemoAccessKey cannot be empty.'
    }

    $buffer = [System.IntPtr]::Zero
    try {
        $buffer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($DemoAccessKey)
        $parameters = @{
            '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
            contentVersion = '1.0.0.0'
            parameters = @{
                appName = @{ value = $AppName }
                planName = @{ value = $PlanName }
                location = @{ value = $Location }
                aoaiAccountName = @{ value = $AoaiAccountName }
                aoaiRealtimeDeployment = @{ value = $AoaiRealtimeDeployment }
                demoAccessKey = @{ value = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer) }
            }
        }
        $parameterJson = ConvertTo-Json -InputObject $parameters -Depth 8 -Compress
        [System.IO.File]::WriteAllText($parameterPath, $parameterJson, [System.Text.UTF8Encoding]::new($false))
        if (-not $IsWindows) {
            [System.IO.File]::SetUnixFileMode($parameterPath, [System.IO.UnixFileMode]::UserRead -bor [System.IO.UnixFileMode]::UserWrite)
        }
    }
    finally {
        if ($buffer -ne [System.IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer)
        }
        $parameterJson = $null
        if ($null -ne $parameters) { $parameters.Clear(); $parameters = $null }
    }

    $deploymentArguments = @(
        '--resource-group', $ResourceGroup,
        '--name', 'appservice-realtime-f1',
        '--template-file', $templatePath,
        '--parameters', "@$parameterPath",
        '--mode', 'Incremental'
    )
    Invoke-AzureQuiet -Arguments (@('deployment', 'group', 'validate') + $deploymentArguments) -Operation 'ARM validation'
    Write-Host 'ARM validation succeeded for the approved Japan East Free F1 plan.'
    if (-not $Deploy) {
        Write-Host 'Validation only: no infrastructure or application deployment was performed.'
        [pscustomobject]@{
            validatedOnly = $true
            resourceId = $targetResourceId
            defaultHostName = $null
        }
        return
    }

    Invoke-AzureQuiet -Arguments (@('deployment', 'group', 'create') + $deploymentArguments) -Operation 'Incremental infrastructure deployment'
    # The secret is no longer needed on disk; finally also removes it on any earlier failure.
    [System.IO.File]::Delete($parameterPath)
    Invoke-AzureQuiet -Arguments @(
        'webapp', 'deploy', '--resource-group', $ResourceGroup, '--name', $AppName,
        '--src-path', $package.ZipPath, '--type', 'zip', '--clean', 'true',
        '--restart', 'true', '--async', 'false', '--track-status', 'true', '--timeout', '1200000'
    ) -Operation 'Entra-authenticated ZIP remote-build deployment'

    # Query ONLY nonsecret site identifiers, never settings, publishing credentials, or keys.
    $siteResult = @(& az webapp show --resource-group $ResourceGroup --name $AppName `
        --subscription $SubscriptionId --query '{resourceId:id,defaultHostName:defaultHostName}' `
        --output json --only-show-errors 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw 'Deployment completed, but the nonsecret site identifier lookup failed. Output suppressed.'
    }
    try {
        $siteIdentifiers = ($siteResult -join "`n") | ConvertFrom-Json -AsHashtable
        $hostname = [string]$siteIdentifiers.defaultHostName
        $resourceId = [string]$siteIdentifiers.resourceId
    }
    catch { throw 'Deployment completed, but site identifiers could not be parsed. Output suppressed.' }
    if ($resourceId -ine $targetResourceId) {
        throw 'Deployment completed, but Azure returned an unexpected resource ID.'
    }
    if ($hostname -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*\.azurewebsites\.net$') {
        throw 'Deployment completed, but Azure returned an unexpected default hostname.'
    }
    $healthUrl = "https://$hostname/health"
    $healthy = $false
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 30 -MaximumRedirection 0
            if ($response.StatusCode -eq 200) { $healthy = $true; break }
        }
        catch { } # Never echo response bodies, which could contain application configuration.
        if ($attempt -lt 12) { Start-Sleep -Seconds 10 }
    }
    if (-not $healthy) {
        throw "Deployment completed, but the external health check did not return HTTP 200: $healthUrl. Check F1/remote-build status; no paid fallback was attempted."
    }
    Write-Host "Deployed: https://$hostname"
    Write-Host "External health check: $healthUrl (HTTP 200, process-only; does not validate AOAI access)."
    [pscustomobject]@{
        validatedOnly = $false
        resourceId = $resourceId
        defaultHostName = $hostname
        appUrl = "https://$hostname"
        healthUrl = $healthUrl
        healthCheck = 'process-only'
    }
}
finally {
    try {
        $parameterJson = $null
        if ($null -ne $parameters) { $parameters.Clear() }
        if ($ownsDemoAccessKey -and $null -ne $DemoAccessKey) { $DemoAccessKey.Dispose() }
        if ([System.IO.Directory]::Exists($tempDirectory)) {
            Remove-Item -LiteralPath $tempDirectory -Recurse -Force
        }
    }
    finally {
        $restoreBuffer = [System.IntPtr]::Zero
        try {
            if ($restoreEnvironmentDemoKey) {
                $restoreBuffer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($environmentDemoKey)
                [System.Environment]::SetEnvironmentVariable(
                    'DEMO_ACCESS_KEY', [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($restoreBuffer), 'Process'
                )
            }
        }
        finally {
            if ($restoreBuffer -ne [System.IntPtr]::Zero) {
                [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($restoreBuffer)
            }
            if ($null -ne $environmentDemoKey) { $environmentDemoKey.Dispose() }
        }
    }
}
