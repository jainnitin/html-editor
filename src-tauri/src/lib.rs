use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;
use serde::{Deserialize, Serialize};
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_RECENTS: usize = 10;

/// Files handed to us by Finder before the webview was ready to receive events.
#[derive(Default)]
struct Startup {
    pending: Mutex<Vec<String>>,
    ready: AtomicBool,
}

/// Paths the user has explicitly chosen, via the native file dialogs, a Finder
/// "Open With", or a drag onto the window.
///
/// This exists because an opened document is not trusted input. The report is
/// rendered in a `srcdoc` iframe, which is same-origin with the app, so any
/// script inside it can reach `parent.__TAURI_INTERNALS__` and call these
/// commands directly. Without this gate, merely opening a file would grant that
/// file's scripts arbitrary read and write access to the user's disk.
///
/// Only Rust may add to this set, and only in response to a user gesture.
#[derive(Default)]
struct Authorized(Mutex<HashSet<PathBuf>>);

impl Authorized {
    fn allow(&self, path: impl Into<PathBuf>) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(path.into());
        }
    }

    /// Compare canonical paths so `/tmp/x` and `/private/tmp/x`, or any `..`
    /// trickery, cannot slip past the check.
    fn check(&self, path: &str) -> Result<(), String> {
        let want = Path::new(path);
        let want = want.canonicalize().unwrap_or_else(|_| want.to_path_buf());
        let ok = self
            .0
            .lock()
            .map(|set| {
                set.iter().any(|p| {
                    p == &want || p.canonicalize().map(|c| c == want).unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if ok {
            Ok(())
        } else {
            Err(format!(
                "{path} was not opened by you in this session, so it cannot be read or written"
            ))
        }
    }
}

fn filters() -> (&'static str, Vec<&'static str>) {
    ("HTML", vec!["html", "htm", "bak"])
}

/// Show the open dialog and return the chosen file with its contents. The
/// dialog lives in Rust so that picking a file is what grants access to it.
#[tauri::command]
async fn open_document(app: AppHandle) -> Result<Option<(String, String)>, String> {
    let (name, exts) = filters();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(name, &exts)
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| (app, p))
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some((app, path)) = picked else {
        return Ok(None);
    };
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    app.state::<Authorized>().allow(path.clone());
    Ok(Some((path.to_string_lossy().into_owned(), text)))
}

/// Show the save dialog and return the chosen destination, authorizing it.
#[tauri::command]
async fn pick_save_path(app: AppHandle, suggested: String) -> Result<Option<String>, String> {
    let (name, exts) = filters();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(name, &exts)
            .set_file_name(suggested)
            .blocking_save_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| (app, p))
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some((app, path)) = picked else {
        return Ok(None);
    };
    app.state::<Authorized>().allow(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Read any file the user picked in a native dialog, dropped on the window,
/// or opened from Finder.
#[tauri::command]
fn read_text_file(auth: State<Authorized>, path: String) -> Result<String, String> {
    auth.check(&path)?;
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Write the edited document back to disk. On the first save of a given file we
/// stash the untouched original next to it, so a bad edit is always recoverable.
/// Returns whether a backup was actually created.
#[tauri::command]
fn write_text_file(
    auth: State<Authorized>,
    path: String,
    contents: String,
    backup: bool,
) -> Result<bool, String> {
    auth.check(&path)?;
    let mut made = false;
    if backup {
        let bak = format!("{path}.bak");
        if Path::new(&path).exists() && !Path::new(&bak).exists() {
            fs::copy(&path, &bak).map_err(|e| format!("{bak}: {e}"))?;
            made = true;
        }
    }
    fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))?;
    Ok(made)
}

/* ---------------- platform shims ---------------- */

/// Launch a URL or path with the platform's default handler.
fn shell_open(target: &str, reveal: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        if reveal {
            c.arg("-R");
        }
        c.arg(target);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        if reveal {
            let mut c = std::process::Command::new("explorer.exe");
            c.arg(format!("/select,{target}"));
            c
        } else {
            // `start` is a cmd builtin; the empty string is the window title,
            // which `start` would otherwise take from a quoted first argument.
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "start", "", target]);
            c
        }
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new(if reveal { "nautilus" } else { "xdg-open" });
        c.arg(target);
        c
    };

    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "the system could not open it".into() } else { err })
    }
}

/// The application registered for `https:` — i.e. the user's real browser.
///
/// We deliberately avoid the HTML file association: this app registers itself
/// as an editor for `.html`, so opening the file with its default handler could
/// simply reopen it here.
fn default_browser() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let plist = std::env::var_os("HOME").map(PathBuf::from)?.join(
            "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
        );
        let out = std::process::Command::new("plutil")
            .args(["-convert", "json", "-o", "-"])
            .arg(&plist)
            .output()
            .ok()?;
        let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        let id = json.get("LSHandlers")?.as_array()?.iter().find_map(|h| {
            let scheme = h.get("LSHandlerURLScheme")?.as_str()?;
            matches!(scheme, "https" | "http")
                .then(|| h.get("LSHandlerRoleAll")?.as_str().map(str::to_owned))
                .flatten()
        })?;
        (id != "com.nitin.htmleditor").then_some(id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Open the saved file in the user's web browser.
///
/// Implemented here rather than through the opener plugin, whose `open_path`
/// command is filesystem-scoped and would need a blanket allow-list to work on
/// arbitrary user-chosen files.
#[tauri::command]
fn open_in_browser(auth: State<Authorized>, path: String) -> Result<String, String> {
    auth.check(&path)?;
    if !Path::new(&path).exists() {
        return Err(format!("{path} no longer exists"));
    }

    #[cfg(target_os = "macos")]
    if let Some(id) = default_browser() {
        let out = std::process::Command::new("open")
            .args(["-b", &id])
            .arg(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(id);
        }
        // A stale bundle id should not be fatal; fall through to the default
        // handler below.
    }

    shell_open(&path, false).map(|()| "default application".to_string())
}

/// Open a link from the document in the user's browser.
///
/// Documents are untrusted, so the scheme is allow-listed: `file:` and `smb:`
/// would let a report pull in arbitrary local or remote content, and custom
/// schemes can hand off to other installed applications.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let scheme = url.split(':').next().unwrap_or_default().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "mailto") {
        return Err(format!("refusing to open a \"{scheme}\" URL"));
    }
    shell_open(&url, false)
}

/// Show the file in the platform's file manager.
#[tauri::command]
fn reveal_in_finder(auth: State<Authorized>, path: String) -> Result<(), String> {
    auth.check(&path)?;
    shell_open(&path, true)
}

/// Called once the UI is listening. Returns anything Finder queued up first.
#[tauri::command]
fn frontend_ready(state: State<Startup>) -> Vec<String> {
    state.ready.store(true, Ordering::SeqCst);
    state
        .pending
        .lock()
        .map(|mut q| q.drain(..).collect())
        .unwrap_or_default()
}

/* ---------------- persisted settings ---------------- */

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    #[serde(default)]
    recents: Vec<String>,
    #[serde(default = "yes")]
    autosave: bool,
    /// Anonymous usage reporting. Honoured on load; set to false in
    /// settings.json to disable.
    #[serde(default = "yes")]
    telemetry: bool,
    /// Random per-installation id. Not derived from anything about the machine
    /// or the user, and reset by clearing the settings file.
    #[serde(default)]
    install_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            recents: Vec::new(),
            autosave: true,
            telemetry: true,
            install_id: String::new(),
        }
    }
}

fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Settings from disk, with recents pruned of anything that has since moved or
/// been deleted.
fn load_settings(app: &AppHandle) -> Settings {
    let Some(dir) = config_dir(app) else {
        return Settings::default();
    };
    let mut s: Settings = fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| {
            // Migrate the older recents-only store.
            let recents = fs::read_to_string(dir.join("recents.json"))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();
            Settings { recents, ..Settings::default() }
        });
    s.recents.retain(|p| Path::new(p).exists());
    s
}

fn store_settings(app: &AppHandle, s: &Settings) {
    if let (Some(dir), Ok(json)) = (config_dir(app), serde_json::to_string_pretty(s)) {
        let _ = fs::write(dir.join("settings.json"), json);
    }
}

fn refresh_menu(app: &AppHandle) {
    let s = load_settings(app);
    if let Ok(menu) = build_menu(app, &s) {
        let _ = app.set_menu(menu);
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

#[tauri::command]
fn set_autosave(app: AppHandle, on: bool) {
    let mut s = load_settings(&app);
    s.autosave = on;
    store_settings(&app, &s);
    refresh_menu(&app);
}

/// Persist the anonymous installation id the frontend generated.
#[tauri::command]
fn set_install_id(app: AppHandle, id: String) {
    let mut s = load_settings(&app);
    if s.install_id.is_empty() {
        s.install_id = id;
        store_settings(&app, &s);
    }
}

/// Coarse environment facts for telemetry. Deliberately excludes hostname,
/// username, locale and anything else that could narrow down an individual.
#[tauri::command]
fn environment() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
fn push_recent(app: AppHandle, path: String) {
    let mut s = load_settings(&app);
    s.recents.retain(|p| p != &path);
    s.recents.insert(0, path);
    s.recents.truncate(MAX_RECENTS);
    store_settings(&app, &s);
    refresh_menu(&app);
}

#[tauri::command]
fn clear_recents(app: AppHandle) {
    let mut s = load_settings(&app);
    s.recents.clear();
    store_settings(&app, &s);
    refresh_menu(&app);
}

/* ---------------- menu ---------------- */

/// Show just the file name, but disambiguate with the parent folder when two
/// recents share one.
fn recent_label(path: &str, all: &[String]) -> String {
    let p = Path::new(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let clashes = all
        .iter()
        .filter(|o| Path::new(o).file_name() == p.file_name())
        .count();
    if clashes > 1 {
        if let Some(parent) = p.parent().and_then(|d| d.file_name()) {
            return format!("{name}  —  {}", parent.to_string_lossy());
        }
    }
    name
}

fn build_menu(app: &AppHandle, settings: &Settings) -> tauri::Result<Menu<tauri::Wry>> {
    let recents: &[String] = &settings.recents;
    let item = |id: &str, label: &str, accel: Option<&str>| {
        MenuItem::with_id(app, id, label, true, accel)
    };

    let recent_menu = if recents.is_empty() {
        Submenu::with_items(
            app,
            "Open Recent",
            true,
            &[&MenuItem::with_id(app, "recent_none", "No Recent Files", false, None::<&str>)?],
        )?
    } else {
        let items = recents
            .iter()
            .map(|p| MenuItem::with_id(app, format!("recent:{p}"), recent_label(p, recents), true, None::<&str>))
            .collect::<tauri::Result<Vec<_>>>()?;
        let sub = Submenu::new(app, "Open Recent", true)?;
        for i in &items {
            sub.append(i)?;
        }
        sub.append(&PredefinedMenuItem::separator(app)?)?;
        sub.append(&item("recent_clear", "Clear Menu", None)?)?;
        sub
    };

    // macOS shows `credits` and `copyright` in the About panel but ignores
    // `authors`, which is kept for the other platforms.
    let about = AboutMetadata {
        name: Some("HTML Editor".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        authors: Some(vec!["Nitin Jain".into()]),
        credits: Some("Created by Nitin Jain".into()),
        copyright: Some("\u{00a9} 2026 Nitin Jain".into()),
        comments: Some("Hand-tweak generated HTML reports.".into()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        "HTML Editor",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About HTML Editor"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("open", "Open…", Some("CmdOrCtrl+O"))?,
            &recent_menu,
            &PredefinedMenuItem::separator(app)?,
            &item("save", "Save", Some("CmdOrCtrl+S"))?,
            &item("save_as", "Save As…", Some("Shift+CmdOrCtrl+S"))?,
            &item("save_copy", "Save a Copy…", Some("Alt+CmdOrCtrl+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "toggle_autosave", "Auto-save", true, settings.autosave, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &item("browser", "Open in Browser", Some("Shift+CmdOrCtrl+B"))?,
            &item("reveal", "Reveal in Finder", Some("Shift+CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &item("undo", "Undo", Some("CmdOrCtrl+Z"))?,
            &item("redo", "Redo", Some("Shift+CmdOrCtrl+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("find", "Find & Replace…", Some("CmdOrCtrl+F"))?,
        ],
    )?;

    let format_menu = Submenu::with_items(
        app,
        "Format",
        true,
        &[
            &item("bold", "Bold", Some("CmdOrCtrl+B"))?,
            &item("italic", "Italic", Some("CmdOrCtrl+I"))?,
            &item("underline", "Underline", Some("CmdOrCtrl+U"))?,
            &item("strike", "Strikethrough", Some("Shift+CmdOrCtrl+X"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("link", "Hyperlink…", Some("CmdOrCtrl+K"))?,
            &item("unlink", "Remove Link", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("clear", "Clear Formatting", None)?,
        ],
    )?;

    let tools_menu = Submenu::with_items(
        app,
        "Tools",
        true,
        &[
            &item("mode_edit", "Editing", Some("CmdOrCtrl+E"))?,
            &item("mode_view", "Viewing", Some("Shift+CmdOrCtrl+E"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("toggle_trim", "Trim Blocks", Some("CmdOrCtrl+D"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("audit", "Link Audit…", Some("Shift+CmdOrCtrl+L"))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &format_menu, &tools_menu],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Startup::default())
        .manage(Authorized::default())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            frontend_ready,
            push_recent,
            clear_recents,
            get_settings,
            set_autosave,
            set_install_id,
            environment,
            open_in_browser,
            open_document,
            pick_save_path,
            open_external_url,
            reveal_in_finder
        ])
        .setup(|app| {
            let handle = app.handle();
            let menu = build_menu(handle, &load_settings(handle))?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let auth = window.state::<Authorized>();
                for p in paths {
                    auth.allow(p.clone());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if paths.is_empty() {
                return;
            }
            if let Some(auth) = handle.try_state::<Authorized>() {
                for p in &paths {
                    auth.allow(PathBuf::from(p));
                }
            }
            let Some(state) = handle.try_state::<Startup>() else {
                return;
            };
            if state.ready.load(Ordering::SeqCst) {
                let _ = handle.emit("open-files", paths);
            } else if let Ok(mut q) = state.pending.lock() {
                q.extend(paths);
            }
        }
    });
}
