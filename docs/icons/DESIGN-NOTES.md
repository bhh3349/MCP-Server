# MCP-Server 图标设计说明

独立项目，与 ProxySandbox 图标（`../icons/`）零共享素材，仅复用其 `.build` 工具链
（`resvg`、`census.py`）。全部产物在本目录；单一几何真源为
`.build/gen_icons.py`，任何尺寸改动都应改脚本重生成，不手改 SVG。

## 概念：一核双道

MCP 的本质是一个本地核心同时对外、对内两条信道：

- **实心圆角方块（核心）** —— 本地服务器本体 / 控制中心；
- **空心环（远端信道）** —— 网关订阅、外部握手：环是"开口等待接入"的符号；
- **实心点（本地信道）** —— 本地直连、已建立的会话。

刻意避开 ProxySandbox 已用的"容器开洞 + 箭头"构图，防止两个项目串味。
三元素类型（方块 / 环 / 点）即需求文档中"本地直连 / 网关订阅"两种通道的视觉化。

## 几何（512 网格，master 值）

| 部件 | 参数 |
|---|---|
| 底板 PLATE | x=24 y=24 w=464 r=108 |
| 对称轴 | CY=256 |
| 核心 CORE | cx=188 w=136 r=34 |
| 环 RING | cx=344 cy=156 r=44 sw=28（描边圆，孔 = r − sw = 16） |
| 点 DOT | cx=344 cy=356 r=38 |
| 信道 ARM | sw=38，根部离核心中心 SPREAD=0.30 |

环的描边圆绘制在中心线半径 `rm = r − sw/2` 上，这样"真实内孔 = r − sw"，
孔的尺寸语义在任何缩放下都成立。

## 小尺寸规则（16/24/32/48 提示版）

第一版 16px 放大检查暴露两条硬规则，均已固化进生成器：

1. **环必须有孔**：孔半径下限 `MIN_HOLE = 1.5px`。低于它，空心环与实心点在
   16px 是同一坨像素，"双道"概念直接死掉。
2. **位置从解析后半径派生**：小尺寸下限会让环比 master 相对粗 ~2.4 倍，
   顶穿底板。因此信道端点由解析后的端点半径反推（`channel()`：环取
   `hole + arm_sw/2 − 1.0`，点取 `dot_r × 0.35`），环的 cy 在触边时重适配
   （`fit = plate.y + r_outer + PLATE_CLEAR`，向上取到半像素）；
   `containment()` 断言每个部件离底板边缘 ≥ `PLATE_CLEAR = 0.6px`，溢出即 exit 1。

提示尺寸一律 1:1 静态渲染（`resvg -w N -h N`），禁止大图画完再缩放——
重缩放会破坏半像素对齐。描边/点径下限 `MIN_STROKE = 2.0`、`MIN_DOT = 2.0`。

实测通过表（px，脚本 `gen_icons.py` 输出）：

```
size  arm  ring_sw hole  dot_r core  plate_gap
  16  2.00    2.00  1.50   2.00  4.00      1.00
  24  2.00    2.00  1.50   2.00  6.50      3.00
  26  2.00    2.00  1.50   2.00  7.00      3.50
  32  2.50    2.00  1.50   2.50  8.50      5.00
  48  3.50    2.50  1.50   3.50 13.00      8.50
 512 38.00   28.00 16.00  38.00 136.00     88.00
```

## 颜色

- 图形渐变：`#6366F1 → #A78BFA`（45° 双极点，verify 检查两极均存在）；
- 底板：`#0B1020 → #1B1440` 对角渐变 + 9% 白描边（Linear/Vercel 手法，
  保证在深色桌面上轮廓可辨）；
- 暗底上图形/底板对比实测 4.88–5.09（WCAG ≥ 4.5 达标）；
- 托盘/单色版用 `currentColor`，resvg 渲不出主题色，由 `render.py` 按主题
  文本注入：亮任务栏 `#1F2430`、暗任务栏 `#C8CEDA`。

## 产物地图

```
icon.svg            512 网格 master（矢量真源）
icon-{16,24,32,48}.svg  小尺寸提示版
logo.svg / logo-mono.svg / logo-26.svg   无底板标识（彩色/单色/侧边栏 26px）
tray-{16,32}.svg    托盘单独简化标识（无底板、currentColor）
png/                全尺寸 1:1 渲染 + preview 接触表
dist/icon.ico       Windows  16/32/48/256
dist/icon.icns      macOS    icp4/ic11/ic05/ic07/ic13/ic14/ic10（16..1024）
dist/mcp-server-{32,128,256,512}.png   Linux
dist/favicon.{ico,png} dist/favicon-{16,32}.png   网页
dist/apple-touch-icon.png  180
dist/tray-{light,dark}-{16,32}.png dist/tray-{light,dark}.ico   托盘
```

## 构建链

```
gen_icons.py   几何→SVG（含断言，溢出即失败）
render.py      resvg 1:1 渲染全部 PNG（托盘按主题注色）
verify.py      像素探针：孔=底板色、点/核心明亮、对比、渐变双极点、托盘不透明度
pack.py        纯 stdlib 打包 ICO/ICNS，写后回读 sha256 逐条目核对
build_preview.py  亮/暗双带接触表（SVG data-URI 内嵌，resvg 出图）
```

验证以 `verify.py` 像素断言为准，目视接触表仅作最终确认。
`verify.py` 探针取整用 floor（像素 (i,j) 覆盖连续域 [i,i+1)），
底板采样取底边中心（避开圆角弧外透明区）。
