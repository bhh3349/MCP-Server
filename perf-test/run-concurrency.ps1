# MCP-Server 并发探针（可复现脚本） 2026-10-03 / DSH profile web
# 目的: 判定 MCP 单会话信道能否并发承载多条工具调用，以及服务端是否串行化。
#
# 并行组: 在“同一条消息(同一批次)”内并发发起 6 次 exec，index 取 1..6：
#   & .\perf-test\run-concurrency.ps1 -Mode parallel -Index 1
# 控制组: 单次 exec 顺序跑 6 个 sleep（总时长应为 6 x SleepSeconds）：
#   & .\perf-test\run-concurrency.ps1 -Mode sequential
#
# 判读: 每条调用把自身 start/end 写入 perf-test/logs/<name>.txt（绝对时间，本机时钟）。
#   并行组 start..end 区间互相重叠 且 跨度约等于 SleepSeconds  => 信道支持真并发
#   区间首尾相接无重叠 / 跨度约等于 6 x SleepSeconds           => 服务端串行化(队列)
param(
  [ValidateSet('parallel','sequential')][string]$Mode = 'parallel',
  [int]$Index = 0,
  [int]$SleepSeconds = 2
)
$dir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

if ($Mode -eq 'parallel') {
  $s = Get-Date
  Add-Content (Join-Path $dir "conc_$Index.txt") ("start " + $s.ToString('o'))
  Start-Sleep -Seconds $SleepSeconds
  $e = Get-Date
  Add-Content (Join-Path $dir "conc_$Index.txt") ("end   " + $e.ToString('o'))
  "conc_$Index serviceSec=" + [math]::Round(($e - $s).TotalSeconds, 3)
}
else {
  for ($k = 1; $k -le 6; $k++) {
    $s = Get-Date
    Add-Content (Join-Path $dir "seq_$k.txt") ("start " + $s.ToString('o'))
    Start-Sleep -Seconds $SleepSeconds
    $e = Get-Date
    Add-Content (Join-Path $dir "seq_$k.txt") ("end   " + $e.ToString('o'))
  }
  'sequential 6x done'
}
