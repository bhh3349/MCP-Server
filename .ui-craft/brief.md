# MCP-Server 控制中心 · 设计记忆

> 这是项目的设计宪法。**本文件的决定永远压过任何通用默认值。**

## 项目身份

- **界面类型**：桌面运维控制中心（控制台），固定 1440×900 画布，非响应式重排
- **受众**：自己运维这台机器的开发者（单人/小团队，中文优先，英文次要）
- **语境**：产品界面，不是营销页
- **技术栈**：原生 CSS + 原生 JS（无框架、无构建步骤），静态资源直接由 node http 服务
- **桌面分发**：同一份 UI 走三条链路 —— `npm run dashboard`（开发）、`build:sidecar` → Tauri、Electron。
  **`src-tauri/sidecar/ui/` 是构建产物（已 gitignore），永远从 `src/dashboard/ui/` 生成，不要手改。**

## 已定的视觉方向

**字族**：IBM Plex Sans（正文/界面）+ IBM Plex Mono（数据/代码），2 个字族。
> 为什么：原 Baloo 2 + Nunito 是圆体、儿童向，与"运维终端"的语汇冲突；Plex 在中文界面里字面清晰，
> 且等宽数字读数不糊。

**强调色**：全站唯一一支品牌紫 `--accent`。
> 为什么：原来是 `--accent: #8b5cf6` + `--accent2: #6366f1` 两支同色度同饱和的紫 = 视觉死结。
> 颜色来自 logo，保留但收敛为一支。

**签名细节（不要改）**：
1. **激活导航的左侧 2px 紫轨** = "你在哪"。用 `color-mix` 派生，亮暗各自正确。
2. **MCP CORE 的粗圆弧 = 全应用最重的强调笔画**。因为它最重，
   所以那张卡本身**必须保持中性底**——不要再往卡片上加紫色渐变（已删除），两个强调会打架。

**暗色画布是 `#0a0b0f`（带微蓝的近黑），不是纯黑；最亮文字是 `#eceef3`，不是纯白。**

## 已学约束（附原因）

1. **canvas 里禁止写死 `rgba(255,255,255,…)`** —— canvas 读不到 CSS 选择器，亮色主题下图表网格线/刻度会直接消失。
   必须用 `themeColor("--token")` 从 CSS 变量取值，亮暗各自定义（见 `--chart-grid` / `--chart-axis` / `--chart-bar`）。
2. **连接状态是全局的，不要给每张卡挂角标**。曾经试过给数据卡加绝对定位的「陈旧」角标，
   结果压住了信道卡的「添加」按钮，且只覆盖了 3/7 张卡。
   正确做法：一条**在正常文档流里**的横幅 + 整体去饱和，不绝对定位。
3. **日志页/错误页的表格数字一律 `tabular-nums`**，仪表盘的价值在于扫一眼比较大小。
4. **`transition: all` 在本项目是禁令**：卡片有 hover 位移、动态插入内容，
   `all` 会动画化意料外的属性。逐个列属性。

## 状态机约定

`Conn` 对象把轮询成败显式建模：`boot → live → stale → offline`。
**连续 3 次失败才判定 offline**——一次网络抖动不该把界面染红。
断线时界面必须说清「发生了什么 + 会自动恢复」，不道歉、不含糊。
**`Overview.refresh()` 的 catch 绝不能是空的**——静默吞掉轮询失败会让界面显示假绿点，
这是仪表盘最危险的失效模式。

## 空态约定

`emptyHTML({zh, en, icon})` —— 空态必须说清**为什么空** + 给一个能点的下一步，
不是一句「暂无X」。`skeletonHTML()` 用骨架屏不用转圈（骨架说明"会变成什么形状"）。

## 检查清单（改完必跑）

```powershell
python "<ui-craft-pro>/scripts/ui_lint.py" src\dashboard\ui\styles.css src\dashboard\ui\index.html src\dashboard\ui\app.js
npx tsc --noEmit
npm run build:sidecar   # 确认桌面链路同步
```

**注意 linter 的两类误报**（已实测确认，不是缺陷）：
- `as016` 要求每个 `:hover` 都有 `:focus-visible` 兄弟 —— 但项目用了一条全局
  `:where(...):focus-visible` 规则。已用真实 Tab 键实测：nav-item / win-btn / 输入框全部拿到 2px 焦点环。
- `as010` 报硬编码圆角 —— 逐行正则，会误伤 `@keyframes`、注释、非圆角数值。

**但 `as010` / `as011` / `as012` 里也有真问题**（9px 圆角残留、`:focus` 应为 `:focus-visible`、9.5px 字号过小），
所以不能无脑忽略，要逐条看内容再决定。