fn main() {
    // App commands must be declared to Tauri v2's ACL — this generates the
    // allow-open-tool / allow-close-tool permissions the capability references.
    // Without it every invoke from the deck webview dies with
    // "Command open_tool not allowed by ACL".
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&["open_tool", "close_tool", "activate", "get_tabs"]),
        ),
    )
    .expect("failed to run tauri-build");
}
