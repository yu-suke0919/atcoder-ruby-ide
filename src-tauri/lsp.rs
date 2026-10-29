use crate::process::ProcessTree;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_MESSAGE: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct LspInfo {
    pub pid: u32,
    pub position_encoding: String,
}

#[derive(Default)]
pub struct RubyLsp {
    session: Mutex<Option<Session>>,
}

impl RubyLsp {
    pub fn start(&self, ruby: &Path, resources: &Path) -> Result<LspInfo, String> {
        let mut active = self.session.lock().unwrap();
        if let Some(session) = active.as_mut() {
            if matches!(session.child.try_wait(), Ok(None)) {
                return Ok(session.info());
            }
        }
        active.take();
        let mut session = Session::spawn(ruby, resources)?;
        let uri = session.uri.clone();
        let root = url::Url::from_directory_path(session.directory.path())
            .map_err(|_| "LSPの作業場所をURIに変換できません")?
            .to_string();
        let deadline = Instant::now() + START_TIMEOUT;
        let result = session.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "clientInfo": {"name": "AtCoder Ruby IDE"},
                "rootUri": root,
                "workspaceFolders": [{"uri": root, "name": "solution"}],
                "capabilities": {
                    "general": {"positionEncodings": ["utf-16"]},
                    "window": {"workDoneProgress": true}
                },
                "initializationOptions": {
                    "enabledFeatures": ["completion", "documentSymbols", "workspaceSymbol"], "formatter": "none", "linters": [],
                    "indexing": {"excludedPatterns": ["**/ruby-lsp/**"]}
                }
            }),
            deadline,
        )?;
        if result["capabilities"]["positionEncoding"] != "utf-16" {
            return Err("Ruby LSPがUTF-16位置を受け付けません".into());
        }
        session.notify("initialized", json!({}), deadline)?;
        // Completion depends on the initial index, which is built in a separate server thread.
        loop {
            let message = session.receive(deadline)?;
            if message["method"] == "$/progress"
                && message["params"]["token"] == "indexing-progress"
                && message["params"]["value"]["kind"] == "end"
            {
                break;
            }
            session.respond(&message, deadline)?;
        }
        session.notify(
            "textDocument/didOpen",
            json!({"textDocument": {
                "uri": uri, "languageId": "ruby", "version": 0, "text": ""
            }}),
            deadline,
        )?;
        let info = session.info();
        *active = Some(session);
        Ok(info)
    }

    /// Position uses zero-based UTF-16 code units, as in the editor and LSP.
    pub fn complete(&self, code: &str, line: u32, character: u32) -> Result<Value, String> {
        validate_position(code, line, character)?;
        let mut active = self.session.lock().unwrap();
        let session = active.as_mut().ok_or("Ruby LSPが起動していません")?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        session.version += 1;
        let uri = session.uri.clone();
        let result = (|| {
            session.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": session.version},
                    "contentChanges": [{"text": code, "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": session.end_position.0, "character": session.end_position.1}
                    }}]
                }),
                deadline,
            )?;
            session.end_position = end_position(code);
            // The reader parses document requests while the worker applies edits. A request
            // without a document URI acknowledges preceding edits before parsing the document.
            session.request(
                "workspace/symbol",
                json!({"query": "__atcoder_sync_barrier__"}),
                deadline,
            )?;
            // Combined document requests refresh the index of unsaved declarations.
            session.request(
                "textDocument/documentSymbol",
                json!({"textDocument": {"uri": uri}}),
                deadline,
            )?;
            session.request(
                "textDocument/completion",
                json!({
                    "textDocument": {"uri": uri}, "position": {"line": line, "character": character}
                }),
                deadline,
            )
        })();
        if result.is_err() {
            active.take();
        }
        result
    }

    pub fn stop(&self) -> bool {
        let mut active = self.session.lock().unwrap();
        let Some(mut session) = active.take() else {
            return false;
        };
        session.shutdown();
        true
    }
}

fn validate_position(code: &str, line: u32, character: u32) -> Result<(), String> {
    if code.len() > 1048576 {
        return Err("LSPへ送るコードは1 MiBまでです".into());
    }
    let text = code
        .split('\n')
        .nth(line as usize)
        .ok_or("LSPの行位置が範囲外です")?;
    let mut offset = 0;
    for ch in text.chars() {
        if offset == character {
            return Ok(());
        }
        offset += ch.len_utf16() as u32;
    }
    if offset == character {
        Ok(())
    } else {
        Err("LSPの文字位置が範囲外です".into())
    }
}

fn end_position(code: &str) -> (u32, u32) {
    let mut lines = code.split('\n');
    let first = lines.next().unwrap();
    let (line, text) = lines
        .enumerate()
        .last()
        .map(|(line, text)| (line as u32 + 1, text))
        .unwrap_or((0, first));
    (line, text.encode_utf16().count() as u32)
}

type WriteTask = (Vec<u8>, mpsc::Sender<Result<(), String>>);
struct Session {
    child: Child,
    tree: ProcessTree,
    writer: Option<mpsc::SyncSender<WriteTask>>,
    messages: Option<mpsc::Receiver<Result<Value, String>>>,
    threads: Vec<JoinHandle<()>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    directory: tempfile::TempDir,
    uri: String,
    version: u64,
    end_position: (u32, u32),
    request_id: u64,
}

impl Session {
    fn spawn(ruby: &Path, resources: &Path) -> Result<Self, String> {
        let script = resources
            .join("server.rb")
            .canonicalize()
            .map_err(|e| format!("LSPの起動ファイルがありません: {e}"))?;
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let uri = url::Url::from_file_path(directory.path().join("solution.rb"))
            .map_err(|_| "LSPの文書URIを作れません")?
            .to_string();
        let mut command = Command::new(ruby);
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy().to_ascii_uppercase();
            if matches!(
                name.as_str(),
                "RUBYOPT" | "RUBYLIB" | "GEM_HOME" | "GEM_PATH" | "RUBYGEMS_GEMDEPS"
            ) || name.starts_with("BUNDLE_")
                || name.starts_with("BUNDLER_ORIG_")
            {
                command.env_remove(key);
            }
        }
        command
            .args(["--disable=rubyopt", "-EUTF-8:UTF-8"])
            .arg(script)
            .current_dir(directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Ruby LSPを起動できません: {e}"))?;
        let tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        };
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr_pipe = child.stderr.take().unwrap();
        let (writer, writes) = mpsc::sync_channel::<WriteTask>(1);
        let writing = std::thread::spawn(move || {
            while let Ok((bytes, reply)) = writes.recv() {
                let result = stdin
                    .write_all(&bytes)
                    .and_then(|_| stdin.flush())
                    .map_err(|e| e.to_string());
                let failed = result.is_err();
                let _ = reply.send(result);
                if failed {
                    break;
                }
            }
        });
        let (sender, messages) = mpsc::sync_channel(32);
        let reading = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let result = read_message(&mut reader).map_err(|e| e.to_string());
                let failed = result.is_err();
                if sender.send(result).is_err() || failed {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&stderr);
        let errors = std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(length) = stderr_pipe.read(&mut buffer) {
                if length == 0 {
                    break;
                }
                let mut capture = capture.lock().unwrap();
                let count = length.min(16384 - capture.len());
                capture.extend_from_slice(&buffer[..count]);
            }
        });
        Ok(Self {
            child,
            tree,
            writer: Some(writer),
            messages: Some(messages),
            threads: vec![writing, reading, errors],
            stderr,
            directory,
            uri,
            version: 0,
            end_position: (0, 0),
            request_id: 0,
        })
    }

    fn info(&self) -> LspInfo {
        LspInfo {
            pid: self.child.id(),
            position_encoding: "utf-16".into(),
        }
    }

    fn send(&self, value: Value, deadline: Instant) -> Result<(), String> {
        if Instant::now() >= deadline {
            return Err("LSPへの送信がタイムアウトしました".into());
        }
        let body = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        let mut bytes = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        bytes.extend(body);
        let (reply, received) = mpsc::channel();
        self.writer
            .as_ref()
            .unwrap()
            .try_send((bytes, reply))
            .map_err(|e| format!("LSPへの送信に失敗しました: {e}"))?;
        received
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|e| format!("LSPへの送信が完了しません: {e}"))?
    }

    fn notify(&self, method: &str, params: Value, deadline: Instant) -> Result<(), String> {
        self.send(
            json!({"jsonrpc": "2.0", "method": method, "params": params}),
            deadline,
        )
    }

    fn receive(&self, deadline: Instant) -> Result<Value, String> {
        if Instant::now() >= deadline {
            return Err("Ruby LSPの応答がタイムアウトしました".into());
        }
        self.messages
            .as_ref()
            .unwrap()
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|e| format!("Ruby LSPが応答しません: {e}"))?
            .map_err(|e| {
                format!(
                    "Ruby LSPの接続が終了しました: {e}\n{}",
                    String::from_utf8_lossy(&self.stderr.lock().unwrap())
                )
            })
    }

    fn respond(&self, message: &Value, deadline: Instant) -> Result<(), String> {
        if message.get("method").is_some() && message.get("id").is_some() {
            let id = &message["id"];
            if message["method"] == "window/workDoneProgress/create" {
                self.send(
                    json!({"jsonrpc": "2.0", "id": id, "result": null}),
                    deadline,
                )?;
            } else {
                self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Unsupported client request"}}), deadline)?;
            }
        }
        Ok(())
    }

    fn request(&mut self, method: &str, params: Value, deadline: Instant) -> Result<Value, String> {
        self.request_id += 1;
        let id = self.request_id;
        self.send(
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
            deadline,
        )?;
        loop {
            let message = self.receive(deadline)?;
            if message.get("method").is_none() && message["id"] == id {
                if let Some(error) = message.get("error") {
                    return Err(format!("Ruby LSP: {error}"));
                }
                return message
                    .get("result")
                    .cloned()
                    .ok_or("Ruby LSPの応答にresultがありません".into());
            }
            self.respond(&message, deadline)?;
        }
    }

    fn shutdown(&mut self) {
        let deadline = Instant::now() + STOP_TIMEOUT;
        if self.request("shutdown", Value::Null, deadline).is_ok() {
            let _ = self.notify("exit", Value::Null, deadline);
            while Instant::now() < deadline {
                if !matches!(self.child.try_wait(), Ok(None)) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.tree.kill();
        let _ = self.child.wait();
        self.writer.take();
        self.messages.take(); // Release a reader blocked on its bounded message queue.
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

fn read_message(reader: &mut impl BufRead) -> std::io::Result<Value> {
    let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidData, "不正なLSPメッセージ");
    let mut size = 0;
    let mut length = None;
    loop {
        let mut line = String::new();
        let count = reader.take((8193 - size) as u64).read_line(&mut line)?;
        size += count;
        if count == 0 || size > 8192 {
            return Err(invalid());
        }
        if line == "\r\n" {
            break;
        }
        let (name, value) = line
            .trim_end_matches("\r\n")
            .split_once(':')
            .ok_or_else(invalid)?;
        if name.eq_ignore_ascii_case("Content-Length") {
            if length.is_some() {
                return Err(invalid());
            }
            length = Some(value.trim().parse::<usize>().map_err(|_| invalid())?);
        }
    }
    let length = length
        .filter(|n| *n > 0 && *n <= MAX_MESSAGE)
        .ok_or_else(invalid)?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| invalid())?;
    if !value.is_object() || value["jsonrpc"] != "2.0" {
        return Err(invalid());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_count_utf8_bytes_and_preserve_consecutive_messages() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":"😀日本語"}"#;
        let frame = format!("Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        let data = frame.repeat(2);
        let mut reader = BufReader::with_capacity(3, data.as_bytes());
        for _ in 0..2 {
            assert_eq!(read_message(&mut reader).unwrap()["result"], "😀日本語");
        }
        assert!(read_message(&mut reader).is_err());
    }

    #[test]
    fn frames_reject_bad_headers_oversize_truncation_and_invalid_jsonrpc() {
        for data in [
            "Content-Length: 10\r\nContent-Length: 10\r\n\r\n{}".to_string(),
            "Content-Length: 8388609\r\n\r\n".to_string(),
            "Content-Length: -1\r\n\r\n".to_string(),
            "Content-Length: 2\r\n\r\n{".to_string(),
            "Content-Length: 2\r\n\r\n[]".to_string(),
            "Content-Length: 2\r\n\r\n{}".to_string(),
            "Content-Length: 1\r\n\r\nx".to_string(),
            "x".repeat(8193),
        ] {
            assert!(read_message(&mut data.as_bytes()).is_err());
        }
    }

    fn fake_session(script: &str) -> (tempfile::TempDir, Session) {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("server.rb"), script).unwrap();
        let ruby = std::env::var_os("RUBY_PATH").unwrap_or_else(|| "ruby".into());
        let session = Session::spawn(Path::new(&ruby), root.path()).unwrap();
        (root, session)
    }

    #[test]
    fn blocked_stdin_and_stderr_flood_are_bounded_and_cleanup_does_not_hang() {
        let (_root, session) = fake_session("STDERR.write('x' * 100_000); sleep 30");
        assert!(session
            .send(
                json!({"large": "x".repeat(1048576)}),
                Instant::now() + Duration::from_millis(150)
            )
            .is_err());
        assert!(session
            .receive(Instant::now() + Duration::from_millis(150))
            .is_err());
        let started = Instant::now();
        drop(session);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn unexpected_exit_and_invalid_output_fail_without_waiting_for_a_deadline() {
        for script in [
            "exit 2",
            "STDOUT.write('not an LSP header\\r\\n'); STDOUT.flush",
        ] {
            let (_root, session) = fake_session(script);
            assert!(session
                .receive(Instant::now() + Duration::from_secs(3))
                .is_err());
        }
    }
}
