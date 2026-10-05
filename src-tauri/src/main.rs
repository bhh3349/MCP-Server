//! MCP-Server Tauri 后端。
//!
//! 启动流程：
//! 1. 在后台线程拉起 Node sidecar：`node <dist>/local/cli.js --dashboard`
//!    （dist 来自安装包 resources，dev 模式下回退到项目根 dist/）
//! 2. 轮询 127.0.0.1:18789（DASHBOARD_PORT）直到端口可连接
//! 3. 显示主窗口（窗口初始 visible=false，避免白屏/连接失败闪屏）
//! 4. 进程退出时回收 sidecar。
//!
//! Node 查找顺序：环境变量 MCP_NODE > 安装包内 node-bin/ > PATH 上的 node。
//! sidecar 查找顺序：resources/sidecar/sidecar.cjs（打包版，自带依赖）> dist/local/cli.js（dev）。

// release 版编译为 GUI 子系统，避免启动时弹出控制台黑窗（dev 保留控制台便于看日志）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};

const DASHBOARD_PORT: u16 = 18789;
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(400);

struct Sidecar(Mutex<Option<Child>>);

fn log_to_file(msg: &str) {
    if let Ok(mut p) = std::env::temp_dir().canonicalize() {
        p.push("mcp-server-tauri.log");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S"), msg);
        }
    }
}

/// 在 `base` 下按 Tauri resources 布局 / dev 布局找 cli.js
fn cli_candidates(base: &Path) -> Vec<PathBuf> {
    let c = vec![
        // 安装包：resources/dist/local/cli.js
        base.join("dist").join("local").join("cli.js"),
        // 带 `..` 的 resource 会被 Tauri 重命名为 _up_
        base.join("_up_").join("dist").join("local").join("cli.js"),
        // dev：resource_dir 指向 src-tauri 时
        base.join("..").join("dist").join("local").join("cli.js"),
        // 备选：直接在 base 下找
        base.join("local").join("cli.js"),
    ];
    for p in &c {
        log_to_file(&format!("检查: {} 存在={}", p.display(), p.is_file()));
    }
    c
}

/// dev 模式：从可执行文件向上找到 src-tauri，再取项目根 dist/
fn find_dev_dist() -> Option<PathBuf> {
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..6 {
        if dir.join("tauri.conf.json").is_file() {
            let cli = dir
                .parent()?
                .join("dist")
                .join("local")
                .join("cli.js");
            if cli.is_file() {
                return Some(cli);
            }
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

fn resolve_cli_js(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(rd) = app.path().resource_dir() {
        if let Some(p) = cli_candidates(&rd).into_iter().find(|p| p.is_file()) {
            return Some(p);
        }
    }
    find_dev_dist()
}

fn resolve_node(resource_dir: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("MCP_NODE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return p;
        }
    }
    // 安装包自带的 portable node（构建时手动放入 src-tauri/node-bin/）
    #[cfg(windows)]
    let bundled = resource_dir.join("node-bin").join("node.exe");
    #[cfg(not(windows))]
    let bundled = resource_dir.join("node-bin").join("node");
    if bundled.is_file() {
        return bundled;
    }
    // 回退：PATH 上的 node
    PathBuf::from("node")
}

/// cli.js 所在 <base>/dist/local/cli.js → 工作目录取 <base>
/// （prod: resources/；dev: 项目根），保证 extensions/ 等相对路径行为一致。
fn workdir_for(cli_js: &Path) -> PathBuf {
    cli_js
        .parent() // local/
        .and_then(|p| p.parent()) // dist/
        .and_then(|p| p.parent()) // base
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 解析要运行的 sidecar 脚本及其工作目录。
/// - 打包版：resources/sidecar/sidecar.cjs（esbuild 单文件，自带全部依赖），
///   工作目录取同目录，UI 与 extensions 也在其中。
/// - dev / 旧包：dist/local/cli.js，工作目录取项目根，走脚本同级 ui/。
struct SidecarTarget {
    script: PathBuf,
    workdir: PathBuf,
    ui_dir: Option<PathBuf>,
    ext_dir: Option<PathBuf>,
}

fn resolve_sidecar_target(app: &tauri::AppHandle) -> Option<SidecarTarget> {
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    log_to_file(&format!("resource_dir: {}", resource_dir.display()));

    // 打包版：resources/sidecar/（稳定布局，无 `..` → 无 _up_ 转义问题）
    let bundled = resource_dir.join("sidecar").join("sidecar.cjs");
    if bundled.is_file() {
        let dir = bundled.parent()?.to_path_buf();
        log_to_file(&format!("发现打包 sidecar: {}", bundled.display()));
        return Some(SidecarTarget {
            script: bundled,
            workdir: dir.clone(),
            ui_dir: Some(dir.join("ui")),
            ext_dir: Some(dir.join("extensions")),
        });
    }

    // 回退：dist/local/cli.js（dev 或旧安装包）
    let cli_js = match resolve_cli_js(app) {
        Some(p) => p,
        None => {
            log_to_file("ERROR: 找不到 sidecar.cjs / cli.js");
            return None;
        }
    };
    let workdir = workdir_for(&cli_js);
    Some(SidecarTarget { script: cli_js, workdir, ui_dir: None, ext_dir: None })
}

fn spawn_sidecar(app: &tauri::AppHandle) -> Option<Child> {
    let target = resolve_sidecar_target(app)?;
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let node = resolve_node(&resource_dir);

    log_to_file(&format!("node: {}", node.display()));
    log_to_file(&format!("cli: {}", target.script.display()));
    log_to_file(&format!("cwd: {}", target.workdir.display()));
    eprintln!("[tauri] node: {}", node.display());
    eprintln!("[tauri] cli:  {}", target.script.display());
    eprintln!("[tauri] cwd:  {}", target.workdir.display());

    // sidecar 的 stdout/stderr 落到日志文件，否则它崩溃时无迹可查
    let sidecar_log = std::env::temp_dir().join("mcp-server-sidecar.log");
    log_to_file(&format!("sidecar 日志: {}", sidecar_log.display()));
    let out = std::fs::OpenOptions::new().create(true).append(true).open(&sidecar_log).ok();
    let err = out.as_ref().and_then(|f| f.try_clone().ok());

    let mut cmd = Command::new(&node);
    cmd.arg(&target.script)
        .arg("--dashboard")
        .env("DASHBOARD_PORT", DASHBOARD_PORT.to_string())
        .current_dir(&target.workdir)
        .stdin(Stdio::null());
    match out {
        Some(f) => { cmd.stdout(Stdio::from(f)); }
        None => { cmd.stdout(Stdio::null()); }
    }
    match err {
        Some(f) => { cmd.stderr(Stdio::from(f)); }
        None => { cmd.stderr(Stdio::null()); }
    }
    if let Some(ui) = &target.ui_dir {
        cmd.env("MCP_UI_DIR", ui);
    }
    if let Some(ext) = &target.ext_dir {
        cmd.env("MCP_EXTENSIONS_DIR", ext);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不弹黑窗口
        cmd.creation_flags(0x08000000);
    }
    match cmd.spawn() {
        Ok(child) => {
            log_to_file(&format!("sidecar pid={}", child.id()));
            eprintln!("[tauri] sidecar pid={}", child.id());
            Some(child)
        }
        Err(e) => {
            log_to_file(&format!("sidecar 启动失败: {e}"));
            eprintln!("[tauri] sidecar 启动失败: {e}");
            None
        }
    }
}

fn port_open() -> bool {
    TcpStream::connect(("127.0.0.1", DASHBOARD_PORT)).is_ok()
}

/// 等 dashboard 就绪；sidecar 提前退出也直接返回（让窗口显示，由前端报错）。
fn wait_ready(sidecar: &Sidecar) -> bool {
    let start = Instant::now();
    while start.elapsed() < READY_TIMEOUT {
        if port_open() {
            return true;
        }
        if let Ok(mut g) = sidecar.0.lock() {
            if let Some(c) = g.as_mut() {
                if let Ok(Some(status)) = c.try_wait() {
                    log_to_file(&format!("sidecar 已退出: {status}"));
                    eprintln!("[tauri] sidecar 已退出: {status}，停止等待");
                    return false;
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    eprintln!("[tauri] 等待 dashboard 超时");
    false
}

fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(s) = app.try_state::<Sidecar>() {
        if let Ok(mut g) = s.0.lock() {
            if let Some(mut c) = g.take() {
                eprintln!("[tauri] 回收 sidecar pid={}", c.id());
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

fn main() {
    // GUI 子系统没有控制台，Rust 侧 panic 默认看不到，写进日志
    std::panic::set_hook(Box::new(|info| {
        log_to_file(&format!("PANIC: {info}"));
    }));
    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            // 后台线程拉起 sidecar，避免阻塞主线程
            std::thread::spawn(move || {
                let child = spawn_sidecar(&handle);
                let spawned = child.is_some();
                if let Some(c) = child {
                    if let Some(s) = handle.try_state::<Sidecar>() {
                        if let Ok(mut g) = s.0.lock() {
                            *g = Some(c);
                        }
                    }
                }
                // sidecar 都没起来就别空等 60s，直接放行让窗口显示（由前端提示错误）
                if spawned {
                    if let Some(s) = handle.try_state::<Sidecar>() {
                        wait_ready(&s);
                    }
                }
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
            Ok(())
        })
        // 等比缩放：16:10，拖动时按宽度算高度
        .on_window_event(|win, event| {
            if let tauri::WindowEvent::Resized(size) = event {
                const RATIO: f64 = 1440.0 / 900.0;
                let w = size.width as f64;
                let h = (w / RATIO).round() as u32;
                // 避免无限循环：只有高度偏差超过 2px 才调整
                if (size.height as i32 - h as i32).abs() > 2 {
                    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: size.width,
                        height: h,
                    }));
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("tauri 启动失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_sidecar(app);
            }
        });
}
