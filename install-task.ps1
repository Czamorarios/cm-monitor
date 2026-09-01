# install-task.ps1 — registra cm-monitor en el Programador de tareas de Windows
#
#   .\install-task.ps1                 instala: revision cada 5 min + reporte diario 8:00
#   .\install-task.ps1 -Minutos 10     cambia la frecuencia
#   .\install-task.ps1 -Desinstalar    quita las tareas
#   .\install-task.ps1 -Estado         muestra si estan activas y cuando corrieron
#
# Las tareas corren cuando tu usuario esta con sesion iniciada. Para monitoreo 24/7
# aunque la laptop este apagada, la Fase 4 mueve esto mismo a GitHub Actions.

param(
  [int]$Minutos = 5,
  [switch]$Desinstalar,
  [switch]$Estado
)

$ErrorActionPreference = 'Stop'
$Raiz = $PSScriptRoot
$TareaMonitor = 'CMillonario - Monitoreo'
$TareaReporte = 'CMillonario - Reporte diario'

function Get-NodePath {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { throw "No encuentro node.exe en el PATH. Instala Node.js o abre una terminal nueva." }
  return $n.Source
}

if ($Estado) {
  foreach ($t in @($TareaMonitor, $TareaReporte)) {
    $tarea = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if (-not $tarea) { Write-Host "  [ausente] $t" -ForegroundColor DarkGray; continue }
    $info = Get-ScheduledTaskInfo -TaskName $t
    $color = if ($tarea.State -eq 'Ready' -or $tarea.State -eq 'Running') { 'Green' } else { 'Yellow' }
    Write-Host ("  [{0}] {1}" -f $tarea.State, $t) -ForegroundColor $color
    Write-Host ("     ultima corrida: {0}   resultado: {1}   proxima: {2}" -f $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime) -ForegroundColor DarkGray
  }
  return
}

if ($Desinstalar) {
  foreach ($t in @($TareaMonitor, $TareaReporte)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Write-Host "  Quitada: $t" -ForegroundColor Yellow
    }
  }
  Write-Host "`n  Listo. El monitoreo automatico esta apagado.`n"
  return
}

$node = Get-NodePath
Write-Host "`n  Node:      $node"
Write-Host "  Carpeta:   $Raiz"
Write-Host "  Frecuencia: cada $Minutos minutos`n"

# ── Tarea 1: revision cada N minutos ──────────────────────────────────────────
$accion = New-ScheduledTaskAction -Execute $node -Argument 'monitor.mjs' -WorkingDirectory $Raiz
$disparador = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $Minutos) `
  -RepetitionDuration ([TimeSpan]::MaxValue)
$opciones = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TareaMonitor -Action $accion -Trigger $disparador `
  -Settings $opciones -Description "Revisa que cmillonario.com y su backend esten funcionando. Solo lectura." -Force | Out-Null
Write-Host "  Registrada: $TareaMonitor" -ForegroundColor Green

# ── Tarea 2: reporte diario a las 8:00 ────────────────────────────────────────
$accion2 = New-ScheduledTaskAction -Execute $node -Argument 'monitor.mjs --reporte' -WorkingDirectory $Raiz
$disparador2 = New-ScheduledTaskTrigger -Daily -At '08:00'
Register-ScheduledTask -TaskName $TareaReporte -Action $accion2 -Trigger $disparador2 `
  -Settings $opciones -Description "Resumen de uptime e incidentes de las ultimas 24 h." -Force | Out-Null
Write-Host "  Registrada: $TareaReporte" -ForegroundColor Green

Write-Host "`n  Corriendo una vez para comprobar..." -ForegroundColor DarkGray
Start-ScheduledTask -TaskName $TareaMonitor
Start-Sleep -Seconds 8
Get-ScheduledTaskInfo -TaskName $TareaMonitor | Format-List TaskName, LastRunTime, LastTaskResult, NextRunTime

Write-Host "  LastTaskResult 0 = todo OK   ·   1 = hay algo critico en rojo (el monitor funciono)" -ForegroundColor DarkGray
Write-Host "  Para ver el detalle:  node monitor.mjs" -ForegroundColor DarkGray
Write-Host "  Para el resumen:      node monitor.mjs --reporte`n" -ForegroundColor DarkGray
