//! chordMatik Rust core: audio decode, DSP, chord analysis. Playback lives in
//! the webview; this side does analysis only.

mod audio;
mod cache;
mod chords;
mod commands;
mod dsp;
mod ml;
mod platform;
mod ug;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Lets the footer's "Restart now" apply a staged update immediately.
        .plugin(tauri_plugin_process::init())
        .manage(commands::CaptureState::default())
        .manage(commands::LiveState::default())
        .setup(|app| {
            // Downloaded/captured audio is KEPT across runs (not swept on
            // startup/exit) so reopening a song tab after a restart is instant —
            // no re-download/re-analyze. Clear manually via `cleanup_temp_audio`.

            // Custom menu that OMITS Window > Close (Cmd+W) so the webview can use
            // Cmd+W to close a song TAB instead of the whole window. Keeps Quit,
            // clipboard, and minimize.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                let app_menu = SubmenuBuilder::new(app, "chordMatik")
                    .about(None)
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                // NO Undo/Redo items: a menu accelerator swallows Cmd+Z before the
                // webview sees it, and the app's own sync-history undo (TabsPanel)
                // needs the DOM keydown. Text fields keep WebKit's built-in undo.
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::load_audio,
            commands::analyze_chords,
            commands::library_list,
            commands::library_remove,
            commands::find_matching_audio,
            commands::download_youtube_audio,
            commands::fetch_tabs,
            commands::fetch_tab_track,
            commands::fetch_bass_tab,
            commands::fetch_bass_tab_content,
            commands::fetch_lyrics,
            commands::refine_sync,
            commands::detect_beat,
            commands::track_beats,
            commands::cleanup_temp_audio,
            commands::download_model,
            commands::model_present,
            commands::transcribe_bass,
            commands::start_system_capture,
            commands::stop_system_capture,
            commands::start_live,
            commands::stop_live,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // Intentionally a no-op: downloaded/captured temp audio is kept across
            // quits so reopening tabs after a restart stays instant (the owner's
            // explicit "don't delete on quit" rule).
        });
}
