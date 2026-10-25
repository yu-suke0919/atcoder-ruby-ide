#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod desktop {
    use serde::Serialize;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{Emitter, Manager};
    use tauri_size_probe::{RunResult, Runner};

    fn ruby(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        app.path()
            .resolve("ruby/bin/ruby.exe", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())
    }

    #[derive(Serialize)]
    struct RubyInfo {
        version: String,
        path: String,
    }

    #[tauri::command]
    fn ruby_info(app: tauri::AppHandle) -> Result<RubyInfo, String> {
        use std::os::windows::process::CommandExt;
        let path = ruby(&app)?;
        let output = std::process::Command::new(&path)
            .arg("--version")
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("同梱 Ruby を起動できません。".into());
        }
        Ok(RubyInfo {
            version: String::from_utf8_lossy(&output.stdout).trim().into(),
            path: path.to_string_lossy().into(),
        })
    }

    #[tauri::command]
    async fn run_ruby(
        app: tauri::AppHandle,
        runner: tauri::State<'_, Arc<Runner>>,
        code: String,
        stdin: String,
    ) -> Result<RunResult, String> {
        let path = ruby(&app)?;
        let runner = Arc::clone(runner.inner());
        tauri::async_runtime::spawn_blocking(move || {
            runner.run(&path, &code, &stdin, move |output| {
                let _ = app.emit("ruby-output", output);
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    fn stop_ruby(runner: tauri::State<'_, Arc<Runner>>) -> bool {
        runner.stop()
    }

    pub fn start() {
        tauri::Builder::default()
            .manage(Runner::new(Duration::from_secs(5), 1048576))
            .invoke_handler(tauri::generate_handler![ruby_info, run_ruby, stop_ruby])
            .build(tauri::generate_context!())
            .expect("Tauri prototype failed to build")
            .run(|app, event| {
                if let tauri::RunEvent::ExitRequested { .. } = event {
                    app.state::<Arc<Runner>>().stop();
                }
            });
    }
}

fn main() {
    #[cfg(windows)]
    desktop::start();
    #[cfg(not(windows))]
    eprintln!("The size probe GUI targets Windows; runner tests also run on Linux.");
}
