# Instalador de ACP v2 para OpenCode V2 (Windows)
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Destination "D:\otra\ruta"
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkipTests -Force
#
# Copia el plugin a %USERPROFILE%\.config\opencode\plugins\acp-v2, que OpenCode V2
# descubre solo. No modifica opencode.json.

[CmdletBinding()]
param(
    [string]$Destination,
    [switch]$SkipTests,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$source = $PSScriptRoot
$configDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".config\opencode" }
if (-not $Destination -or $Destination.Trim() -eq "") {
    $Destination = Join-Path $configDir "plugins\acp-v2"
}

Write-Host ""
Write-Host "ACP v2 - instalador" -ForegroundColor Cyan
Write-Host "  origen:      $source"
Write-Host "  destino:     $Destination"
Write-Host ""

# 1. Comprobaciones previas.
$required = @("index.js", "package.json", "lib\config.js", "lib\prune.js", "lib\registry.js", "lib\tool.js", "lib\util.js")
foreach ($file in $required) {
    if (-not (Test-Path (Join-Path $source $file))) {
        throw "Falta $file. Ejecuta este script desde la carpeta del plugin."
    }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Warning "No encontre node en PATH. Las pruebas se omiten; el plugin no lo necesita para correr."
    $SkipTests = $true
}

# 2. Pruebas.
if (-not $SkipTests) {
    Write-Host "Ejecutando pruebas..." -ForegroundColor Yellow
    Push-Location $source
    try {
        & node --test "test/*.test.js"
        if ($LASTEXITCODE -ne 0) {
            if (-not $Force) { throw "Las pruebas fallaron. Usa -Force para instalar igual." }
            Write-Warning "Pruebas fallidas, continuo por -Force."
        }
    }
    finally {
        Pop-Location
    }
}

# 3. Copia con respaldo.
if (Test-Path $Destination) {
    $backup = "$Destination.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Write-Host "Respaldo de la version anterior en: $backup" -ForegroundColor DarkGray
    Move-Item -Path $Destination -Destination $backup -Force
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Copy-Item -Path (Join-Path $source "index.js") -Destination $Destination -Force
Copy-Item -Path (Join-Path $source "package.json") -Destination $Destination -Force
foreach ($extra in @("README.md", "acp.jsonc")) {
    $path = Join-Path $source $extra
    if (Test-Path $path) { Copy-Item -Path $path -Destination $Destination -Force }
}
Copy-Item -Path (Join-Path $source "lib") -Destination (Join-Path $Destination "lib") -Recurse -Force

$files = Get-ChildItem -Recurse -File $Destination
Write-Host ""
Write-Host ("Instalado: {0} archivos, {1:N0} KB" -f $files.Count, (($files | Measure-Object Length -Sum).Sum / 1KB)) -ForegroundColor Green
Write-Host ""
Write-Host "Siguientes pasos:" -ForegroundColor Cyan
Write-Host "  1. Reinicia OpenCode (o abre una sesion nueva)."
Write-Host "  2. Comprueba que cargo:"
Write-Host "     opencode plugin list"
Write-Host "  3. Revisa el log si algo falla:"
Write-Host "     Select-String -Path `"`$env:USERPROFILE\.local\share\opencode\log\opencode.log`" -Pattern 'acp-v2|failed to load plugin' | Select-Object -Last 5"
Write-Host "  4. En una sesion, pide al agente: context_prune action=list"
Write-Host ""
Write-Host "Configuracion opcional: copia acp.jsonc a la carpeta de config de OpenCode" -ForegroundColor DarkGray
Write-Host "  (global: $configDir\acp.jsonc  |  proyecto: <proyecto>\.opencode\acp.jsonc)" -ForegroundColor DarkGray
Write-Host ""
