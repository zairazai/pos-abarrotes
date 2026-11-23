# Instala el POS en la PC de la tienda con Docker Compose, de un jalón.
# Uso, en PowerShell desde la carpeta del repositorio:
#   powershell -ExecutionPolicy Bypass -File scripts\instalar.ps1
# Se puede correr las veces que sea: no toca un pos.env que ya exista y solo actualiza los contenedores.

param(
  # Carpeta de la configuración, los respaldos y los reportes.
  [string]$Carpeta = 'C:\POS'
)

$ErrorActionPreference = 'Stop'
$compose = Join-Path $PSScriptRoot '..\docker\docker-compose.yml'
$plantilla = Join-Path $PSScriptRoot '..\docker\pos.env.example'
$archivoEnv = Join-Path $Carpeta 'pos.env'

function Paso($texto) { Write-Host "`n== $texto" -ForegroundColor Cyan }
function Alto($texto) { Write-Host "`n$texto" -ForegroundColor Red; exit 1 }

# Cadena al azar solo con letras y números, para que no haya espacios, comillas ni # en pos.env.
function Aleatorio([int]$bytes) {
  $datos = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($datos)
  return -join ($datos | ForEach-Object { $_.ToString('x2') })
}

# Lee un valor de pos.env (lo que va después del primer =).
function Valor($lineas, $nombre) {
  $linea = $lineas | Where-Object { $_ -match "^$nombre=" } | Select-Object -First 1
  if ($linea) { return $linea.Substring($nombre.Length + 1) }
  return ''
}

# --- 1. Docker ---
Paso 'Revisando Docker Desktop'
# Con cmd, porque en Windows PowerShell redirigir los errores de un programa los vuelve excepciones.
cmd /c 'docker info >nul 2>&1'
if ($LASTEXITCODE -ne 0) { Alto 'Docker Desktop no está encendido. Ábralo, espere a que diga "Engine running" y repita.' }
Write-Host 'Docker responde.'

# --- 2. Carpetas ---
Paso "Preparando $Carpeta"
foreach ($sub in @('', 'respaldos', 'reportes')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Carpeta $sub) | Out-Null
}
Write-Host "Carpetas listas: $Carpeta, respaldos y reportes."

# --- 3. Configuración ---
Paso 'Configuración (pos.env)'
if (Test-Path $archivoEnv) {
  Write-Host 'Ya existe; no se cambia.'
} else {
  # La misma clave para PostgreSQL y para el servidor, y un secreto para las sesiones.
  $clave = Aleatorio 24
  $secreto = Aleatorio 48
  $texto = (Get-Content $plantilla -Raw -Encoding UTF8) `
    -replace 'CAMBIAR-por-una-clave-larga', $clave `
    -replace 'CAMBIAR-por-un-secreto-al-azar', $secreto
  [System.IO.File]::WriteAllText($archivoEnv, $texto, (New-Object System.Text.UTF8Encoding $false))
  Write-Host 'Creado con una clave de base de datos y un secreto de sesión al azar.'
  Write-Host 'Si quiere correo o Telegram, llene SMTP_* y TELEGRAM_TOKEN en ese archivo y repita el script.'
}

# Las dos claves deben ser iguales y sin caracteres que el archivo no acepta.
$lineas = Get-Content $archivoEnv -Encoding UTF8
$pg = Valor $lineas 'POSTGRES_PASSWORD'
$db = Valor $lineas 'DB_CLAVE'
$jwt = Valor $lineas 'JWT_SECRETO'
if ($pg -ne $db) { Alto "En $archivoEnv, POSTGRES_PASSWORD y DB_CLAVE deben ser iguales." }
foreach ($par in @(@('DB_CLAVE', $db), @('JWT_SECRETO', $jwt))) {
  if ($par[1] -match '^CAMBIAR' -or $par[1].Length -lt 16) { Alto "En $archivoEnv, $($par[0]) debe tener al menos 16 caracteres." }
  if ($par[1] -match '[\s"''#]') { Alto "En $archivoEnv, $($par[0]) no debe llevar espacios, comillas ni #." }
}
Write-Host 'Las claves están bien.'

# --- 4. Contenedores ---
Paso 'Construyendo y encendiendo los contenedores (la primera vez tarda unos minutos)'
$env:POS_CARPETA = $Carpeta
docker compose -f $compose up -d --build
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nÚltimas líneas de la API:" -ForegroundColor Yellow
  docker compose -f $compose logs --tail 15 api
  Alto 'No se pudo encender. Si dice "password authentication failed", la base se creó con otra clave: borre la instalación con "docker compose -f docker/docker-compose.yml down -v" (borra los datos) y repita.'
}

# --- 5. Revisión ---
Paso 'Esperando a que la API responda'
$salud = $null
for ($i = 0; $i -lt 30 -and -not $salud; $i++) {
  try { $salud = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/v1/salud' -TimeoutSec 3 } catch { Start-Sleep -Seconds 2 }
}
if (-not $salud) { Alto 'La API no respondió en 1 minuto. Revise con: docker compose -f docker/docker-compose.yml logs api' }
# El worker arranca después de la API; se le dan unos segundos para su primer latido.
for ($i = 0; $i -lt 15 -and $salud.data.servicios.worker -ne 'ok'; $i++) {
  Start-Sleep -Seconds 2
  $salud = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/v1/salud' -TimeoutSec 3
}
$s = $salud.data.servicios
Write-Host "Estado: $($salud.data.estado) (PostgreSQL $($s.postgres), Redis $($s.redis), worker $($s.worker)). Versión $($salud.data.version)."

# --- 6. Arranque automático ---
# Los contenedores se reinician solos (restart: unless-stopped), pero Docker Desktop debe abrir al
# iniciar sesión en Windows. Aquí solo se revisa; el ajuste lo hace el usuario.
$ajustes = @("$env:APPDATA\Docker\settings-store.json", "$env:APPDATA\Docker\settings.json") | Where-Object { Test-Path $_ } | Select-Object -First 1
$auto = $false
if ($ajustes) { $auto = [bool]((Get-Content $ajustes -Raw | ConvertFrom-Json).AutoStart) }
if ($auto) {
  Write-Host 'Docker Desktop abre solo al iniciar Windows: el POS arrancará solo.'
} else {
  Write-Host "`nFalta un ajuste para que el POS arranque solo al prender la PC:" -ForegroundColor Yellow
  Write-Host '  Docker Desktop > Settings > General > "Start Docker Desktop when you sign in to your computer".'
}

Paso 'Listo'
Write-Host 'Documentación de la API: http://localhost:8080/api-docs'
Write-Host "Primer acceso: el Dueño entra con el PIN $(Valor $lineas 'PIN_INICIAL') y el sistema le pide cambiarlo."
Write-Host "Respaldos al cerrar la caja: $Carpeta\respaldos. Para restaurar uno: scripts\restaurar.ps1"
