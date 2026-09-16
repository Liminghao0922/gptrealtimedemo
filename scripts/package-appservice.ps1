#requires -Version 7.2
<#
.SYNOPSIS
Creates an allowlisted, dependency-free ZIP for the App Service Oryx remote build.
.DESCRIPTION
RuntimeDirectory and WebRoot both default to webapp (the page and relay runtime). ZIP entries are
flat because server.cjs serves public files from __dirname. Does not run npm or
include tests, probes, node_modules, local settings, .env files, or repository data.
The deployment sets SCM_DO_BUILD_DURING_DEPLOYMENT=true and NODE_ENV=production.
Only the four named HTML pages and realtime-experiments.js are public assets.
No directory recursion, HTML wildcards, optional JavaScript, or browser-ui.test.cjs.
.EXAMPLE
./scripts/package-appservice.ps1
.EXAMPLE
./scripts/package-appservice.ps1 -RuntimeDirectory ./appserver -OutputPath "$env:TEMP/realtime.zip"
#>
[CmdletBinding()]
param(
    [string] $RuntimeDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'webapp'),
    [string] $WebRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) 'webapp'),
    [string] $OutputPath = (Join-Path ([System.IO.Path]::GetTempPath()) "appservice-$([guid]::NewGuid().ToString('N')).zip")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($directory in @($RuntimeDirectory, $WebRoot)) {
    $item = Get-Item -LiteralPath $directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Source must be a real directory, not a link: $directory"
    }
}

$runtimeFiles = @('server.cjs', 'demo-config.cjs', 'package.json', 'package-lock.json')
$publicFiles = @(
    'index.html',
    'gpt-realtime-livevoice-demo.html',
    'gpt-realtime_function_call_map.html',
    'gpt-realtime-websocket-demo.html',
    'realtime-experiments.js'
)


$files = @(
    foreach ($name in $runtimeFiles) {
        [pscustomobject]@{ Name = $name; Path = (Join-Path $RuntimeDirectory $name) }
    }
    foreach ($name in $publicFiles) {
        [pscustomobject]@{ Name = $name; Path = (Join-Path $WebRoot $name) }
    }
)
foreach ($file in $files) {
    $item = Get-Item -LiteralPath $file.Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Allowlisted runtime input must be a regular file, not a link: $($file.Name)"
    }
    $file.Path = $item.FullName
}

$package = Get-Content -LiteralPath (Join-Path $RuntimeDirectory 'package.json') -Raw | ConvertFrom-Json -AsHashtable
$lock = Get-Content -LiteralPath (Join-Path $RuntimeDirectory 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
if ($package.scripts.start -cne 'node server.cjs') {
    throw 'package.json must define scripts.start as exactly "node server.cjs" (one Node server, no PM2).'
}
if (-not $lock.ContainsKey('lockfileVersion') -or -not $package.ContainsKey('dependencies')) {
    throw 'A valid npm lockfile and declared production dependencies are required for remote build.'
}

$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.Path]::GetExtension($OutputPath) -ine '.zip') {
    throw 'OutputPath must have a .zip extension.'
}
$parentDirectory = [System.IO.Path]::GetDirectoryName($OutputPath)
if (-not [System.IO.Directory]::Exists($parentDirectory)) {
    throw 'The output directory must already exist.'
}
$stagingPath = Join-Path $parentDirectory ".$([guid]::NewGuid().ToString('N')).zip.tmp"
try {
    $stream = [System.IO.File]::Open($stagingPath, [System.IO.FileMode]::CreateNew)
    try {
        $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in $files) {
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive, $file.Path, $file.Name, [System.IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null
            }
        }
        finally { $archive.Dispose() }
    }
    finally { $stream.Dispose() }

    $archive = [System.IO.Compression.ZipFile]::OpenRead($stagingPath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName })
        $difference = @(Compare-Object -ReferenceObject @($files.Name) -DifferenceObject $entries -CaseSensitive)
        if ($entries.Count -ne $files.Count -or $difference.Count -ne 0) {
            throw 'ZIP verification failed: archive entries must exactly match the runtime allowlist.'
        }
    }
    finally { $archive.Dispose() }
    [System.IO.File]::Move($stagingPath, $OutputPath, $true)
    [pscustomobject]@{
        ZipPath = $OutputPath
        Entries = $entries
        FileCount = $entries.Count
        Sha256 = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash
        RequiresRemoteBuild = $true
    }
}
finally {
    if ([System.IO.File]::Exists($stagingPath)) {
        [System.IO.File]::Delete($stagingPath)
    }
}
