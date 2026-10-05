# MCP Server 性能与并发实测报告

- 被测服务：`mcp-server v0.1.0`（MCP Streamable HTTP，单会话配对码信道）
- 端点：`http://192.168.1.10:64722/mcp/6db67e8271f1484e7e0f3d00bec20644`
- 远端主机：Windows `TOP-091508N04` / win32 x64 / 12th Gen Intel i5-12400F（12 逻辑核）/ 16177 MB RAM / PowerShell 5.1.28000.2952 / Node v22.23.2
- 测试目录：`C:\BHH\MCP-Server\perf-test\`（`logs\`、`payload\`）
- 测量时间：2026-10-03 20:54 – 21:01 (+08:00)

---

## 1. 结论先行

| # | 结论 | 关键证据 |
|---|---|---|
| 1 | **服务端并发能力没问题**：实测 20 个任务真并行，加速比 17.95× | 20/20 区间重叠，跨度 8.987s vs 串行等效 161.344s |
| 2 | **串行发生在调用方，不在服务端** | 8 秒后台任务在飞时，服务端仍服务了 9 个前台调用；`fg` 在后台派发后 **36ms** 即执行 |
| 3 | 前台「同批次连发」被**严格串行**，零重叠 | 6×2s 前台：跨度 13.497s、`max_concurrent_overlap=1`，甚至**慢于**同进程串行的 12.096s |
| 4 | 单次「跑完型」调用有 **≈0.275s 固定地板价** | 探针间隔 0.264–0.290s（均值 0.275s） |
| 5 | 地板价拆解：**PowerShell 冷启动占 0.118s** | 精确 `Process.Start+WaitForExit` 5 次：0.134/0.111/0.115/0.115/0.116s；`cmd.exe` 仅 0.009s |
| 6 | 空载往返（不等待执行）**≈47–50ms** | 20 次后台派发全部落在 0.948s 内 |
| 7 | **想并发就用 `background:true`** | 6 并发 5.72×、20 并发 17.95×，且 `dur` 无排队劣化 |

一句话：**这个 MCP 服务端能打，瓶颈在调用方工具执行层的串行调度；绕过方式是把调用以 background 方式派发。**

---

## 2. 方法：为什么必须用服务端自计时

跨消息在客户端计时是**无效**的：每两个工具调用之间都夹着模型推理延迟（秒级），远大于被测服务毫秒级差异，会把结论完全淹没。

因此本测试让**每个被执行的命令自己写时间戳**：

```powershell
$s = Get-Date; Add-Content '<log>' ("start " + $s.ToString('o'))
Start-Sleep -Seconds N
$e = Get-Date; Add-Content '<log>' ("end   " + $e.ToString('o'))
```

- 单次服务时间 = `end - start`（实测在远端时钟内完成，不含推理延迟）
- 并发度 = 各文件区间 `[start, end]` 的**最大重叠数**（扫描线算法）
- 判定串行 = 批次跨度 ≈ K×D + K×间隙（而非 ≈ D）

所有并发/耗时计算**只使用远端单一时钟**，因此不受两端时钟偏差影响（两端均为 +08:00，粗比偏差在 1s 量级内，对本报告无影响）。

---

## 3. 前台调用：严格串行

同一批次连发 6 个 `exec`，每个执行 `Start-Sleep -Seconds 2`。

| 序号 | start | end | 服务时间 (s) |
|---|---|---|---|
| conc_1 | 20:54:32.1418854 | 20:54:34.1700098 | 2.028 |
| conc_2 | 20:54:34.4297378 | 20:54:36.4674222 | 2.038 |
| conc_3 | 20:54:36.7009470 | 20:54:38.7475660 | 2.047 |
| conc_4 | 20:54:39.0070911 | 20:54:41.0469034 | 2.040 |
| conc_5 | 20:54:41.3069757 | 20:54:43.3434239 | 2.036 |
| conc_6 | 20:54:43.6039454 | 20:54:45.6386687 | 2.035 |

- 首次 start `20:54:32.1418854` → 末次 end `20:54:45.6386687`，**跨度 13.497s**
- **`max_concurrent_overlap = 1`（6 个任务零重叠）**
- 相邻间隙：0.260 / 0.233 / 0.260 / 0.260 / 0.260 s

对照（同一 `exec` 进程内串行跑 6×2s）：跨度 **12.096s / 12.111s**。

> 名义「并行」的批量派发（13.497s）比真正的串行（12.096s）**还慢 1.4s** —— 6 次调用的调度开销白付了，并发收益为零。

---

## 4. 并发证明（一）：后台任务 + 前台调用可同时存活

一次 8 秒后台 `exec` 派发后，立即发起 1 个前台调用与 8 个最小探针：

- `bg_start 2026-10-03T20:56:17.2220172+08:00`
- `bg_end   2026-10-03T20:56:25.2518417+08:00`（bg 跨度 **8.030s**）
- `fg_after_bg_dispatch 2026-10-03T20:56:17.2580187+08:00` → **后台派发后仅 36ms**
- 8 个探针时间戳：17.536 / 17.825 / 18.089 / 18.361 / 18.635 / 18.909 / 19.190 / 19.457
  - 全部 **< bg_end**（最后一个距 bg_start 仅 2.235s）→ 后台任务在飞行中，服务端同时服务了这些请求

**探针间隔：0.264 / 0.272 / 0.274 / 0.275 / 0.281 / 0.267 s，均值 ≈0.275s** —— 这就是「跑完型」调用的固定地板价（不含任何 sleep 成分）。

---

## 5. 并发证明（二）：后台派发真并发

### 5.1 6 × 3s

| 任务 | start | end | dur (s) |
|---|---|---|---|
| par_bg_2 | 20:57:17.142 | 20:57:20.192 | 3.050 |
| par_bg_1 | 20:57:17.143 | 20:57:20.192 | 3.049 |
| par_bg_3 | 20:57:17.201 | 20:57:20.240 | 3.039 |
| par_bg_4 | 20:57:17.215 | 20:57:20.256 | 3.042 |
| par_bg_5 | 20:57:17.226 | 20:57:20.272 | 3.046 |
| par_bg_6 | 20:57:17.252 | 20:57:20.288 | 3.036 |

- 6 个 start 全落在 **110ms** 内；批次跨度 **3.146s**（串行等效 18s+）
- **`max_concurrent_overlap = 6 / 6`**，加速比 **5.72×**

### 5.2 20 × 8s（天花板测试）

| 指标 | 值 |
|---|---|
| 派发成功数 | **20 / 20**（无拒绝、无并发上限） |
| start 跨度 | **0.948s**（20 个 start 全部落在此窗口） |
| 批次跨度 | **8.987s** |
| `max_concurrent_overlap` | **20 / 20** |
| 串行等效总时长 | 161.344s |
| **并行加速比** | **17.95×** |
| 单任务 dur 区间 | 8.030 – 8.106s（离散度极低） |

关键点：**单个任务耗时没有随并发数增长**（8.03–8.11s，全部 ≈ 8s + 50ms 开销）→ 无排队、无线程饥饿、无锁竞争。20 个 PowerShell 进程同时在 12 逻辑核上跑，scheduler 压力可接受。

---

## 6. 固定成本拆解

| 成分 | 实测 | 方法 |
|---|---|---|
| 空载 MCP 往返（不等待执行） | **≈47–50ms** | 20 次后台派发 / 0.948s |
| PowerShell 冷启动 | **0.118s**（0.111–0.134） | `[Diagnostics.Process]::Start` + `WaitForExit` ×5 |
| 参考：`cmd.exe /c exit` | 0.009s | 同上 ×5 |
| 脚本执行 + 结果回传 (SSE) | ≈0.10s | 0.275 − 0.118 − 0.05 |
| **「跑完型」调用总价** | **≈0.275s** | 探针间隔法 |

> 方法论坑：用 `Start-Process -Wait` 测同一件事得到 **1.029s**，是测量工具自身的开销假象，不是真实启动成本。必须用 `[Diagnostics.Process]::Start`。

---

## 7. 数据面：读写与完整性

| 项 | 结果 |
|---|---|
| `write_file` 1168 B | 成功，回执含 `bytes` + `sha256` (`dea5e81b…eacf`) |
| `write_file` 4672 B | 成功，`sha256` `d9f43338…7f2b`，事后 `file_hash` 复核一致 |
| `read_file`（1 KB 文件，limit=4） | 按**行**分页：`totalLines` / `truncated: true`；**非按字节区间读取** |
| 磁盘写 1 MB（远端本地） | 0.003s → **305.7 MB/s**（页缓存内） |
| SHA-256 1 MB | 0.057s |
| 交错探针 → `rtt_probe`/`rtt_8` 时间戳落在同一 100ns tick | 时钟更新粒度边界，非异常 |

**吞吐结论**：KB 级 payload 的传输时间被 0.275s 地板价完全淹没，**吞吐不是本场景瓶颈**；真正的优化对象是「减少调用次数」和「把调用改成后台派发」。

---

## 8. 复现方式

| 文件 | 用途 |
|---|---|
| `perf-test/run-concurrency.ps1` | `-Mode parallel\|sequential -Index N -SleepSeconds S`，写 `logs\conc_N.txt` / `logs\seq_K.txt` |
| `perf-test/logs/*.txt` | 原始时间戳证据（conc / seq / rtt / par_bg / c20 / bg） |
| `perf-test/payload/*.txt` | 1 KB / 4 KB payload 完整性样本 |
| `perf-test/results.json` | 本节全部数字的机器可读版本 |

调用约定：`& .\perf-test\run-concurrency.ps1`（用 `&` 调用，勿 dot-source）。

---

## 9. 局限与诚实声明

1. **跨消息客户端计时无效**，本报告全部耗时来自远端自计时；客户端侧无法给出可信的端到端延迟。
2. **payload 测试上限 1 KB / 4 KB**：大文件回传会挤占调用方上下文，MB 级数据只在远端本机生成并测量，未走 MCP 传输。
3. **未测长时间稳定性**：单次会话观测窗口约 7 分钟（`uptimeSec` 830 → 912 证明始终是同一活会话），未做数小时压测、内存泄漏或句柄泄漏观测。
4. **未触及服务端内部**：并发结论基于外部可观测的时间戳重叠，未读取服务端调度代码，因此「串行在调用方工具执行层」是基于证据的推断（`dsh-mcp-client` 的 `call` 路径无调用级互斥，见 `lib/index.js:140` 直接 `client.callTool(...)`），而非逐行代码证明。
5. **20 并发是已验证下限，不是上限**：20 个全部成功不代表 100 个也能；上限测试需另批。
6. 两端时钟仅做了粗对齐（≈1s 量级不确定度），未做精确 NTP 级标定。

## 10. 安全提示（重要）

该服务端向任何持有配对码的调用方开放：**任意 PowerShell 命令执行、任意文件读写（`danger-full-access` 语义）**，作用域为 `TOP-091508N04`。配对码 = 完整主机控制权。请勿将本 URL 写入共享文档、日志或代码仓库；轮换后旧码立即失效。

---

## 11. Read/Write capability suite (added 2026-10-03)

Full report: `perf-test/rw-test.md`; machine-readable: `perf-test/results-rw.json`; fixtures: `perf-test/rw/`.

CORRECTION to section 10 (Security): the file tools read_file / write_file / file_hash ARE
sandboxed to the server root. Absolute paths and ../ traversal that leave C:\BHH\MCP-Server
are rejected with "path escapes root: <path>"; reading a directory returns EISDIR. The earlier
statement "unrestricted file read/write on the host" was WRONG and is retracted here. exec still
runs arbitrary PowerShell with no sandbox, so the pairing code still equals host control -
via exec, not via the file tools.

Verified byte-exact write/read for: ASCII, LF, CRLF, mixed CRLF/LF, multi-byte UTF-8 + emoji,
UTF-8 BOM, empty file, no-trailing-newline file, deep auto-created directories, and a 1 MiB
binary blob (by hash). expectedHash is a real compare-and-swap precondition (stale -> rejected,
file untouched; a missing file is treated as empty content, which gives an atomic
create-if-absent). read_file is line-paged, text-only (binary is lossily decoded), and does not
normalize newlines.
