# bench-host.ps1 - host-level concurrency & baseline cost benchmark (re-runnable, no MCP client needed)
# Usage: & .\perf-test\bench-host.ps1 -N 20 -SleepSeconds 3
param(
  [int]$N = 20,
  [int]$SleepSeconds = 3,
  [string]$OutDir = (Join-Path $PSScriptRoot 'logs')
)

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

Write-Host "== host baseline =="
$samples = @()
for ($i = 0; $i -lt 5; $i++) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'; $psi.Arguments = '-NoProfile -NonInteractive -Command exit'; $psi.UseShellExecute = $false
  $sw = [Diagnostics.Stopwatch]::StartNew(); $p = [Diagnostics.Process]::Start($psi); $p.WaitForExit(); $sw.Stop()
  $samples += $sw.Elapsed.TotalSeconds
}
$spawn = ($samples | Measure-Object -Average).Average
"powershell_cold_start_avg_sec = {0:N3}" -f $spawn
"logical_cores = {0}" -f (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
"ram_MB = {0:N0}" -f ((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)

Write-Host "== $N parallel children, each ${SleepSeconds}s =="
$files = @(); $procs = @()
$t0 = Get-Date
for ($i = 1; $i -le $N; $i++) {
  $log = Join-Path $OutDir ("bench_{0:d2}.txt" -f $i)
  if (Test-Path $log) { Remove-Item $log -Force }
  $files += $log
  $cmd = "`$s=Get-Date; Add-Content -LiteralPath '$log' ('start ' + `$s.ToString('o')); Start-Sleep -Seconds $SleepSeconds; `$e=Get-Date; Add-Content -LiteralPath '$log' ('end   ' + `$e.ToString('o'))"
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'; $psi.Arguments = "-NoProfile -NonInteractive -Command `"$cmd`""; $psi.UseShellExecute = $false
  $procs += [Diagnostics.Process]::Start($psi)
}
"dispatch_span_sec = {0:N3}" -f ((Get-Date) - $t0).TotalSeconds
$procs | ForEach-Object { $_.WaitForExit() }
$t1 = Get-Date
"wall_span_avg_sec = {0:N3}" -f (($t1 - $t0).TotalSeconds)

$rows = foreach ($f in $files) {
  if (Test-Path $f) {
    $c = Get-Content $f
    if ($c.Count -ge 2) {
      [pscustomobject]@{
        file = Split-Path $f -Leaf
        s    = [datetime]::Parse(($c[0] -replace '^start\s+', ''))
        e    = [datetime]::Parse(($c[1] -replace '^end\s+', ''))
      }
    }
  }
}
$rows = $rows | Sort-Object s
"completed_children = {0} / {1}" -f $rows.Count, $N
$events = @(); foreach ($r in $rows) { $events += [pscustomobject]@{ t = $r.s; d = 1 }; $events += [pscustomobject]@{ t = $r.e; d = -1 } }
$cur = 0; $max = 0
foreach ($ev in ($events | Sort-Object t)) { $cur += $ev.d; if ($cur -gt $max) { $max = $cur } }
$first = ($rows | Select-Object -First 1).s
$last = ($rows | Select-Object -Last 1).e
$span = ($last - $first).TotalSeconds
$serialSum = ($rows | ForEach-Object { ($_.e - $_.s).TotalSeconds } | Measure-Object -Sum).Sum
"first_start = {0}" -f $first.ToString('o')
"last_end    = {0}" -f $last.ToString('o')
"span_sec    = {0:N3}" -f $span
"max_concurrent_overlap = {0} / {1}" -f $max, $rows.Count
"serial_equivalent_sec  = {0:N3}" -f $serialSum
"parallelism_factor     = {0:N2}" -f ($serialSum / $span)
