fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ruby_info",
            "lsp_start",
            "lsp_complete",
            "lsp_stop",
            "run_ruby",
            "stop_ruby",
            "document_open",
            "document_save",
            "document_new",
            "samples_open",
            "samples_save",
            "confirm_discard",
            "problem_open",
            "problem_refresh",
            "problem_save_cases",
            "collection_list",
            "collection_register",
            "collection_fetch_task",
            "collection_repair_task",
            "collection_open_task",
            "spike_fetch",
            "spike_navigate",
            "spike_loads",
            "spike_read_dom",
            "spike_set_visible",
        ]),
    ))
    .expect("failed to run tauri-build");
}
