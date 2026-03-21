use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::Path;

// ── Data model ────────────────────────────────────────────────
//
// These mirror the JavaScript data structures so Rust can
// deserialise, normalise, and re-serialise project files with
// proper type checking.

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Pad {
    id: String,
    label: String,
    file_path: String,
    color: String,
    #[serde(default = "default_volume")]
    volume: f64,
    #[serde(default)]
    fade_in: f64,
    #[serde(default)]
    fade_out: f64,
    #[serde(rename = "loop", default)]
    loop_: bool,
    #[serde(default)]
    retrigger: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Step {
    id: String,
    pad_id: String,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    crossfade_next: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Sequence {
    id: String,
    name: String,
    #[serde(default)]
    default_crossfade: f64,
    #[serde(default)]
    steps: Vec<Step>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Project {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    pads: Vec<Pad>,
    #[serde(default)]
    sequences: Vec<Sequence>,
}

fn default_volume() -> f64 {
    0.8
}
fn default_version() -> u32 {
    1
}

// ── Commands ──────────────────────────────────────────────────

/// Read an audio file and return it as a base64 data URL.
#[tauri::command]
fn read_audio_dataurl(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    let mime = match ext.as_deref() {
        Some("mp3")  => "audio/mpeg",
        Some("wav")  => "audio/wav",
        Some("ogg")  => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("aac")  => "audio/aac",
        Some("m4a")  => "audio/mp4",
        Some("opus") => "audio/ogg; codecs=opus",
        Some("webm") => "audio/webm",
        _            => "audio/mpeg",
    };
    let b64 = general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// Write a project JSON string to `path`, creating parent directories as needed.
#[tauri::command]
fn save_project(path: String, content: String) -> Result<(), String> {
    // Validate and normalise project data before writing.
    let project: Project = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse project: {}", e))?;
    let normalised = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;

    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, normalised.as_bytes()).map_err(|e| e.to_string())
}

/// Read a project file and return its contents as a JSON string,
/// normalising missing / legacy fields before returning.
#[tauri::command]
fn load_project(path: String) -> Result<String, String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Deserialise, apply serde defaults (normalisation), re-serialise.
    let project: Project = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse project: {}", e))?;
    serde_json::to_string(&project).map_err(|e| e.to_string())
}

/// Return a serialised default project containing one blank sequence.
/// Used by the frontend to seed the initial state without needing to
/// round-trip through the filesystem.
#[tauri::command]
fn default_project() -> String {
    let project = Project {
        version: 1,
        pads: vec![],
        sequences: vec![Sequence {
            id: uuid_v4(),
            name: "New Sequence".to_string(),
            default_crossfade: 0.0,
            steps: vec![],
        }],
    };
    serde_json::to_string(&project).unwrap_or_else(|_| "{}".to_string())
}

/// Generate a simple UUID v4 (random).
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Deterministic-ish seed using time; good enough for our use case.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        nanos,
        (nanos >> 16) & 0xffff,
        (nanos >> 4)  & 0x0fff,
        0x8000 | ((nanos >> 8) & 0x3fff),
        nanos as u64 * 0x10000 + (nanos >> 12) as u64,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_audio_dataurl,
            save_project,
            load_project,
            default_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
