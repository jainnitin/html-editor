use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_RECENTS: usize = 10;

/// Files handed to us by Finder before the webview was ready to receive events.
#[derive(Default)]
struct Startup {
    pending: Mutex<Vec<String>>,
    ready: AtomicBool,
}

/// Read any file the user picked in a native dialog, dropped on the window,
/// or opened from Finder.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Write the edited document back to disk. On the first save of a given file we
/// stash the untouched original next to it, so a bad edit is always recoverable.
/// Returns whether a backup was actually created.
#[tauri::command]
fn write_text_file(path: String, contents: String, backup: bool) -> Result<bool, String> {
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

/// The bundle id of whatever handles `https:` — i.e. the user's real browser.
/// We deliberately do not use the `public.html` handler: this app registers as
/// an editor for .html and could itself become that handler.
#[cfg(target_os = "macos")]
fn default_browser_bundle_id() -> Option<String> {
    let plist = dirs_home()?
        .join("Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    let out = std::process::Command::new("plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(&plist)
        .output()
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let handlers = json.get("LSHandlers")?.as_array()?;
    let id = handlers.iter().find_map(|h| {
        let scheme = h.get("LSHandlerURLScheme")?.as_str()?;
        (scheme == "https" || scheme == "http")
            .then(|| h.get("LSHandlerRoleAll")?.as_str().map(str::to_owned))
            .flatten()
    })?;
    (id != "com.nitin.htmleditor").then_some(id)
}

#[cfg(target_os = "macos")]
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Open the saved file in the user's web browser. Implemented here rather than
/// through the opener plugin, whose `open_path` command is filesystem-scoped and
/// would need a blanket allow-list to work on arbitrary user-chosen files.
#[tauri::command]
fn open_in_browser(path: String) -> Result<String, String> {
    if !Path::new(&path).exists() {
        return Err(format!("{path} no longer exists"));
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        let browser = default_browser_bundle_id();
        if let Some(id) = &browser {
            cmd.arg("-b").arg(id);
        }
        let out = cmd.arg(&path).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(browser.unwrap_or_else(|| "default application".into()));
        }
        // A stale or wrong bundle id should not be fatal — retry with the
        // system default handler.
        if browser.is_some() {
            let retry = std::process::Command::new("open")
                .arg(&path)
                .output()
                .map_err(|e| e.to_string())?;
            if retry.status.success() {
                return Ok("default application".into());
            }
            return Err(String::from_utf8_lossy(&retry.stderr).trim().to_string());
        }
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("unsupported platform".into())
    }
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
}

impl Default for Settings {
    fn default() -> Self {
        Self { recents: Vec::new(), autosave: true }
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
            Settings { recents, autosave: true }
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

    let app_menu = Submenu::with_items(
        app,
        "HTML Editor",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Startup::default())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            frontend_ready,
            push_recent,
            clear_recents,
            get_settings,
            set_autosave,
            open_in_browser
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
