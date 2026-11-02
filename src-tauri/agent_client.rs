//! The app's side of the channel to the agent: starts it on the first request, matches answers
//! to requests, relays run events and starts it again after it dies.
//! See docs/architecture.md#wslのエージェント.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const DIED: &str = "Rubyのエージェントが終了しました。";
/// Longer than any request the agent itself bounds (Ruby LSP starts within 30 seconds).
const ANSWER_LIMIT: Duration = Duration::from_secs(60);
const EXIT_LIMIT: Duration = Duration::from_secs(2);

type Answer = mpsc::Sender<Result<Value, String>>;
type Listener = Box<dyn Fn(Value) + Send>;

struct Connection {
    child: Mutex<Child>,
    pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, Answer>>,
    reader: Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[derive(Default)]
struct Runs {
    listeners: Mutex<HashMap<u64, Listener>>,
    idle: Condvar,
}

impl Runs {
    /// Hands the event to its run; a completed or failed event ends the run.
    fn deliver(&self, run: u64, event: Value) {
        let mut listeners = self.listeners.lock().unwrap();
        let done = matches!(event["type"].as_str(), Some("completed" | "failed"));
        if let Some(listener) = listeners.get(&run) {
            listener(event);
        }
        if done {
            listeners.remove(&run);
            self.idle.notify_all();
        }
    }
    fn fail_all(&self, message: &str) {
        let mut listeners = self.listeners.lock().unwrap();
        for (_, listener) in listeners.drain() {
            listener(json!({"type": "failed", "message": message}));
        }
        self.idle.notify_all();
    }
}

pub struct AgentClient {
    command: Box<dyn Fn() -> Command + Send + Sync>,
    connection: Arc<Mutex<Option<Arc<Connection>>>>,
    runs: Arc<Runs>,
    next_id: AtomicU64,
}

impl AgentClient {
    /// `command` builds the command that starts the agent, e.g. `wsl.exe -e …/atcoder-ruby-agent`.
    pub fn new(command: impl Fn() -> Command + Send + Sync + 'static) -> Self {
        Self {
            command: Box::new(command),
            connection: Arc::default(),
            runs: Arc::default(),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn request(&self, command: &str, args: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.call(id, command, args)
    }

    /// Starts a run; `on_event` receives its RunEvents, ending with completed or failed.
    pub fn run(
        &self,
        args: Value,
        on_event: impl Fn(Value) + Send + 'static,
    ) -> Result<(), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        // Registered first: the started event can arrive before the answer.
        self.runs
            .listeners
            .lock()
            .unwrap()
            .insert(id, Box::new(on_event));
        match self.call(id, "run_ruby", args) {
            Ok(_) => Ok(()),
            Err(error) => {
                self.runs.listeners.lock().unwrap().remove(&id);
                self.runs.idle.notify_all();
                Err(error)
            }
        }
    }

    /// Waits until no run is in progress.
    pub fn wait_idle(&self) {
        let mut listeners = self.runs.listeners.lock().unwrap();
        while !listeners.is_empty() {
            listeners = self.runs.idle.wait(listeners).unwrap();
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.connection.lock().unwrap().as_ref().map(|c| c.pid)
    }

    /// Closes the agent's stdin so that it stops its runs and exits; kills it after 2 seconds.
    /// Returns after everything the agent wrote has been delivered.
    pub fn shutdown(&self) {
        let Some(connection) = self.connection.lock().unwrap().take() else {
            return;
        };
        drop(connection.stdin.lock().unwrap().take());
        let deadline = Instant::now() + EXIT_LIMIT;
        while matches!(connection.child.lock().unwrap().try_wait(), Ok(None)) {
            if Instant::now() >= deadline {
                let _ = connection.child.lock().unwrap().kill();
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let reader = connection.reader.lock().unwrap().take();
        if let Some(reader) = reader {
            let _ = reader.join();
        }
    }

    fn call(&self, id: u64, command: &str, args: Value) -> Result<Value, String> {
        let connection = self.connect()?;
        let (answer, receiver) = mpsc::channel();
        connection.pending.lock().unwrap().insert(id, answer);
        let line = json!({"id": id, "command": command, "args": args}).to_string();
        let written = match connection.stdin.lock().unwrap().as_mut() {
            Some(stdin) => writeln!(stdin, "{line}").and_then(|_| stdin.flush()),
            None => Err(std::io::ErrorKind::BrokenPipe.into()),
        };
        if written.is_err() {
            connection.pending.lock().unwrap().remove(&id);
            return Err(DIED.into());
        }
        match receiver.recv_timeout(ANSWER_LIMIT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                connection.pending.lock().unwrap().remove(&id);
                Err("Rubyのエージェントが応答しません。".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(DIED.into()),
        }
    }

    fn connect(&self) -> Result<Arc<Connection>, String> {
        let mut slot = self.connection.lock().unwrap();
        if let Some(connection) = slot.as_ref() {
            return Ok(Arc::clone(connection));
        }
        let mut child = (self.command)()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Rubyのエージェントを起動できません: {e}"))?;
        let stdout = child.stdout.take().unwrap();
        let connection = Arc::new(Connection {
            pid: child.id(),
            stdin: Mutex::new(child.stdin.take()),
            child: Mutex::new(child),
            pending: Mutex::default(),
            reader: Mutex::default(),
        });
        let (reader, slot_ref, runs) = (
            Arc::clone(&connection),
            Arc::clone(&self.connection),
            Arc::clone(&self.runs),
        );
        let reader_thread = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    eprintln!("Rubyのエージェントからの不正な行: {line}");
                    continue;
                };
                if let Some(run) = message["run"].as_u64() {
                    runs.deliver(run, message["event"].clone());
                } else if let Some(id) = message["id"].as_u64() {
                    if let Some(answer) = reader.pending.lock().unwrap().remove(&id) {
                        let result = match message["error"].as_str() {
                            Some(error) => Err(error.to_string()),
                            None => Ok(message["value"].clone()),
                        };
                        let _ = answer.send(result);
                    }
                }
            }
            // The agent is gone: nothing more will answer or finish.
            {
                let mut slot = slot_ref.lock().unwrap();
                if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &reader)) {
                    *slot = None;
                }
            }
            for (_, answer) in reader.pending.lock().unwrap().drain() {
                let _ = answer.send(Err(DIED.into()));
            }
            runs.fail_all(DIED);
            let _ = reader.child.lock().unwrap().wait();
        });
        *connection.reader.lock().unwrap() = Some(reader_thread);
        *slot = Some(Arc::clone(&connection));
        Ok(connection)
    }
}

impl Drop for AgentClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}
