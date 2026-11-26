<#
  Genera release\ (runtime de Node + app compilada + node_modules de producción).
  Debe ejecutarse EN WINDOWS x64: los módulos nativos (better-sqlite3, msnodesqlv8) se compilan/descargan por plataforma.
  Requisitos: Node 22 x64 instalado, npm, y node.exe disponible en $env:NODE_EXE (o el de PATH).
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

npm ci
npm test
npm run build

Remove-Item release -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory release\runtime, release\app | Out-Null

$node = if ($env:NODE_EXE) { $env:NODE_EXE } else { (Get-Command node).Source }
Copy-Item $node release\runtime\node.exe

Copy-Item dist, package.json, package-lock.json release\app -Recurse
Push-Location release\app
npm ci --omit=dev          # incluye msnodesqlv8 (optionalDependency) en Windows
Pop-Location

# Comprobación rápida de módulos nativos con el node.exe empaquetado
& release\runtime\node.exe -e "require('better-sqlite3'); require('mssql/msnodesqlv8'); console.log('módulos nativos OK')"
Write-Host "Release lista en .\release. Compile installer\lefort.iss con Inno Setup."
