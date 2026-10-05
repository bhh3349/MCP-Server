# MCP-Server 连接与读写能力测试报告

| 字段 | 内容 |
| --- | --- |
| 报告版本 | v1.0（2026-10-03 定稿） |
| 被测对象 | 用户自建 MCP Server（Streamable HTTP），13 个工具 / 2 个资源 / 1 个连接器 |
| 接入地址 | `http://192.168.1.10:64722/mcp/6db67e8271f1484e7e0f3d00bec20644` |
| 被测主机 | Windows `TOP-091508N04`，win32/x64，12 逻辑核（12th Gen Intel Core i5-12400F），16177 MB 内存，Node v22.23.2，PowerShell 5.1.28000.2952 |
| 服务根目录 | `C:\BHH\MCP-Server` |
| 客户端 | DSH（DeepSeek Harness）web profile，MCP 客户端插件 `@deepseek-ai/dsh-mcp-client` |
| 取证原则 | 所有结论只采信**服务端自时间戳命令**与**字节级断言**，不采信跨消息的客户端计时 |
| 证据目录 | `C:\BHH\MCP-Server\perf-test\`（`rw-test.md`、`results-rw.json`、`report.md`、`logs\` 52 个、`rw\` 20 个） |

---

## 0. 结论速览

| 维度 | 评级 | 一句话 |
| --- | --- | --- |
| 功能完整性 | A | 13 个工具全部实测有响应，无 5xx、无超时、无崩溃 |
| 写入正确性 | A | ASCII / 多字节 UTF-8 / 空文件 / 无尾换行 / CRLF / 混合换行 / BOM 全部逐字节精确 |
| 读取正确性 | A | 5 MB、10 万行分页零错位，`totalLines`/`offset`/`truncated` 三元语义自洽 |
| 哈希一致性 | A | `file_hash` 与 `Get-FileHash` 在 1 MiB 二进制、4.9 MB 文本上完全一致 |
| CAS 前置条件 | A | 命中即写、过期即拒，且**拒绝时文件分毫未动** |
| 沙箱边界 | A | 文件工具锁死在 `C:\BHH\MCP-Server`，越界路径被拒（错误信息精确） |
| 服务端并发 | A | 20 路真并行，重叠因子 17.95，服务端无并发上限 |
| 错误面 | B | 错误是多处裸异常直出（`ENOENT`/`EISDIR`/`unknown job`），CAS 失败回显的哈希被截断 |
| 会话健壮性 | B− | `DELETE` 会**永久烧毁**配对码；二次 `initialize` 直接 400，无重连宽限 |
| 性能 | A− | 服务端磁盘 305.7 MBps、文本生成 63.6 MB/s；但客户端前台调用被串行化 |
| 文档与自描述 | B | `skill://mcp-guide` 存在，但缺"能力/限额/版本"自描述端点与并发声明 |

**总评：可作为生产级个人 PC 遥控通道使用，功能面没有短板；主要风险集中在会话生命周期（配对码不可再生）与错误可诊断性。**

---

## 1. 测试范围与方法

### 1.1 覆盖矩阵

| 维度 | 覆盖 | 说明 |
| --- | --- | --- |
| 连接 / 握手 | 充分 | 初始化、二次初始化、存活探测、令牌销毁、端口轮换 |
| 工具面 | 充分 | 13 个工具**逐个**实测调用 |
| 读语义 | 充分 | 小文件 9 组用例 + 大文件 3 档规模（980000 / 4900000 / 979999 字节） |
| 写语义 | 充分 | 小文件 18 组用例 + 大文件 CAS 覆盖、截断、过期拒绝 |
| 哈希 / CAS | 充分 | 命中、过期、create_if_absent 三种状态 |
| 沙箱 / 安全 | 充分 | 根内、两级 `..`、三级 `..`、绝对越界 |
| 并发 / 性能 | 充分 | 20 路真并行、前台串行化对照、后台并行、共存干扰、启动开销分解 |
| 作业生命周期 | 充分 | 提交、运行、完成、强杀、杀后查询（含无效 ID 对照） |
| 稳定性 / 泄漏 | **未覆盖** | 无长时（小时级）跑测，无内存泄漏观测 |
| 真并行原子性 | **未覆盖** | 竞争写入实测发生在**被客户端串行化**的队列上 |
| NTFS 只读 / 锁定 / 权限拒绝 | **未覆盖** | 未构造只读文件、占位锁、ACL 拒绝场景 |

### 1.2 计时口径（为什么不用客户端计时）

客户端跨消息测得的"延迟"里，**模型推理时间占绝对主导**，与网络/服务无关，拿它做基准等于自欺。因此：

- 所有耗时由**服务端命令自己打时间戳**：`(Get-Date).ToString('o')`，写入日志文件后回读比对；
- 并发度用**区间重叠扫描**计算（按开始时间排序后 ±1 扫描），不靠"我觉得并行"；
- 串行化判据：批量总跨度 ≈ K×D + K×间隙（K 为任务数，D 为单任务耗时）；
- 探针地板（纯往返 + PowerShell 冷启动）单独测出，用于扣除本底。

---

## 2. 测试清单

### A. 连接与会话

| 编号 | 测试项 | 方法 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| A-01 | 初始化握手 | POST `initialize` | ✅ 返回 `mcp-session-id`，随后 `tools/list` 得到 13 个工具 | 工具枚举 |
| A-02 | 二次初始化拦截 | 同一配对码再次 `initialize` | ✅ `HTTP 400` + `-32600 "Server already initialized"` | — |
| A-03 | 零成本存活探测 | **不** `initialize`，直接 `tools/list` | ✅ `HTTP 400` + `-32000 "Bad Request: Server not initialized"`：证明路由活着且**令牌未被消耗** | 本报告采用的推荐探活法 |
| A-04 | 令牌销毁语义 | `DELETE /mcp/<token>` | ✅ 首次 `HTTP 200` 空响应，此后**永远** `HTTP 404` + `-32001 "Session not found"`（TCP 端口仍监听） | 一次自伤事故，见 §5.1 |
| A-05 | 死链表现 | 访问已销毁 / 已下线地址 | ✅ `404 -32001`；源应用停后变为连接被拒 | 历史两轮 |
| A-06 | 端口与令牌轮换 | 源应用重启 | ✅ 端口与 32 位十六进制配对码**同时**更换（`61832 → 55903 → 64722`） | — |
| A-07 | 配置热重载 | 编辑 DSH profile 中 `mcp-xiantu` 块 | ✅ 触发热重载并**新开一次 `initialize`**；因此改名/换码必须与首次生效同一次编辑完成 | `cordis.patch.yml:374/377/379` |
| A-08 | 并发会话约束 | 同一配对码双客户端 | ✅ 一号路一通道（"一个 AI = 一个配对码 = 一个通道"），无法两条并行会话共用 | A-02 |

### B. 工具面盘点（13/13 全部实调）

| 编号 | 工具 | 实测入参 → 回执 | 结果 |
| --- | --- | --- | --- |
| B-01 | `read_file` | `{path, offset, limit}` → `{content, totalLines, offset, truncated}` | ✅ |
| B-02 | `write_file` | `{path, content, expectedHash?}` → `{path, bytes, sha256}` | ✅ |
| B-03 | `list_files` | `{path, recursive}` | ✅ |
| B-04 | `file_hash` | `{path}` → `{path, sha256, bytes}` | ✅ |
| B-05 | `exec` | `{command, cwd?, timeoutMs?, background?}` → 前台回执 / `{jobId, status}` | ✅ |
| B-06 | `job_output` | `{jobId}` → `{jobId, done, exitCode, output}` | ✅ |
| B-07 | `job_kill` | `{jobId}` → `{jobId, killed: true}` | ✅ |
| B-08 | `system_info` | — → `{hostname, platform, arch, cpus, totalMemMB, freeMemMB, uptimeSec, node}` | ✅ |
| B-09 | `health` | — → `{status:"ok", server:"mcp-server", version:"0.1.0", uptimeSec}` | ✅ |
| B-10 | `hello.greet` | `{name:"BHH"}` → `{greeting:"你好，BHH！"}` | ✅ |
| B-11 | `list_skills` | — → 2 个技能：`mcp-guide`、`pdf-read`（含 `when` 触发说明） | ✅ |
| B-12 | `demo.ping` | — → `{ok: true}` | ✅ |
| B-13 | `list_connectors` | — → `[{name:"demo", connected:true}]` | ✅ |
| B-14 | 资源 `skill://mcp-guide` | 读取 | ✅ |
| B-15 | 资源 `skill://pdf-read` | 仅枚举到，未读 | ⚪ 未测 |

### C. `exec` 执行语义

| 编号 | 测试项 | 结果 | 证据 |
| --- | --- | --- | --- |
| C-01 | 执行宿主 | ✅ Windows PowerShell 5.1（非 pwsh 7），行为差异需注意（如 `ConvertTo-Json` 会把中文转义为 `\uXXXX`） | — |
| C-02 | `timeoutMs` 边界 | ✅ 默认 30000，上限 300000 | 工具签名 |
| C-03 | 后台执行 | ✅ `background:true` 立即返回 `{jobId, status:"running"}`，不阻塞 | 见 J 组 |
| C-04 | 编码显示陷阱 | ⚠️ 控制台为 GBK，**中文/UTF-8 在回显层会被吃掉**（仅显示层） | §3.6 |
| C-05 | 引号地狱 | ❌ PowerShell 5.1 会剥掉单引号 `node -e '...'` 内部引号 → `SyntaxError: Unexpected token ':'`（**连败 2 次**） | §5.2 |
| C-06 | 日期对象处理 | ⚠️ GBK 控制台下对多行内容 `Format-Table` / `[datetime]::Parse` 会抛错或污染；须逐行 `-replace` 后解析 | — |
| C-07 | 进程启动开销测法 | ⚠️ `Start-Process -Wait` 测得 1.029 s 是**工具假象**；`[Diagnostics.Process]::Start` 真实为 0.118 s | §5.3 |

### D. 读语义

| 编号 | 测试项 | 结果 | 证据 |
| --- | --- | --- | --- |
| D-01 | 分页单位 | ✅ **按行**分页而非按字节（`payload-1kb.txt` 在 `limit=4` 时即 `truncated:true`） | — |
| D-02 | `offset` 基准 | ✅ 0 基行号 | — |
| D-03 | `limit` 上限 | ✅ ≤ 2000 | — |
| D-04 | 越界行为 | ✅ 超 EOF 返回空字符串（`offset=100` 于 17 字节文件） | `lf.txt` |
| D-05 | 空文件 | ✅ `totalLines: 1` | `empty.txt`（0 B，`e3b0c442…`） |
| D-06 | 末段空行语义 | ✅ **计入 `totalLines` 但不作为内容返回**：`lf.txt`→4、`cas2.txt`→2、`big-text-5mb.txt`→100001 | 三处一致 |
| D-07 | 尾换行保真 | ✅ `truncated:false` 时内容保留文件自身尾换行；文件无尾换行则读回也无 | `lf2.txt` / `big-text-1mb-nonl.txt` |
| D-08 | 换行归一化 | ✅ 无归一化，CRLF 原样保留 | `crlf2.txt`（`6f 6e 65 0d 0a 74 77 6f 0d 0a`）、`mix.txt`（`61 0d 0a 62 0a 63 0d 0a 64`） |
| D-09 | 二进制处理 | ⚠️ 按 UTF-8 解码 → **有损**：1 MiB 随机二进制读回 `totalLines: 4095` | `big-1mb.bin` |
| D-10 | 大文件分页（5 MB） | ✅ `offset=0/50000/99999` 精确命中 `L0000000` / `L0050000` / `L0099999`，`totalLines=100001` | §4.1 |
| D-11 | 大文件无尾换行 | ✅ `big-text-1mb-nonl.txt`（979999 B）`totalLines=20000`，末页无尾换行 | — |
| D-12 | BOM 行为 | ⚠️ **盘上存在已证**（`bom.txt` 前 3 字节 `ef bb bf`），但 `read_file` 返回的确切码点**无法做字节级断言** | §5.4 |
| D-13 | `file_hash` 错误面 | ⚠️ 缺失路径 → 裸 `ENOENT`；目录 → 裸 `EISDIR` | — |

### E. 写语义

| 编号 | 用例 | 期望 | 结果 | 证据（sha256 前缀） |
| --- | --- | --- | --- | --- |
| E-01 | 纯 ASCII 新建 | 逐字节精确 | ✅ | `lf.txt` `4fdbc441…` |
| E-02 | 多字节 UTF-8（中文） | 逐字节精确 | ✅ | `cjk.txt` 44 B `fa7df2f1…` |
| E-03 | 空文件 | 0 B | ✅ | `empty.txt` `e3b0c442…` |
| E-04 | 无尾换行 | 不多不少 | ✅ | `nonl.txt` 24 B `bb3082b8…` |
| E-05 | CRLF（服务端产出） | CR 保留 | ✅ | `crlf2.txt` `6f4792b2…` |
| E-06 | 混合 CRLF/LF | 原样 | ✅ | `mix.txt` `01d51db6…` |
| E-07 | UTF-8 BOM 复制 | BOM 保留 | ✅ | `bom-copy.txt` |
| E-08 | 自动建父目录 | 目录不存在也成功 | ✅ | `deep/a/b/c.txt` 5 B `64896f89…` |
| E-09 | 覆盖即截断 | 旧尾部不留残余 | ✅ | 980000 B → 7936 B，无 `-` 残留、无 `L0000000` 残留 |
| E-10 | 大载荷上限 | 找真实可推上限 | ✅ 实测最大 **7936 B**（较旧纪录 4672 B 提升 1.70×） | §5.5 |
| E-11 | 竞争写入 | 只应有一个赢家 | ✅ `winner-A`（`060f3f47…`）落盘，`winner-B`（`b0508ddb…`）未落 | ⚠️ 队列被客户端串行化 |
| E-12 | 客户端 CRLF 缺陷 | — | ❌ 客户端序列化**丢掉了 CR**：`crlf.txt` 与 `lf2.txt` 哈希相同（均 `c3f9c8c2…`） | §5.6 |

### F. CAS 前置条件（`expectedHash`）

| 编号 | 测试项 | 结果 | 证据 |
| --- | --- | --- | --- |
| F-01 | 命中即写 | ✅ 对 980000 B 文件传其真实哈希 → 写入成功，服务端确实为校验哈希了约 1 MB | `6ad3e125…` |
| F-02 | 过期即拒 | ✅ 对 4900000 B 文件故意传错 → `Error: stale-file: expected 000000000000…, got 4b1bb6d85538…` | 完整报错见 §5.7 |
| F-03 | 拒绝后文件完整性 | ✅ 4.9 MB 文件**完全未变**（仍 4900000 B / `4b1bb6d8…`） | — |
| F-04 | 原子性 | ✅ 临时文件 + rename（`write_file` 语义） | 未做竞态实测 |
| F-05 | `create_if_absent` 配方 | ✅ 对**不存在**路径传 `expectedHash = sha256("") = e3b0c442…` 成功创建 | `missing-precondition.txt` 17 B `2ab0b7de…` |

### G. 沙箱边界与安全

| 编号 | 路径 | 结果 |
| --- | --- | --- |
| G-01 | `perf-test/rw/abs-inside.txt`（根内绝对路径） | ✅ 允许 |
| G-02 | `perf-test/escape-attempt.txt`（两级 `..`） | ✅ 被规范化回根内，写入成功（内容 `esc\n`，`4bafe3ae…`）→ **安全** |
| G-03 | 三级 `..` / 根外绝对路径 | ✅ 拒绝：`Error: path escapes root: C:/Windows/System32/drivers/etc/hosts` |
| G-04 | `exec` 逃逸 | ⚠️ `exec` 可执行任意 PowerShell ⇒ **持有配对码 = 持有该主机控制权**（这是设计，但也意味着配对码等同凭据） |

> 更正声明：早期"文件工具可无限制访问文件系统"的说法**已撤回**，并已在 `report.md` §11、`results-rw.json#security_correction`、`results.json#security` 三处同步更正。

### H. 并发与性能

| 编号 | 测试项 | 结果 | 证据 |
| --- | --- | --- | --- |
| H-01 | 前台 6 路"并行" | ❌ `max_concurrent_overlap=1`，总跨度 **13.497 s**，比单进程串行对照（12.096 s）**更慢** | 客户端串行化 |
| H-02 | 后台 20 路真并行 | ✅ 20/20 重叠，`parallelism_factor = 17.95` | §4.2 |
| H-03 | 后台 6×3 s | ✅ 总跨度 **3.146 s**，加速比 **5.72×** | — |
| H-04 | 前后台共存 | ✅ 后台任务运行中，前台调用在 `bg_start + 0.036 s` 即被接纳，互不阻塞 | — |
| H-05 | 探针地板 | 0.275 s ≈ PowerShell 冷启动 0.118 s + 空载往返 ~50 ms | — |
| H-06 | 服务端能力 | 磁盘写 1 MiB 0.003 s（**305.7 MBps**）；sha256 1 MiB 0.057 s；文本生成 4.9 MB / 0.077 s（**63.6 MB/s**） | — |
| H-07 | 瓶颈定位 | 客户端插件源码中唯一调用路径无互斥/信号量/队列 → **瓶颈不在插件**；核心调度因压缩混淆无法定行 | `dsh-mcp-client/lib/index.js:140-147` |

### I. 错误面

| 编号 | 触发 | 返回 | 评价 |
| --- | --- | --- | --- |
| I-01 | 二次 `initialize` | `400` + `-32600 Server already initialized` | 清晰 |
| I-02 | 未初始化即调用 | `400` + `-32000 Bad Request: Server not initialized` | 清晰（可当探活） |
| I-03 | 已销毁令牌 | `404` + `-32001 Session not found` | 清晰但**无救** |
| I-04 | 越界路径 | `Error: path escapes root: <绝对路径>` | 优秀 |
| I-05 | CAS 过期 | `Error: stale-file: expected <被截断哈希>, got <被截断哈希>` | ⚠️ 哈希被截断，不能直接用于重试 |
| I-06 | 缺失路径 | 裸 `ENOENT` | ⚠️ 缺结构化错误码 |
| I-07 | 传入目录 | 裸 `EISDIR` | ⚠️ 同上 |
| I-08 | 未知 / 已杀作业 | `Error: unknown job: <id>` | ⚠️ 与"从未存在"不可区分（已用无效 ID 对照验证） |

### J. 作业（后台任务）生命周期

| 编号 | 步骤 | 回执 |
| --- | --- | --- |
| J-01 | `exec(background:true)` 提交 45 s 任务 | `{jobId:"job-69-musffv2r", status:"running"}` |
| J-02 | `job_kill` | `{jobId:"job-69-musffv2r", killed:true}` |
| J-03 | 杀后 `job_output` | ❌ `Error: unknown job: job-69-musffv2r` → **杀即清除，取不到部分输出** |
| J-04 | 无效 ID 对照 | `Error: unknown job: job-404-nope`（与 J-03 同一文案 ⇒ 无法区分） |
| J-05 | 正常完成的 `job_output` | `{jobId:"job-70-musfh49j", done:true, exitCode:0, output:"partial-visible-after-20s\r\n"}` |

> 注意回执**形状不一致**：`exec` 后台返回 `status`，而 `job_output` 返回 `done`/`exitCode`，两者都不是统一的作业对象。

---

## 3. 工具调用方法总结（可直接照抄的操作手册）

### 3.1 连接三步与两个禁区

1. `initialize` → 拿 `mcp-session-id`；
2. `tools/list` → 确认 13 个工具在位；
3. 正常调用。

- 🚫 **禁区一：绝不 `DELETE`**。删了配对码就永久报废（A-04），端口还开着，你会以为是网络问题。
- 🚫 **禁区二：绝不对 DSH 正在使用的令牌再 `initialize`**（A-02 直接 400）。

**推荐探活姿势**：直接发一个**裸** `tools/list`（不带 `initialize`）。返回 `-32000 Server not initialized` 就说明**路由活着、令牌没被花掉**——这是零成本心跳。

### 3.2 读文件的标准配方

```
read_file(path, offset=0, limit<=2000)
  ├─ offset 是 0 基行号
  ├─ limit 是行数，不是字节数
  ├─ totalLines 含"末尾换行后的空段"（所以 5 MB 文件是 100001 而非 100000）
  ├─ 判断读完看 truncated，不要拿 content 长度猜
  └─ 大文件一律翻页，别指望一次拉完
```

### 3.3 写文件的标准配方（带 CAS）

```powershell
# 1) 先取当前哈希（文件不存在则会报 ENOENT，属正常分支）
$h = file_hash($path).sha256
# 2) 带前置条件写；别人改过就会被拒，且你的文件不会被动
write_file($path, $content, expectedHash=$h)
# 3) 读回校验（回执里的 sha256 已可直接比对）
```

- 新建（要求"绝不能覆盖"）用 `expectedHash = sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`——**实测有效**（F-05）。
- 覆盖是**截断式**，不会留旧尾巴（E-09）。

### 3.4 大文件的正确姿势

> **服务端没有问题，问题在"谁把字节送过去"。**

- `write_file` 的载荷必须由**调用方逐字发射**，1 MB 文本对模型上下文而言不现实 → 这条通道的天花板属于**调用方预算**，不是服务端容量；
- 大文件一律**在服务端生成**：`exec` 跑 `StringBuilder` + `[IO.File]::WriteAllText($p,$s,(New-Object Text.UTF8Encoding($false)))`（63.6 MB/s）；
- 生成后立刻 `file_hash` 三方对账（服务端 `Get-FileHash` / MCP `file_hash` / 预期值）。

### 3.5 长任务的标准姿势

```
exec(command, background=true)  → {jobId, status:"running"}
job_output(jobId)               → {done, exitCode, output}
job_kill(jobId)                 → {killed:true}   # 杀后即查不到，先取输出再杀
```

- 需要**并行**就必须走 `background:true`：前台调用被客户端串行化（H-01）。
- 但不建议无脑后台：分发本身约 50 ms/个。
- `timeoutMs` 上限 300000，超过 5 分钟的活必须后台化。

### 3.6 中文 / 编码的正确姿势

- 控制台是 GBK，**中文在回显层会被吃**——那只是显示问题。
- **要断言就走字节层**：`[IO.File]::ReadAllBytes($p)` + `[BitConverter]::ToString($b)`；
- 读文本用 `[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)`（会正确剥 BOM），**不要**用 `Get-Content` 默认编码（ANSI，会污染中文）；
- 写文本用 `New-Object Text.UTF8Encoding($false)`（不写 BOM）；
- 往 `write_file` 里塞中文前，先把内容写成**文件**，再用纯 ASCII 的 `exec` 拼接——**这样永远不会踩引号地狱**（C-05 已连败两次）。

```powershell
$b=$bytes -join ','
[Text.Encoding]::UTF8.GetString($bytes)                  # 不剥 BOM（≡ Node readFileSync('utf8')）
[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)          # 剥 BOM
[IO.File]::WriteAllText($p,$s,(New-Object Text.UTF8Encoding($false)))  # 不写 BOM
```

### 3.7 路径规则

- 相对 `C:\BHH\MCP-Server`，**正斜杠可用**（`perf-test/rw/x.txt`）；
- 两级 `..` 会被规范化回根内（安全）；三级 `..` 与根外绝对路径直接拒绝；
- 父目录不存在会自动创建。

---

## 4. 关键基准数据

### 4.1 大文件读（`read_file` 分页）

| 文件 | 字节 | sha256 | 行数 | 分页验证 |
| --- | --- | --- | --- | --- |
| `big-text-1mb.txt` | 7936（本轮被覆盖后） | `3032375166eb…` | 124 | 独立重建逐字节一致 |
| `big-text-5mb.txt` | 4900000 | `4b1bb6d85538…` | 100001 | `offset=0/50000/99999` 三处精确命中 |
| `big-text-1mb-nonl.txt` | 979999 | `093791e1…` | 20000 | 末页无尾换行，正确 |
| `big-1mb.bin` | 1048576 | `68363f11…` | 4095（有损） | 与 `Get-FileHash` 一致 |

### 4.2 并发（服务端真并行，20 路）

| 指标 | 数值 |
| --- | --- |
| 启动时间窗 | `21:00:08.7059778 → 21:00:09.6540714`（散布 0.948 s） |
| 单任务耗时 | 8.03 – 8.106 s |
| 最后结束 | `21:00:17.6925414` |
| 总跨度 | **8.987 s** |
| 重叠总和 | 161.344 s |
| 并行因子 | **17.95** |

### 4.3 本底与硬件

| 项目 | 数值 |
| --- | --- |
| PowerShell 冷启动 | 0.134 / 0.111 / 0.115 / 0.115 / 0.116 → **均值 0.118 s** |
| `cmd.exe /c exit` | 0.009 s |
| 空载往返 | ~50 ms |
| 探针地板合计 | ~0.275 s |
| 磁盘写 | 1 MiB / 0.003 s = **305.7 MBps** |
| sha256 | 1 MiB / 0.057 s |
| 文本生成 | 4.9 MB / 0.077 s ≈ **63.6 MB/s** |

---

## 5. 缺陷、假象与我方失误（都记账）

### 5.1 配对码不可再生（服务端设计风险，P0）
`DELETE` 后令牌永久失效且端口仍在监听，极易被误判为网络故障。**建议：改为一号一码可轮换，或至少让 `DELETE` 只关闭会话、保留可用令牌。**

### 5.2 引号地狱（我方失误 ×2）
PowerShell 5.1 会剥掉单引号 `node -e '...'` 内部引号 → `SyntaxError: Unexpected token ':'`。**教训：不要在 `exec` 里内联 JS；中文/JSON 载荷先落文件，再用纯 ASCII 命令做字节级拼接。**

### 5.3 进程启动开销假象（我方测法失误）
`Start-Process -Wait` 给出 avgSpawnSec = 1.029 s；换成 `[Diagnostics.Process]::Start` 后为 0.118 s。**教训：先证明测量工具本身不引入被测对象。**

### 5.4 BOM 的不可断言性（限制）
盘上 BOM 存在已字节级证明（`ef bb bf`）；`[Text.Encoding]::UTF8.GetString` 不剥 BOM（首码点 65279），而 `ReadAllText`/`Get-Content -Encoding UTF8` 会剥。**`read_file` 返回的确切码点无法做字节断言，只能记录不确定性。**

### 5.5 载荷上限 7936 B 与"发射失误"（我方失误 ×1）
本轮意图写 8192 B（128 行 × 64 B），**实际只发出 124 行 = 7936 B**。回执 `bytes` 与独立重建把这个人手计数错误顶了出来：通道**一个字节都没丢**。**这个数字就是"调用方预算即天花板"的直接证据。**

### 5.6 客户端 CRLF 序列化缺陷（客户端缺陷）
`crlf.txt` 与 `lf2.txt` 哈希**完全相同** ⇒ 客户端在序列化时丢掉了 CR。**CRLF 必须由服务端产出**，否则测的不是服务端。

### 5.7 CAS 报错哈希被截断（服务端可用性缺陷，P1）
```
Error: stale-file: expected 000000000000…, got 4b1bb6d85538…
```
重试需要完整 64 位十六进制。**建议错误里给全量哈希。**

### 5.8 其他已知限制
- 跨消息的端到端延迟**无法**用本方法测（模型推理占主导）；
- 无长时稳定性/内存泄漏测试；
- 20 路并发只是**已验证下界**，不是上限；
- 前台串行化的归因是**基于证据的推断**（插件源码无锁，核心调度混淆无法定行）；
- `write_file` 的临时文件 + rename 原子性**无法做竞态实测**（队列被串行化）；
- `read_file` 处理二进制是**有损**的；
- 真并行竞争下的 CAS 互斥**未测**；
- NTFS 只读/占用锁/权限拒绝**未测**。

---

## 6. 优化建议

### 6.1 服务端（按优先级）

| 优先级 | 建议 | 理由 |
| --- | --- | --- |
| P0 | 会话令牌可轮换 / `DELETE` 不至于永久报废 | 一次误操作就要人工换码，风险成本过高 |
| P0 | 提供免初始化的心跳端点（或文档明确"裸 `tools/list` 即心跳"） | 目前探活要绕 400 错误码 |
| P1 | CAS 报错回显**完整**哈希 | 现在截断，无法直接重试 |
| P1 | `job_kill` 后保留作业状态与已产出输出 | 现在 `unknown job`，且与无效 ID 不可区分 |
| P1 | 统一作业对象字段（`status` vs `done`/`exitCode`） | 回执形状不一致 |
| P1 | 错误面结构化：缺失路径 → 明确错误码而非裸 `ENOENT`；目录 → 非 `EISDIR` | 现为多处异常直出 |
| P2 | `read_file` 增加字节级分页（`startByte`/`maxBytes`）与 `encoding`（含 `base64`） | 避免二进制有损、避免只能按行读 |
| P2 | `read_file` 增加 `stripBom` / 明确 BOM 返回策略并写进文档 | 目前语义不可断言 |
| P2 | `write_file` 回执增加 `previousBytes` / `truncatedFromBytes` | 覆盖截断不可观测 |
| P2 | 支持 `expectedHash: "absent"` 显式语义 | 取代 `sha256("")` 这种隐式配方 |
| P2 | `list_files` 输出 size / mtime / type，支持 glob 与分页 | 现在信息量偏少 |
| P2 | `exec` 分离 stdout/stderr，附退出码与耗时；`[Console]::OutputEncoding` 固定 UTF-8 | 现在合并回显、控制台 GBK 会误导 |
| P2 | 增加自描述端点（版本/能力/限额/并发声明） | 现在只有 `health` 的四个字段 |
| P2 | 文档化并发模型与上限、背压策略 | 现在只能靠实测反推 |

### 6.2 接入侧（DSH / 客户端）

| 优先级 | 建议 | 理由 |
| --- | --- | --- |
| P0 | 把 `-32001` / `-32600` 识别为**不可恢复错误**，立即停止重连并提示换码 | `RECONNECT_DEFAULTS.maxAttempts=10` 对永久失效的令牌纯属空转（`dsh-mcp-client/lib/index.js:434-439`） |
| P1 | 为 MCP 工具调用增加并行开关 / 默认长任务走 `background:true` | 前台调用被串行化，6 路"并行"反而比串行慢 1.4 s |
| P1 | 修复请求体序列化丢 CR 的问题 | 已污染一次 CRLF 测试（5.6） |
| P2 | 内置低频（裸 `tools/list`）健康探测 | 免初始化、零成本 |
| P2 | 文档标红：一个 AI = 一个配对码 = 一个通道；禁止 `DELETE` | 防止重复踩坑 |
| P2 | 配置热重载告警：改名/换码需同一次编辑完成 | 否则触发无令牌的重连风暴 |

---

## 7. 复现命令（服务端 PowerShell）

```powershell
# 生成 5 MB 定宽文本（无 BOM），并打印自证指纹
$p='C:\BHH\MCP-Server\perf-test\rw\big-text-5mb.txt'
$sb=New-Object Text.StringBuilder
for($i=0;$i -lt 100000;$i++){ [void]$sb.Append('L' + ('{0:d7}' -f $i) + ('-'*40) + "`n") }
[IO.File]::WriteAllText($p,$sb.ToString(),(New-Object Text.UTF8Encoding($false)))
$b=[IO.File]::ReadAllBytes($p)
'bytes=' + $b.Length + ' sha=' + (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()

# 字节级断言（绕开 GBK 控制台）
'bom_first3=' + (([IO.File]::ReadAllBytes('C:\BHH\MCP-Server\perf-test\rw\bom.txt'))[0..2] -join ',')

# 三方哈希对账
(Get-FileHash $p -Algorithm SHA256).Hash.ToLower()   # 与服务端 file_hash 比对

# 并发基准（后台真并行）
1..20 | ForEach-Object { Start-Job { Start-Sleep -Seconds 8 } }   # 或用 exec background + 区间重叠扫描
```

```powershell
# JSON 结构对账（改配置/结果文件后必做）
$o=([IO.File]::ReadAllText($jp,[Text.Encoding]::UTF8))|ConvertFrom-Json
$ob=([IO.File]::ReadAllText($bak,[Text.Encoding]::UTF8))|ConvertFrom-Json
foreach($k in ($ob|Get-Member -MemberType NoteProperty).Name){
  if(($ob.$k|ConvertTo-Json -Depth 40 -Compress) -ne ($o.$k|ConvertTo-Json -Depth 40 -Compress)){'DIFF='+$k}
}
```

---

## 8. 证据文件索引（服务端 `C:\BHH\MCP-Server\perf-test\`）

| 文件 | 字节 | sha256（前 8 位） | 内容 |
| --- | --- | --- | --- |
| `rw-test.md` | 14782 | `52d03aa0…` | 读写测试中文报告：§1 结论速览、§2 取证口径、§3 写用例表、§4 读语义、§5 CAS 三态、§6 沙箱、§7 未测项、§8 更正、§9 复现命令、§10 大文件补测、§10.5 前文更正 |
| `results-rw.json` | 10943 | `e4b1bc1e…` | 机器可读结果：16 个顶层键，含 `write_cases`(18)、`read_cases`(9)、`read_semantics`、`bom_behavior`、`cas_semantics`、`sandbox`、`security_correction`、`limitations`(5)、`large_file_suite` |
| `results-rw.json.pre-large.bak-20261003` | 8792 | `bd5b4cfc…` | 追加前的完整备份（保留，含已更正的历史条目） |
| `report.md` | 10205 | `fcb673e2…` | 性能/并发主报告（§11 读写能力套件） |
| `results.json` | 6773 | `9e84c042…` | 性能/并发机器可读结果 |
| `bench-host.ps1` | 3089 | `685d8284…` | 服务端基准脚本 |
| `run-concurrency.ps1` | 1655 | `6a652148…` | 并发运行脚本 |
| `logs\` | 52 个 | — | 每个任务一对 `start`/`end` 自时间戳 |
| `rw\` | 20 个 | — | 读写用例样本（含 4.9 MB 大文件、1 MiB 二进制） |

---

## 9. 未测项与后续建议

1. **真并行下的 CAS 互斥**——需要在客户端解除串行化后重测；
2. **长时稳定性 / 内存泄漏**——建议 24 h 定时 `health` + 内存曲线；
3. **NTFS 只读 / 文件占用 / ACL 拒绝**的错误面；
4. **`read_file` 的 BOM 精确行为**——需要服务端明确文档或新增 `stripBom` 参数后才能断言；
5. **`write_file` 载荷上限的真实拐点**——8 KB ~ 64 KB 区间未测（受调用方预算限制，需用脚本客户端而非模型客户端）；
6. **`job_output` 对运行中作业的增量语义**——本轮只拿到了完成态回执；
7. **`skill://pdf-read` 能力**——仅枚举未读。

---

*本报告所有数字均来自服务端自时间戳命令与字节级断言；无一条来自客户端跨消息计时的推测。*
