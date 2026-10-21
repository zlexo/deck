// Deck desktop shell (Tauri v2, native multi-webview with browser-style tabs).
//
// One native window, three kinds of webview:
//   "chrome"  — the top tab bar (:8800/chrome.html). Always visible, 46px tall,
//               full width, stacked last so it floats on top. Owns tab switching
//               + closing; talks to this shell via invoke + the "tabs:changed" event.
//   "deck"    — the dashboard (:8800). The "home" tab. Fills the whole area below
//               the chrome bar when active; parked at 0×0 when a tool tab is up.
//   "tool0..N"— a POOL of tool webviews. Each open tool claims one and KEEPS it,
//               so switching tabs is instant and preserves the tool's state (no
//               reload). Only the active one is sized to fill; the rest are parked.
//               When the pool is full a new open evicts the least-recently-used.
//
// An open tool now fills the ENTIRE area below the tab bar — no more corner HUD
// sliver of the deck. You get back to the dashboard by clicking
// the "Deck" tab, exactly like a browser.
//
// Dev: `npm run app:dev` — beforeDevCommand runs scripts/ensure-gateway.mjs
// (reuses a healthy :8800 or spawns `node server.js` and stays attached).
// Quitting stops the gateway and every tool it started (decision 2026-08-10):
// see shut_down. ⌘Q, the Dock's Quit and a quit Apple Event hide the window
// first and stop them off the main thread (terminate_requested, terminate.rs);
// the run loop at the bottom says why Exit stops them too.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod terminate;

use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};
use tauri::utils::config::Color;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Deck's own page background (--bg: #0a0d12). A webview that has been created
/// or navigated but has not painted yet shows its base colour, and the platform
/// default is WHITE — that is the flash when a tool tab is opened for the first
/// time. Matching the app makes the unpainted frame indistinguishable.
const BG: Color = Color(10, 13, 18, 255);

const CHROME_H: f64 = 46.0; // height of the top tab bar (squared UI, flat buttons)
const POOL: usize = 8; // how many tools can stay open as live tabs at once

/// The gateway's port. PORT is the variable the gateway itself reads, and the
/// sidecar inherits this process's environment, so the two always agree. A
/// launch from Finder or the Dock has no PORT: 8800. A test build started with
/// PORT set runs beside the installed Deck without touching its gateway (its
/// tab bar has no IPC there: capabilities/default.json names :8800 only).
fn port() -> u16 {
    std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8800)
}

fn gateway_url() -> String {
    format!("http://localhost:{}", port())
}

#[derive(Clone)]
struct Tab {
    id: String,
    name: String,
}

struct Tabs {
    active: String,          // "deck" or a tool id
    slots: Vec<Option<Tab>>, // len POOL; index i ↔ webview "tool{i}"
    order: Vec<usize>,       // occupied slot indices, oldest first (LRU + tab order)
}

struct Shell {
    tabs: Mutex<Tabs>,
    /// The gateway sidecar, when THIS app spawned it (shipped-.app path).
    /// None in dev (ensure-gateway.mjs owns it) or when adopting an
    /// externally-started gateway.
    sidecar: Mutex<Option<std::process::Child>>,
    /// Stopping what this app started runs once (see shut_down).
    shutdown: Once,
    /// A terminate: is waiting for that shutdown (see terminate_requested).
    quitting: AtomicBool,
}

fn tabs_json(t: &Tabs) -> serde_json::Value {
    let tabs: Vec<_> = t
        .order
        .iter()
        .filter_map(|&i| t.slots[i].as_ref())
        .map(|tab| serde_json::json!({ "id": tab.id, "name": tab.name }))
        .collect();
    serde_json::json!({ "tabs": tabs, "active": t.active })
}

fn emit_tabs(app: &tauri::AppHandle) {
    let payload = {
        let shell = app.state::<Shell>();
        let t = shell.tabs.lock().unwrap();
        tabs_json(&t)
    };
    let _ = app.emit("tabs:changed", payload);
}

/// Size every webview for the current active tab: chrome across the top, the
/// active content webview filling the area below it, everything else parked 0×0.
/// Last layout applied, so repeated relayout calls that would change nothing
/// cost nothing. This matters because relayout now runs on Moved and
/// Focused(true) as well as Resized — Moved fires continuously while a window
/// is dragged, and without this guard every one of those would call
/// set_position/set_size/show/hide on every webview and thrash the compositor.
static LAST_LAYOUT: std::sync::Mutex<Option<(u64, u64, i64, bool)>> = std::sync::Mutex::new(None);

fn relayout(app: &tauri::AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
    let size = size.to_logical::<f64>(scale);
    let content_h = (size.height - CHROME_H).max(0.0);

    let (active_idx, deck_active) = {
        let shell = app.state::<Shell>();
        let t = shell.tabs.lock().unwrap();
        let idx = t
            .slots
            .iter()
            .position(|s| s.as_ref().map_or(false, |tab| tab.id == t.active));
        // Show the dashboard when "deck" is active, or as a safe fallback if the
        // active tool id somehow no longer maps to a slot.
        (idx, idx.is_none())
    };

    // Cheap early-out when nothing that affects layout has changed.
    {
        let key = (
            size.width.round() as u64,
            size.height.round() as u64,
            active_idx.map(|i| i as i64).unwrap_or(-1),
            deck_active,
        );
        let mut last = LAST_LAYOUT.lock().unwrap();
        if *last == Some(key) {
            return;
        }
        *last = Some(key);
    }

    // Visibility is the only thing that changes between tabs. Geometry is kept
    // correct on EVERY webview, shown or not, for two reasons:
    //   * a hidden pane that already has the right size does not have to reflow
    //     when it is shown, which is what produced the flash on tab switch;
    //   * `hide()` is what actually keeps it off screen — parking at 0x0 is not
    //     reliable on macOS WKWebView (it can keep painting its last frame,
    //     which is how the dashboard stayed visible beside an open project).
    //
    // Order matters as much as the calls: SHOW the incoming pane before HIDING
    // the outgoing one. Doing it the other way round leaves a frame with
    // nothing painted, which is the flash.
    let mut to_hide = Vec::new();
    for (label, wv) in app.webviews() {
        let (visible, pos, dim) = if label == "chrome" {
            (true, (0.0, 0.0), (size.width, CHROME_H))
        } else if label == "deck" {
            (deck_active, (0.0, CHROME_H), (size.width, content_h))
        } else if let Some(i) = label.strip_prefix("tool").and_then(|n| n.parse::<usize>().ok()) {
            (Some(i) == active_idx, (0.0, CHROME_H), (size.width, content_h))
        } else {
            continue;
        };
        let _ = wv.set_position(LogicalPosition::new(pos.0, pos.1));
        let _ = wv.set_size(LogicalSize::new(dim.0, dim.1));
        if visible {
            let _ = wv.show();
        } else {
            to_hide.push(wv);
        }
    }
    for wv in to_hide {
        let _ = wv.hide();
    }
}

fn nav(app: &tauri::AppHandle, label: &str, url: &str) {
    if let Some(wv) = app.webviews().get(label).cloned() {
        if let Ok(u) = url.parse() {
            let _ = wv.navigate(u);
        }
    }
}

/// Open a tool: reuse its tab if already open, else claim a pool slot (evicting
/// the least-recently-used when full), navigate it, and make it the active tab.
#[tauri::command]
fn open_tool(app: tauri::AppHandle, id: String, name: String, url: String) -> Result<(), String> {
    let _: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    let shell = app.state::<Shell>();

    let mut navigate: Option<(usize, String)> = None; // (slot, url) to load
    let mut evict: Option<usize> = None; // slot to blank out first
    {
        let mut t = shell.tabs.lock().unwrap();
        if let Some(i) = t.slots.iter().position(|s| s.as_ref().map_or(false, |x| x.id == id)) {
            // already open — just focus it, bump to most-recent
            t.order.retain(|&x| x != i);
            t.order.push(i);
            t.active = id;
        } else {
            let idx = if let Some(free) = t.slots.iter().position(|s| s.is_none()) {
                free
            } else {
                let old = t.order.remove(0); // LRU
                t.slots[old] = None;
                evict = Some(old);
                old
            };
            t.slots[idx] = Some(Tab { id: id.clone(), name });
            t.order.push(idx);
            t.active = id;
            navigate = Some((idx, url));
        }
    }

    if let Some(old) = evict {
        nav(&app, &format!("tool{old}"), "about:blank");
    }
    if let Some((idx, url)) = navigate {
        nav(&app, &format!("tool{idx}"), &url);
    }
    relayout(&app);
    emit_tabs(&app);
    Ok(())
}

/// Switch tabs. `target` is "deck" or an open tool id.
#[tauri::command]
fn activate(app: tauri::AppHandle, target: String) -> Result<(), String> {
    {
        let shell = app.state::<Shell>();
        let mut t = shell.tabs.lock().unwrap();
        let known = target == "deck"
            || t.slots.iter().any(|s| s.as_ref().map_or(false, |x| x.id == target));
        if !known {
            return Ok(());
        }
        t.active = target;
    }
    relayout(&app);
    emit_tabs(&app);
    Ok(())
}

/// Close a tool tab: shut the tool's process down (tab list == what's running —
/// closing a tab closes the tool), free its slot, and fall back to the
/// most-recent remaining tab, or the deck if none are left.
#[tauri::command]
fn close_tool(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut blanked: Option<usize> = None;
    {
        let shell = app.state::<Shell>();
        let mut t = shell.tabs.lock().unwrap();
        if let Some(i) = t.slots.iter().position(|s| s.as_ref().map_or(false, |x| x.id == id)) {
            t.slots[i] = None;
            t.order.retain(|&x| x != i);
            blanked = Some(i);
            if t.active == id {
                t.active = t
                    .order
                    .last()
                    .and_then(|&j| t.slots[j].as_ref().map(|x| x.id.clone()))
                    .unwrap_or_else(|| "deck".into());
            }
        }
    }
    if let Some(i) = blanked {
        nav(&app, &format!("tool{i}"), "about:blank");
        // closing the tab shuts the tool down (off the UI thread)
        let stop_id = id.clone();
        std::thread::spawn(move || stop_tool_http(&stop_id));
    }
    relayout(&app);
    emit_tabs(&app);
    Ok(())
}

/// Reload every webview (chrome + dashboard + open tools). Frontend is served
/// no-store and manifests are read per-request, so a reload picks up code/manifest
/// changes without relaunching the app.
#[tauri::command]
fn reload_all(app: tauri::AppHandle) -> Result<(), String> {
    for (_label, wv) in app.webviews() {
        let _ = wv.eval("window.location.reload()");
    }
    Ok(())
}

/// The chrome bar calls this on load to seed its tab strip.
#[tauri::command]
fn get_tabs(app: tauri::AppHandle) -> serde_json::Value {
    let shell = app.state::<Shell>();
    let t = shell.tabs.lock().unwrap();
    tabs_json(&t)
}

// Stop a single Deck-spawned tool via the gateway. Fire-and-forget on its own
// thread (never blocks the UI). An externally-started tool just 409s — harmless.
fn stop_tool_http(id: &str) {
    let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port())) else { return };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(8)));
    let req = format!(
        "POST /api/tools/{id}/stop HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = s.write_all(req.as_bytes());
    let mut buf = [0u8; 256];
    let _ = s.read(&mut buf);
}

// Quit with an adopted gateway (the dev gateway, one started by hand): stop
// every Deck-spawned tool and leave the gateway itself running. Hand-rolled
// HTTP over TcpStream so the shell doesn't pull in an http crate for one request.
fn stop_all_tools() {
    let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port())) else { return };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(8)));
    let _ = s.write_all(
        b"POST /api/stop-all HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    let mut buf = [0u8; 256];
    let _ = s.read(&mut buf); // wait for the gateway to ack (it SIGTERMs children first)
}

/// True once the gateway's port answers a real HTTP request, not just a TCP
/// accept (the pantheon white-screen scar).
fn gateway_serving() -> bool {
    let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port())) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(2)));
    if s.write_all(b"GET /api/tools HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 12];
    matches!(s.read(&mut buf), Ok(n) if n > 0)
}

/// POST /api/shutdown: the gateway stops every tool within that tool's own
/// stopGraceMs and exits. Some(how long it says that can take) when it took
/// the request; None when nothing answered in time or the gateway predates
/// the route (404).
fn request_shutdown() -> Option<Duration> {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port())).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    s.write_all(b"POST /api/shutdown HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut resp = Vec::new();
    let _ = s.read_to_end(&mut resp); // the gateway closes the connection after its answer
    let text = String::from_utf8_lossy(&resp);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    // The body may arrive chunked: the JSON is what sits between the braces.
    let json = &body[body.find('{')?..=body.rfind('}')?];
    let answer: serde_json::Value = serde_json::from_str(json).ok()?;
    Some(Duration::from_millis(answer.get("graceMs")?.as_u64()?))
}

/// Stop a gateway and everything it started (`child` is Some when this app
/// spawned it): ask it to shut down, wait as long as it says its tools need,
/// SIGKILL it if it overruns that, then stop whatever is still in its process
/// group, which is what a tool left behind when it exited.
///
/// The group is swept only when the gateway leads a group of its own (this
/// shell spawns it that way) and answered the request. One that did not
/// answer is hung or older than the route, and an older gateway exits without
/// waiting for its tools: its group can still hold a tool inside its grace
/// (a world save, the VM's clean shutdown), which must not get a SIGKILL. Nor
/// may the group get even a SIGTERM: QEMU is in it, beside the VM wrapper that
/// shuts it down cleanly. A gateway SIGKILLed here leaves its tools a SIGTERM
/// each, which is what it would have sent them itself.
fn stop_gateway(pid: libc::pid_t, mut child: Option<Child>) {
    let pgid = unsafe { libc::getpgid(pid) };
    let answered = request_shutdown();
    let grace = answered.unwrap_or_else(|| {
        // SIGTERM runs the same shutdown (or an older gateway's own one).
        unsafe { libc::kill(pid, libc::SIGTERM) };
        Duration::from_secs(2)
    });
    let until = Instant::now() + grace + Duration::from_secs(3);
    while running(pid, &mut child) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    if running(pid, &mut child) {
        let tools = children_of(pid); // before its children are reparented
        unsafe { libc::kill(pid, libc::SIGKILL) };
        for tool in tools {
            unsafe { libc::kill(tool, libc::SIGTERM) };
        }
    }
    if let Some(mut c) = child {
        let _ = c.wait();
    }
    if answered.is_some() && pgid == pid {
        sweep_group(pgid, grace);
    }
}

fn running(pid: libc::pid_t, child: &mut Option<Child>) -> bool {
    match child {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => unsafe { libc::kill(pid, 0) == 0 },
    }
}

fn children_of(pid: libc::pid_t) -> Vec<libc::pid_t> {
    Command::new("/usr/bin/pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().filter_map(|s| s.parse().ok()).collect())
        .unwrap_or_default()
}

/// Whatever is still in a gateway's group after the gateway is gone outlived
/// the tool that started it. It gets SIGTERM and as long as the slowest tool's
/// grace to go (it may be a server a wrapper script did not exec), then SIGKILL.
fn sweep_group(pgid: libc::pid_t, grace: Duration) {
    let members = || unsafe { libc::kill(-pgid, 0) == 0 };
    if !members() {
        return;
    }
    unsafe { libc::kill(-pgid, libc::SIGTERM) };
    let until = Instant::now() + grace;
    while members() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe { libc::kill(-pgid, libc::SIGKILL) };
}

/// Stop what this app started: the gateway it spawned and every tool, or,
/// with an adopted gateway, the tools alone (that gateway keeps running).
/// Once, on whichever way out comes first; a second caller waits until it is
/// done.
fn shut_down(app: &tauri::AppHandle) {
    let shell = app.state::<Shell>();
    shell.shutdown.call_once(|| {
        let sidecar = shell.sidecar.lock().unwrap().take();
        match sidecar {
            Some(child) => stop_gateway(child.id() as libc::pid_t, Some(child)),
            None => stop_all_tools(),
        }
    });
}

/// AppKit's terminate: asks here first (terminate.rs): ⌘Q, the Dock's Quit,
/// a quit Apple Event, a logout. The window goes at once and the shutdown
/// runs on a thread of its own, with the run loop still turning; the quit
/// goes ahead when it is done. In RunEvent::Exit the run loop is over, so a
/// shutdown there kept the window on screen, frozen, for as long as the
/// slowest tool took to stop.
fn terminate_requested(app: &tauri::AppHandle) -> terminate::Answer {
    let shell = app.state::<Shell>();
    if shell.shutdown.is_completed() {
        return terminate::Answer::Now;
    }
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return terminate::Answer::Cancel; // already on its way out: the first terminate: still waits
    }
    if let Some(window) = app.get_window("main") {
        terminate::without_animation(&window);
        let _ = window.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        shut_down(&app);
        terminate::reply(&app, true);
    });
    terminate::Answer::Later
}

/// The process on the gateway's port when it is a stale gateway: this bundle's
/// own deck-server (the same executable path; proc_pidpath keeps reporting it
/// after the bundle is reinstalled) whose app is gone (reparented to launchd).
fn stale_gateway(sidecar: &Path) -> Option<libc::pid_t> {
    let ours = sidecar.canonicalize().ok()?;
    let out = Command::new("/usr/sbin/lsof")
        .args(["-nP", &format!("-iTCP:{}", port()), "-sTCP:LISTEN", "-t"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .find(|&pid| {
            let path = exe_path(pid);
            let path = path.as_deref().map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()));
            path.as_deref() == Some(ours.as_path()) && parent_of(pid) == Some(1)
        })
}

fn exe_path(pid: libc::pid_t) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    Some(PathBuf::from(std::ffi::OsString::from_vec(buf)))
}

fn parent_of(pid: libc::pid_t) -> Option<libc::pid_t> {
    let mut info: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdshortinfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, (&mut info as *mut libc::proc_bsdshortinfo).cast(), size)
    };
    (n == size).then_some(info.pbsi_ppid as libc::pid_t)
}

/// Reuse a healthy gateway, else spawn the bundled sidecar binary (lives next
/// to the app exe; `externalBin` strips the target triple). DECK_ROOT points it
/// at the real deck checkout so manifests/state/UI stay on disk, editable; a
/// DECK_ROOT already in the environment wins (a build tested from a worktree).
///
/// A stale gateway on the port (see stale_gateway) is not adopted: nothing
/// would ever stop it, and it may be older code than this bundle. It is
/// stopped the way a quit would have stopped it, and replaced. Anything else
/// there is adopted: the dev gateway, one started by hand, the sidecar of a
/// Deck that is still open, a deck-server from another bundle.
fn ensure_gateway() -> Option<Child> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let sidecar = exe_dir.join("deck-server");
    if std::net::TcpStream::connect(("127.0.0.1", port())).is_ok() {
        match stale_gateway(&sidecar) {
            Some(pid) => stop_gateway(pid, None),
            None if gateway_serving() => return None, // adopt
            None => {} // something unresponsive holds the port; the spawn below fails loudly
        }
    }
    let deck_root = std::env::var_os("DECK_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs_home().join("yt").join("deck"));
    let child = Command::new(&sidecar)
        .env("DECK_ROOT", &deck_root)
        .current_dir(&deck_root)
        // A process group of its own, which its tools join: a quit can then
        // reach what a tool leaves behind without signalling the app itself.
        .process_group(0)
        .spawn()
        .ok()?;
    for _ in 0..80 {
        if gateway_serving() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Some(child)
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
}

fn main() {
    let sidecar = ensure_gateway();
    tauri::Builder::default()
        .manage(Shell {
            tabs: Mutex::new(Tabs {
                active: "deck".into(),
                slots: vec![None; POOL],
                order: Vec::new(),
            }),
            sidecar: Mutex::new(sidecar),
            shutdown: Once::new(),
            quitting: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![open_tool, close_tool, activate, get_tabs, reload_all])
        .setup(|app| {
            let handle = app.handle().clone();
            if !terminate::install(&handle) {
                eprintln!("Deck: could not add applicationShouldTerminate:, so a quit keeps the window up until the gateway is down");
            }
            let window = tauri::window::WindowBuilder::new(&handle, "main")
                .title("Deck")
                .inner_size(1480.0, 940.0)
                .min_inner_size(1040.0, 660.0)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                // The window's own ground, behind and between the webviews.
                // Left unset it is white, which shows through anywhere a
                // webview has not painted yet.
                .background_color(BG)
                .build()?;

            // Pool of tool webviews FIRST (bottom layer), all parked at 0×0.
            for i in 0..POOL {
                window.add_child(
                    tauri::webview::WebviewBuilder::new(
                        format!("tool{i}"),
                        WebviewUrl::External("about:blank".parse().unwrap()),
                    )
                    .background_color(BG),
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(0.0, 0.0),
                )?;
            }
            // The dashboard ("home" tab) below the chrome bar.
            window.add_child(
                tauri::webview::WebviewBuilder::new(
                    "deck",
                    WebviewUrl::External(gateway_url().parse().unwrap()),
                )
                .background_color(BG),
                LogicalPosition::new(0.0, CHROME_H),
                LogicalSize::new(10.0, 10.0),
            )?;
            // The tab bar LAST so it stacks on top.
            window.add_child(
                tauri::webview::WebviewBuilder::new(
                    "chrome",
                    WebviewUrl::External(format!("{}/chrome.html", gateway_url()).parse().unwrap()),
                )
                .background_color(BG),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(10.0, CHROME_H),
            )?;

            relayout(&handle);

            let h2 = handle.clone();
            window.on_window_event(move |event| {
                // Resized alone is not enough: a window that opens at its final
                // size never fires one, and moving between displays with
                // different scale factors changes the logical size without a
                // Resized event. Relayout on all of them.
                if matches!(
                    event,
                    tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::Moved(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. }
                        | tauri::WindowEvent::Focused(true)
                ) {
                    relayout(&h2);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Deck")
        .run(|app, event| {
            // Exit, not ExitRequested: ⌘Q, the Dock's Quit and a quit Apple
            // Event all go through AppKit's terminate:, which tao reports only
            // as LoopDestroyed, i.e. RunEvent::Exit. ExitRequested fires only
            // when the last window closes, so a hook there let ⌘Q leave the
            // gateway and every tool running (orphaned for days, 2026-10-12).
            // Exit comes on every way out. After a terminate: the shutdown
            // has run already (terminate_requested) and this returns at once;
            // the closed window has no terminate:, so its shutdown runs here.
            // So does every quit's when the terminate: hook could not be
            // added, and then the window stays on screen while this waits:
            // the run loop has ended, so a hide() would never reach the
            // window server.
            if let tauri::RunEvent::Exit = event {
                shut_down(app);
            }
        });
}
