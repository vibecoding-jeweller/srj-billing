mod db;

use base64::Engine;
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

struct AppState {
    conn: Mutex<Connection>,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn db_select(state: State<AppState>, sql: String, args: Vec<Value>) -> CmdResult<Vec<Map<String, Value>>> {
    let conn = state.conn.lock().map_err(err)?;
    db::select(&conn, &sql, &args).map_err(err)
}

#[tauri::command]
fn db_execute(state: State<AppState>, sql: String, args: Vec<Value>) -> CmdResult<db::ExecResult> {
    let conn = state.conn.lock().map_err(err)?;
    db::execute(&conn, &sql, &args).map_err(err)
}

#[tauri::command]
fn save_invoice(state: State<AppState>, invoice: db::NewInvoice) -> CmdResult<db::SavedInvoice> {
    let mut conn = state.conn.lock().map_err(err)?;
    db::save_invoice(&mut conn, &invoice).map_err(err)
}

#[tauri::command]
fn cancel_invoice(state: State<AppState>, id: i64, reason: String) -> CmdResult<usize> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err("A reason is required to cancel a bill".into());
    }
    let conn = state.conn.lock().map_err(err)?;
    db::cancel_invoice(&conn, id, reason).map_err(err)
}

#[tauri::command]
fn write_file(path: String, data_b64: String) -> CmdResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).map_err(err)?;
    let p = PathBuf::from(&path);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    // write to a temp file then rename, so a half-written PDF never appears
    let tmp = p.with_extension("pdf.tmp");
    std::fs::write(&tmp, bytes).map_err(err)?;
    std::fs::rename(&tmp, &p).map_err(err)
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
fn default_bills_folder(app: tauri::AppHandle) -> CmdResult<String> {
    let docs = app.path().document_dir().map_err(err)?;
    Ok(docs.join("SRJ Bills").to_string_lossy().to_string())
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    app.opener().open_path(path, None::<&str>).map_err(err)
}

/// macOS WKWebView ignores window.print(); use the native print dialog instead.
#[tauri::command]
fn print_window(window: tauri::WebviewWindow) -> CmdResult<()> {
    window.print().map_err(err)
}

fn setting_str(conn: &Connection, key: &str) -> Option<String> {
    let rows = db::select(conn, "SELECT value FROM settings WHERE key = ?1", &[Value::from(key)]).ok()?;
    let raw = rows.first()?.get("value")?.as_str()?.to_string();
    let s: String = serde_json::from_str(&raw).ok()?;
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Copy file if missing at dest or of a different size.
fn copy_if_changed(src: &Path, dest: &Path) -> std::io::Result<bool> {
    let src_len = std::fs::metadata(src)?.len();
    if let Ok(m) = std::fs::metadata(dest) {
        if m.len() == src_len {
            return Ok(false);
        }
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::copy(src, dest)?;
    Ok(true)
}

fn sync_dir(src: &Path, dest: &Path, copied: &mut usize) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let target = dest.join(entry.file_name());
        if path.is_dir() {
            sync_dir(&path, &target, copied)?;
        } else if path.extension().map(|e| e == "pdf").unwrap_or(false) && copy_if_changed(&path, &target)? {
            *copied += 1;
        }
    }
    Ok(())
}

/// Copies the database and any new bill PDFs into the backup folder (e.g. inside Google Drive).
fn run_backup(conn: &Connection) -> Result<String, String> {
    let Some(backup) = setting_str(conn, "backupFolder") else {
        return Ok("No backup folder set".into());
    };
    let backup = PathBuf::from(backup);
    std::fs::create_dir_all(&backup).map_err(|e| format!("Backup folder not reachable: {e}"))?;
    let tmp = backup.join("srj-billing.db.tmp");
    db::snapshot_to(conn, &tmp).map_err(err)?;
    std::fs::rename(&tmp, backup.join("srj-billing.db")).map_err(err)?;
    let mut copied = 0;
    if let Some(bills) = setting_str(conn, "billsFolder") {
        let bills = PathBuf::from(bills);
        if bills.is_dir() {
            sync_dir(&bills, &backup.join("Bills"), &mut copied).map_err(err)?;
        }
    }
    Ok(format!("Backed up database and {copied} new PDF(s)"))
}

#[tauri::command]
fn backup_now(state: State<AppState>) -> CmdResult<String> {
    let conn = state.conn.lock().map_err(err)?;
    run_backup(&conn)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // SRJ_DATA_DIR lets testers use a throwaway database instead of the real one.
            let dir = match std::env::var_os("SRJ_DATA_DIR") {
                Some(d) => PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("srj-billing.db"))?;
            app.manage(AppState { conn: Mutex::new(conn) });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                if let Ok(conn) = state.conn.lock() {
                    let _ = run_backup(&conn);
                };
            }
        })
        .invoke_handler(tauri::generate_handler![
            db_select,
            db_execute,
            save_invoice,
            cancel_invoice,
            write_file,
            file_exists,
            default_bills_folder,
            open_path,
            print_window,
            backup_now
        ])
        .run(tauri::generate_context!())
        .expect("error while running SRJ Billing");
}
