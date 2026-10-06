# lag-rise-zip.ps1 — pakker spilleren som zip for opplasting i Articulate Rise (Code-blokk).
#
#   powershell -ExecutionPolicy Bypass -File lag-rise-zip.ps1
#
# Bare filene spilleren trenger tas med, og index.html ligger i roten av zip-filen.
# Kjør «node bygg-scenario-data.js» først hvis scenario.json er endret.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$filer = @(
    'index.html',
    'app.js',
    'player.css',
    'style.css',
    'simulator.js',
    'renderer.js',
    'scenario-data.js',
    'scenario.json'
)

$zip = 'for-kort-inspirasjonstid-player.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $filer -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Skrev $zip"
