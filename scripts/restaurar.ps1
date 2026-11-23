# Restaura un respaldo del POS instalado con Docker Compose.
# Uso, en PowerShell desde la carpeta del repositorio:
#   powershell -ExecutionPolicy Bypass -File scripts\restaurar.ps1
#       muestra los respaldos disponibles
#   powershell -ExecutionPolicy Bypass -File scripts\restaurar.ps1 -Archivo pos_2026-11-21_20-15-07_9f2c1a3b.dump -Si
#       detiene la API y el worker, restaura y los vuelve a encender
# Sin -Si no borra nada: solo avisa.

param(
  [string]$Archivo = '',
  [switch]$Si,
  [string]$Carpeta = 'C:\POS'
)

$ErrorActionPreference = 'Stop'
$compose = Join-Path $PSScriptRoot '..\docker\docker-compose.yml'
$respaldos = Join-Path $Carpeta 'respaldos'
$env:POS_CARPETA = $Carpeta

function Alto($texto) { Write-Host "`n$texto" -ForegroundColor Red; exit 1 }

# --- Lista ---
$disponibles = @(Get-ChildItem -Path $respaldos -Filter '*.dump' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
if (-not $Archivo) {
  if ($disponibles.Count -eq 0) { Alto "No hay respaldos en $respaldos. Se generan al cerrar la caja." }
  Write-Host "Respaldos en ${respaldos}, del más reciente al más antiguo:`n"
  $disponibles | ForEach-Object { Write-Host ('  {0}  ({1:N0} KB)' -f $_.Name, ($_.Length / 1KB)) }
  Write-Host "`nPara restaurar uno: scripts\restaurar.ps1 -Archivo <nombre> -Si"
  exit 0
}

$Archivo = Split-Path $Archivo -Leaf
if (-not (Test-Path (Join-Path $respaldos $Archivo))) { Alto "No existe $Archivo en $respaldos." }

# --- Confirmación ---
if (-not $Si) {
  Write-Host "Esto BORRA los datos actuales del POS y los cambia por los de $Archivo." -ForegroundColor Yellow
  Write-Host 'Mientras tanto la tienda no podrá vender. Repita el comando agregando -Si para continuar.'
  exit 1
}

# --- Restauración ---
Write-Host '== Deteniendo la API y el worker'
docker compose -f $compose stop api worker
if ($LASTEXITCODE -ne 0) { Alto 'No se pudieron detener. ¿Está encendido Docker Desktop?' }

# Se usa la misma imagen del servidor, con su pg_restore, en un contenedor de un solo uso.
Write-Host "== Restaurando $Archivo"
docker compose -f $compose run --rm --no-deps api node dist/main-restaurar.js $Archivo --si
$resultado = $LASTEXITCODE

# Pase lo que pase, la tienda vuelve a quedar encendida.
Write-Host '== Encendiendo la API y el worker'
docker compose -f $compose start api worker

if ($resultado -ne 0) { Alto 'La restauración falló; los datos quedaron como estaban (se hace en una sola transacción).' }
Write-Host "`nListo: el POS tiene los datos de $Archivo." -ForegroundColor Green
