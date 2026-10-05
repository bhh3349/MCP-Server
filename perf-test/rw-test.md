# MCP 服务 读写能力实测报告（read_file / write_file / file_hash）

- 时间：2026-10-03（Asia/Shanghai）
- 目标通道：`http://192.168.1.10:64722/mcp/6db67e8271f1484e7e0f3d00bec20644`
- 远程主机：`TOP-091508N04`（Windows，win32/x64，12 代 i5-12400F 12 逻辑核，16177 MB RAM，PowerShell 5.1.28000.2952，Node v22.23.2），服务端根目录 `C:\BHH\MCP-Server`
- 服务端自报身份：`initialize` → `serverInfo {name:"mcp-server", version:"0.1.0"}`（**真实业务名仍未确认**）
- 测试根：`C:\BHH\MCP-Server\perf-test\rw\`
- 待测工具：`write_file`(path/content/expectedHash → bytes+sha256)、`read_file`(path/offset/limit → content/totalLines/truncated)、`file_hash`(→ sha256+bytes)

## 1 结论速览

| 能力 | 判定 | 关键证据 |
| --- | --- | --- |
| 写入 ASCII / 无尾换行 / 空文件 | ✅ 逐字节精确 | 3 个 fixture 回执哈希 = 本地独立复算 |
| 写入多字节 UTF-8（中文）+ 4 字节 emoji | ✅ 逐字节精确 | `cjk.txt` 44 B，哈希一致 |
| 写入 CRLF / LF / 混合换行 | ✅ 不归一化 | 服务端生成 `crlf2.txt`/`mix.txt`，hex 级一致 |
| 写入 UTF-8 BOM | ✅ 保留 | 磁盘前三字节 `ef bb bf`，`bom-copy.txt` 哈希相同 |
| 父目录自动创建 | ✅ | `perf-test/rw/deep/a/b/c.txt` 一次写入成功 |
| 读取换行保真 | ✅ | `crlf2.txt` 读回 `"one\r\ntwo\r\n"` |
| 行分页 | ✅ 精确 | offset 0/10/20 三页首尾相接、无空洞无重叠 |
| 读取二进制 | ⚠️ 有损 | 1 MiB 随机内容 → 满屏 U+FFFD，`totalLines:4095` |
| `expectedHash` 前置条件 | ✅ 真 CAS | 反例被拒且文件未被触碰；争抢恰一赢家 |
| 缺失文件语义 | ✅ 缺失 ≡ 空内容 | 以 `sha256("")` 为前置条件可原子创建 |
| 沙箱边界 | ✅ 限定在服务端根目录 | 越 root 的绝对路径与 `../` 均被拒 |
| 文件工具逃逸 | ❌ 不可 | `path escapes root` |
| `exec` | ❌ 无沙箱 | 任意 PowerShell，配对码仍等同主机控制权 |

一句话：**读写通道是可信的字节级通道（读侧对二进制除外）；真正的风险面在 `exec`，不在文件工具。**

## 2 取证口径（五源交叉，缺一不算）

1. **客户端原样字节** —— 本地 `printf '…' | sha256sum`，字面量与写入内容完全一致
2. **服务端回执哈希** —— `write_file` 返回的 `bytes` + `sha256`
3. **服务端磁盘哈希** —— `file_hash`(MCP) 与 `(Get-FileHash -Algorithm SHA256)`(PowerShell) 两套独立实现
4. **读回内容** —— `read_file` 的返回文本逐字符比对换行与码位
5. **反例** —— 故意传错 `expectedHash`、越界路径、目录路径、缺失路径

> 判据：任何字节级结论必须同时有 1+2（或 1+3）成立。不采信目视渲染，也不拿不同语言库的行为互相推断——本报告据此**撤回了两个中间结论**（"CRLF 写入异常"、"目录遍历越狱"）。

## 3 写路径：逐条字节级对照（共 18 个 fixture）

| fixture（相对 `perf-test/`） | 字节 | 服务端 sha256（前 12） | 本地独立复算 | 判定 |
| --- | --- | --- | --- | --- |
| `rw/lf.txt` | 17 | `4fdbc441ea7b` | 一致 | ✅ |
| `rw/crlf.txt` | 8 | `c3f9c8c283a2` | 不一致 | ⚠️ 见 §3.1 |
| `rw/nonl.txt`（无尾换行） | 24 | `bb3082b8d80d` | 一致 | ✅ |
| `rw/cjk.txt`（中文+🚀） | 44 | `fa7df2f1ffc3` | 一致 | ✅ |
| `rw/empty.txt` | 0 | `e3b0c44298fc` | 一致 | ✅ |
| `rw/deep/a/b/c.txt` | 5 | `64896f89fd11` | 一致 | ✅ 父目录自动创建 |
| `rw/cas.txt` | 7 | `486ddc9b8156` | 一致 | ✅ CAS 被拒后仍未变 |
| `rw/crlf2.txt`（服务端生成） | 10 | `6f4792b265fe` | 一致 | ✅ hex `6f 6e 65 0d 0a 74 77 6f 0d 0a` |
| `rw/lf2.txt`（服务端生成） | 8 | `c3f9c8c283a2` | 一致 | ✅ hex `6f 6e 65 0a 74 77 6f 0a` |
| `rw/mix.txt`（混合换行） | 9 | `01d51db6c538` | 一致 | ✅ hex `61 0d 0a 62 0a 63 0d 0a 64` |
| `rw/bom.txt` | 8 | `7f8b1909a6e7` | 一致 | ✅ 前三字节 `ef bb bf` |
| `rw/bom-copy.txt`（服务端 Copy-Item） | 8 | `7f8b1909a6e7` | 一致 | ✅ 与 bom.txt 同哈希 |
| `rw/page30.txt` | 231 | `a328ec5f9c28` | 一致 | ✅ 30 行重建 |
| `rw/big-1mb.bin` | 1048576 | `68363f11dba5` | 双实现互证 | ✅ MCP `file_hash` == `Get-FileHash` |
| `rw/abs-inside.txt`（绝对路径·root 内） | 4 | `dae00478f0c2` | 一致 | ✅ |
| `rw/cas2.txt`（CAS 赢家） | 9 | `060f3f47ca94` | 一致 | ✅ |
| `rw/missing-precondition.txt` | 17 | `2ab0b7decc9b` | 一致 | ✅ 缺失≡空 |
| `escape-attempt.txt`（root 内归一化） | 4 | `4bafe3aef45e` | 一致 | ✅ 未离开 root |

### 3.1 `crlf.txt` 为何"不一致"——已定案，服务端无过

该文件由**我经 `write_file` 通道**写入"两行 CRLF"文本，但磁盘结果是 `sha256("one\ntwo\n") = c3f9c8c283a2…`，即 **CR 在客户端工具调用序列化阶段被吞掉，从未到达服务端**。
证明不是服务端问题：服务端本地生成的 `crlf2.txt`（同样两行 CRLF）= 10 B / `6f4792b2…`，与本地独立计算的 CRLF 字节**完全一致**。
→ 结论：服务端 I/O 逐字节忠实；**要造 CRLF/BOM 这类字节敏感内容，应在服务端生成后再校验**，不要依赖客户端 JSON 字符串承载 CR。

## 4 读路径

### 4.1 换行与编码保真
- `crlf2.txt` → `content: "one\r\ntwo\r\n"`，`totalLines: 3` → **CRLF 原样返回，不做归一化**
- `mix.txt` → `content: "a\r\nb\nc\r\nd"`，`totalLines: 4` → 混合换行逐字节保真
- `cjk.txt` → 中文与 4 字节 emoji 完好
- 结论：读写两侧均**不做换行归一化、不追加 BOM、不剥离 BOM**

### 4.2 BOM 行为（含明确的不确定度）
- 磁盘事实：`bom.txt` 8 B，前三字节 `ef bb bf`
- **不做 BOM 探测**的 UTF-8 解码器（`.NET Encoding.UTF8.GetString`，语义等同 Node `fs.readFileSync(p,'utf8')`）→ 首字符码位 **65279 / U+FEFF**，字符长度 6
- **做 BOM 探测**的解码器（`.NET File.ReadAllText`）→ 首字符码位 `97`（`'a'`），字符长度 5
- `read_file` 返回内容中 `alpha` 前可见一个额外码位，与前者一致
- **不确定度（如实标注）**：`read_file` 只返回文本、没有字节视图，我**无法在该工具 API 内对这个码位做字节级断言**；上述是"观测 + 同语义解码器互证"，不是端到端字节证明。凡涉及 BOM 的断言一律以 `file_hash` 为准。
- 工程结论：**按"BOM 会以 U+FEFF 出现在读回内容首字符"防御**，下游解析前先剥。

### 4.3 行分页语义
- `offset` 是 **0 基行偏移**，`limit` 是行数上限（工具声明 ≤2000）
- `page30.txt`（30 行 + 末尾换行）→ `totalLines: 31`
- `offset=0/10/20` + `limit=10` → `line 1..10` / `line 11..20` / `line 21..30`：**首尾相接、无空洞、无重叠**，三页均 `truncated: true`（后面还有内容）
- `offset=100`（越界）→ `content: ""`、`truncated: false`
- `totalLines` = 以 `\n` 切分的段数，**末尾换行会多出一个空段**：`lf.txt`(2 行+\n)=4、`cas2.txt`("winner-A\n")=2、`empty.txt`=1

### 4.4 二进制内容
- `big-1mb.bin`（1048576 B 随机）→ `totalLines: 4095`、`content` 满屏 U+FFFD 替换字符、`truncated: true`
- **`read_file` 是纯文本通道，二进制必然有损，不可用于二进制校验**；字节一致性只能用 `file_hash`

### 4.5 错误面

| 用例 | 返回 |
| --- | --- |
| `file_hash` 不存在的路径 | `Error: ENOENT: no such file or directory, open 'C:\BHH\MCP-Server\perf-test\rw\definitely-not-here.txt'` |
| `file_hash` 传目录 | `Error: EISDIR: illegal operation on a directory, read` |
| `read_file` 传目录 | `Error: EISDIR: illegal operation on a directory, read` |
| `read_file` 绝对路径·root 外 | `Error: path escapes root: C:/Windows/System32/drivers/etc/hosts` |
| `write_file` 绝对路径·root 外 | `Error: path escapes root: C:/Windows/Temp/escape-abs.txt` |
| `write_file` 越 root 的 `../` | `Error: path escapes root: perf-test/rw/../../../escape2.txt` |

## 5 `expectedHash` 是真前置条件（CAS），不是写后检查

1. **反例被拒且文件未被触碰**：对 `cas.txt` 传 `expectedHash=0000…0` → `Error: stale-file: expected 000000000000…, got 486ddc9b8156…`；随后 `file_hash` 仍为 `486ddc9b…` / 7 B → **写入根本没有发生**，不是"写完再回滚"。
2. **缺失文件 ≡ 空内容**：对新路径传 `expectedHash=sha256("")=e3b0c44298fc…` → **写入成功**（17 B / `2ab0b7de…`）。可直接用作**原子 create-if-absent**。
3. **争抢恰一赢家、无丢失更新**：对 `cas2.txt`（当前 `4a668941…`）同时发起两笔写，内容分别为 `winner-A\n` 与 `winner-B\n`，`expectedHash` 相同 →
   - 1 笔成功：`cas2.txt` = 9 B / `060f3f47ca94…`
   - 1 笔失败：`Error: stale-file: expected 4a6689419b00…, got 060f3f47ca94…`（失败方拿到的是**新鲜**哈希）
   - 最终磁盘 `file_hash` = `060f3f47…`、`read_file` = `"winner-A\n"`，本地复算 `sha256("winner-A\n")` 完全一致；而 `sha256("winner-B\n")=b0508ddb5dc4…` **从未落地**
   - **边界**：本客户端的前台工具调用被逐笔串行化（详见并发报告），所以这是**串行争抢**。真并发争抢**未实测**。

## 6 沙箱边界（本次更正的核心）

- 根目录：`C:\BHH\MCP-Server`
- root 内 `..` 归一化：允许。`perf-test/rw/../../escape-attempt.txt` 落在 `C:\BHH\MCP-Server\escape-attempt.txt`（4 B / `4bafe3ae…`），且 `C:\BHH` 下 **0 个** escape 文件 → **是归一化，不是逃逸**
- 越出 root 的 `..`：拒绝（`perf-test/rw/../../../escape2.txt` → `path escapes root`）
- 绝对路径 root 内：允许（回执归一化为相对路径 `perf-test\rw\abs-inside.txt`）
- 绝对路径 root 外：拒绝
→ **文件工具被限定在服务端根目录内。但 `exec` 没有任何沙箱，仍可执行任意 PowerShell。**

## 7 未测项（明确边界，不含糊）

- 真并发下 `write_file` 的原子性与 CAS 互斥（受前台调用串行化限制）
- `write_file` 实现声明为 temp+rename 原子替换，但**真并发原子性未实测**
- 大载荷 `write_file`（受我自身上下文预算限制；1 MiB 文件由服务端 `exec` 生成，未走 `write_file` 通道）
- >1 MiB 文件的分页、长时稳定性、句柄泄漏
- NTFS 只读文件、被占用文件、权限不足等系统错误面

## 8 对 `report.md` 第 10 节的更正

原结论"配对码 ⇒ 主机文件无限制读写"**对文件工具不成立，予以撤回**：`read_file`/`write_file`/`file_hash` 均被限制在服务端根目录内，越界路径返回 `path escapes root`，目录返回 `EISDIR`。
但"配对码 ⇒ 主机控制权"整体**仍然成立**，路径是 `exec`（任意 PowerShell、无沙箱），而不是文件工具。

## 9 复现要点

- 字节敏感内容一律**服务端生成**再校验：
  `[IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($false)))`（无 BOM）/ `UTF8Encoding($true)`（带 BOM）
  `[IO.File]::WriteAllBytes($p,$bytes)`（二进制）
- 本地独立复算：`printf '…' | sha256sum`
- 服务端打印三元组：`$_.Length`、`(Get-FileHash $p -Algorithm SHA256).Hash.ToLower()`、`(($b|%{$_.ToString('x2')}) -join ' ')`
- 控制台是 GBK，中文**显示**会乱码，但磁盘字节不受影响；判断编码一律看字节，不看渲染

## 10. 大文件读写补测（2026-10-03 追加）

补测动机：§7 自陈"大文件未实测、1 MiB 文件由 `exec` 生成而非 `write_file` 通道"。本轮补齐，结论已并入 `results-rw.json#large_file_suite`。

### 10.1 读路径（服务端生成定宽文本，行宽 49 B）

| 文件 | 字节 | 内容行 | 尾换行 | sha256 | `read_file.totalLines` |
| --- | --- | --- | --- | --- | --- |
| `big-text-1mb.txt` | 980000 | 20000 | 有 | `6ad3e12536210b45e8e4c5bdbff0fe4be8567b60b9d693e5932dedd279752961` | 20001 |
| `big-text-5mb.txt` | 4900000 | 100000 | 有 | `4b1bb6d85538af20eb4aa47b19a4397f3836ba24061c2b381d5556132432b130` | 100001 |
| `big-text-1mb-nonl.txt` | 979999 | 20000 | 无 | `093791e18cbd47ab99496c8b589f5642b57750ddfeecacfd615625654c798b3d` | 20000 |

- 5 MB 规模分页精确：`offset=0` → `L0000000/L0000001`；`offset=50000` → `L0050000/L0050001`；`offset=99999` → 仅 `L0099999` 且 `truncated=false`。行名即行号（从 0 起），零错位。
- §4.3 的 `totalLines` 语义在 10 万行规模复现：有尾换行 → 末空段计入（100001）；无尾换行 → 不计（20000）。
- `file_hash` 对 4900000 B 返回 `4b1bb6d85538…`，与 PowerShell `Get-FileHash` 完全一致。
- 生成吞吐：4900000 B / 0.077 s ≈ 63.6 MB/s（服务端磁盘 + StringBuilder）。
- .NET `ReadAllLines` 独立实现给出 100000 行，与生成意图一致。

### 10.2 写路径（在大文件上执行写操作）

- **CAS 命中于 980000 B 文件**：`expectedHash=6ad3e125…` 命中后写入成功 —— 说明服务端为校验前置条件确实哈希了整个约 1 MB 文件。
- **截断正确**：写入后 `bytes=7936`，全文既无 `-`（原 40 字符填充）残留、也无 `L0000000` 残留，旧 980000 B 尾部被完整丢弃。
- **字节精确**：独立重建 124 行 × 64 B = 7936 B，sha256 `3032375166eb13d4088c46d1d239f50185b6b358e3fc3748617bda8ee43f004f`，与回执哈希逐字相等，逐行等于单元串。
- **过期 CAS 于 4900000 B 文件被拒**：`Error: stale-file: expected 000000000000…, got 4b1bb6d85538…`；事后该文件 `bytes=4900000`、sha256 仍为 `4b1bb6d8…`，**完全未变**。
- 载荷上限未被触及：7936 B 一次性通过。真正的上限是调用方（agent）必须逐字发射载荷的上下文预算，与 MCP 服务端无关。

### 10.3 已知失误（自陈）

本次意图写入 8192 B（128 行 × 64 B），实际发射 124 行 = 7936 B。回执 `bytes` 与独立重建共同暴露该计数失误；**通道本身无丢字节**。属发射端人工计数缺陷，非服务端缺陷。

### 10.4 仍未测

- `write_file` 载荷的更大规模（16 KB / 64 KB / 1 MB）：受调用方上下文预算限制，未测。
- 真并发下大文件的原子替换与争抢：前台调用被串行化，未测。

### 10.5 对前文的更正

§7「未测项」中"大文件未实测、1 MiB 文件由 `exec` 生成而非 `write_file` 通道"一条自本节起作废：大文件读（5 MB 分页精确）与大文件写（约 1 MB 文件上 CAS 命中、覆盖截断、4900000 B 文件上过期 CAS 被拒且文件未变）均已实测，证据见 §10.1–§10.2。`results-rw.json#limitations` 中同名条目已同步改写为"8 KB 以上载荷未测（受调用方上下文预算限制）"。
