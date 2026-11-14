fn main() {
    // The app's own commands get an ACL manifest, so Tauri refuses each of them unless a
    // capability grants it; bridge.rs grants them to the panel's exact origin at run time.
    // Keep this list equal to bridge::COMMANDS (a test checks).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_folder",
            "pick_file",
            "get_zoom",
            "set_zoom",
            "zoom_key",
            "open_external",
            "open_profile_folder",
            "open_microsoft_login",
            "restart_core",
            "focus_window",
        ]),
    ))
    .expect("tauri-build");
}
