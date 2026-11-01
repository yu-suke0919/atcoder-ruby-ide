fn main() {
    // Declaring the commands makes every call pass the capability check, so only the
    // app's own page (the "main" webview) can call them, never the AtCoder pages.
    #[cfg(feature = "desktop")]
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ruby_info",
            "lsp_start",
            "lsp_complete",
            "lsp_stop",
            "run_ruby",
            "stop_ruby",
            "document_save",
            "session_reset",
            "contest_list",
            "contest_register",
            "contest_set_hidden",
            "task_open",
            "task_save_cases",
            "browser_layout",
            "browser_visible",
            "browser_home",
            "browser_task",
            "browser_close_tasks",
            "browser_open",
            "browser_history",
            "browser_reload",
        ]),
    ))
    .expect("failed to run tauri-build");
}
