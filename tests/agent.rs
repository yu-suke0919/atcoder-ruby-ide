//! The agent binary that runs Ruby and Ruby LSP inside WSL, and the client that talks to it.
#![cfg(unix)]
use atcoder_ruby_ide::AgentClient;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn ruby() -> PathBuf {
    std::env::var_os("RUBY_PATH")
        .unwrap_or_else(|| "ruby".into())
        .into()
}

fn resources() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/ruby-lsp")
}

fn agent_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_atcoder-ruby-agent"));
    command.arg(ruby()).arg(resources());
    command
}

struct Agent {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Value>,
}

impl Agent {
    fn start() -> Self {
        let mut child = agent_command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line.unwrap();
                if sender.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            stdin: child.stdin.take(),
            child,
            lines,
        }
    }
    fn send(&mut self, id: u64, command: &str, args: Value) {
        let request = json!({"id": id, "command": command, "args": args});
        writeln!(self.stdin.as_mut().unwrap(), "{request}").unwrap();
    }
    fn next(&self) -> Value {
        self.lines.recv_timeout(Duration::from_secs(60)).unwrap()
    }
    fn answer(&mut self, id: u64, command: &str, args: Value) -> Value {
        self.send(id, command, args);
        loop {
            let message = self.next();
            if message["id"] == id {
                return message;
            }
        }
    }
    /// Run events of one run, up to and including its completed or failed event.
    fn events(&self, run: u64) -> Vec<Value> {
        let mut events = Vec::new();
        loop {
            let message = self.next();
            if message["run"] != run {
                continue;
            }
            let event = message["event"].clone();
            let done = matches!(event["type"].as_str(), Some("completed" | "failed"));
            events.push(event);
            if done {
                return events;
            }
        }
    }
    fn exits_within(&mut self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if self.child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A process that exited but was not reaped yet (a zombie) counts as gone.
fn alive(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            let state = stat.rsplit_once(')')?.1.trim_start().chars().next()?;
            Some(state != 'Z' && state != 'X')
        })
        .unwrap_or(false)
}

fn gone_within(pids: &[i32], limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if pids.iter().all(|&pid| !alive(pid)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn output_text(events: &[Value], stream: &str) -> String {
    let bytes: Vec<u8> = events
        .iter()
        .filter(|event| event["type"] == "output" && event["stream"] == stream)
        .flat_map(|event| {
            event["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
        })
        .collect();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn agent_answers_ruby_info_and_streams_a_run_in_order() {
    let mut agent = Agent::start();
    let info = agent.answer(1, "ruby_info", Value::Null);
    assert!(
        info["value"]["version"]
            .as_str()
            .unwrap()
            .starts_with("ruby 3.4"),
        "{info}"
    );
    let accepted = agent.answer(
        2,
        "run_ruby",
        json!({
            "code": "a, b = gets.split.map(&:to_i)\nname = gets.chomp\nputs \"#{a + b} #{name}\"\nwarn '標準エラー'",
            "stdin": "1 2\n日本語😀\n",
            "expectedOutput": "3 日本語😀\n",
            "tolerance": null,
            "problemTimeLimitMs": 2000
        }),
    );
    assert_eq!(accepted["value"], Value::Null, "{accepted}");
    let events = agent.events(2);
    assert_eq!(events[0]["type"], "started");
    assert_eq!(events[0]["executionLimitMs"], 5000);
    assert_eq!(output_text(&events, "stdout"), "3 日本語😀\n");
    assert_eq!(output_text(&events, "stderr"), "標準エラー\n");
    let result = &events.last().unwrap()["result"];
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(result["stdout"], "3 日本語😀\n");
    assert_eq!(result["comparison"], true);
    assert_eq!(result["executionLimitMs"], 5000);
}

#[test]
fn agent_reports_failures_with_the_error_line_and_rejects_bad_requests() {
    let mut agent = Agent::start();
    agent.answer(
        1,
        "run_ruby",
        json!({"code": "x = 1\nraise 'boom'\n", "stdin": ""}),
    );
    let result = agent.events(1).last().unwrap()["result"].clone();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["errorLine"], 2, "{result}");
    assert!(agent.answer(2, "unknown", Value::Null)["error"].is_string());
    assert!(agent.answer(3, "run_ruby", json!({"code": 1}))["error"].is_string());
    let busy = agent.answer(4, "run_ruby", json!({"code": "sleep 30", "stdin": ""}));
    assert_eq!(busy["value"], Value::Null);
    let second = agent.answer(5, "run_ruby", json!({"code": "1", "stdin": ""}));
    assert_eq!(second["error"], "すでに実行中です。");
    assert_eq!(agent.answer(6, "stop_ruby", Value::Null)["value"], true);
    assert_eq!(
        agent.events(4).last().unwrap()["result"]["status"],
        "stopped"
    );
    agent.answer(7, "run_ruby", json!({"code": "puts :next", "stdin": ""}));
    assert_eq!(
        agent.events(7).last().unwrap()["result"]["stdout"],
        "next\n"
    );
}

/// Ruby that starts a child process, prints both pids and keeps running.
const SPAWNING: &str =
    "child = spawn('sleep', '300')\nputs \"#{Process.pid} #{child}\"\n$stdout.flush\nsleep 300\n";

fn started_pids(agent: &mut Agent, run: u64) -> Vec<i32> {
    agent.answer(run, "run_ruby", json!({"code": SPAWNING, "stdin": ""}));
    loop {
        let message = agent.next();
        if message["run"] == run && message["event"]["type"] == "output" {
            let text = output_text(&[message["event"].clone()], "stdout");
            return text
                .split_whitespace()
                .map(|pid| pid.parse().unwrap())
                .collect();
        }
    }
}

#[test]
fn closing_stdin_stops_running_ruby_and_its_children_before_the_agent_exits() {
    let mut agent = Agent::start();
    let pids = started_pids(&mut agent, 1);
    assert_eq!(pids.len(), 2);
    assert!(pids.iter().all(|&pid| alive(pid)));
    drop(agent.stdin.take());
    assert!(agent.exits_within(Duration::from_secs(5)));
    assert!(gone_within(&pids, Duration::from_secs(2)), "{pids:?}");
}

#[test]
fn hangup_and_terminate_stop_running_ruby_and_its_children() {
    for signal in [libc::SIGHUP, libc::SIGTERM] {
        let mut agent = Agent::start();
        let pids = started_pids(&mut agent, 1);
        unsafe { libc::kill(agent.child.id() as i32, signal) };
        assert!(
            agent.exits_within(Duration::from_secs(5)),
            "signal {signal}"
        );
        assert!(
            gone_within(&pids, Duration::from_secs(2)),
            "signal {signal}"
        );
    }
}

#[test]
fn signals_the_agent_handles_are_not_blocked_in_ruby() {
    let mut agent = Agent::start();
    agent.answer(
        1,
        "run_ruby",
        json!({"code": "trap('TERM') { puts 'term'; exit }\nProcess.kill('TERM', Process.pid)\nsleep 5\n", "stdin": ""}),
    );
    let result = agent.events(1).last().unwrap()["result"].clone();
    assert_eq!(result["stdout"], "term\n", "{result}");
}

#[test]
fn agent_completes_unsaved_code_through_ruby_lsp() {
    let mut agent = Agent::start();
    let info = agent.answer(1, "lsp_start", Value::Null);
    assert_eq!(info["value"]["position_encoding"], "utf-16", "{info}");
    let code = "class IdeAgent; def agent_only_method; end; end\nIdeAgent.new.agent_only_";
    let result = agent.answer(
        2,
        "lsp_complete",
        json!({"code": code, "line": 1, "character": 24}),
    );
    let items = result["value"]
        .as_array()
        .or_else(|| result["value"]["items"].as_array())
        .unwrap_or_else(|| panic!("{result}"));
    assert!(items
        .iter()
        .any(|item| item["label"] == "agent_only_method"));
    assert_eq!(agent.answer(3, "lsp_stop", Value::Null)["value"], true);
}

fn client() -> AgentClient {
    AgentClient::new(|| Ok(agent_command()))
}

fn run_events(client: &AgentClient, args: Value) -> Arc<Mutex<Vec<Value>>> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    client
        .run(args, move |event| sink.lock().unwrap().push(event))
        .unwrap();
    events
}

#[test]
fn client_relays_requests_and_run_events_and_waits_for_the_run() {
    let client = client();
    let info = client.request("ruby_info", Value::Null).unwrap();
    assert!(info["version"].as_str().unwrap().starts_with("ruby 3.4"));
    let events = run_events(
        &client,
        json!({"code": "puts gets.upcase", "stdin": "abc\n"}),
    );
    client.wait_idle();
    let events = events.lock().unwrap();
    assert_eq!(events[0]["type"], "started");
    assert_eq!(events.last().unwrap()["result"]["stdout"], "ABC\n");
    assert_eq!(
        client.request("unknown", Value::Null).unwrap_err(),
        "Unknown agent command: unknown"
    );
}

#[test]
fn client_stop_and_wait_idle_end_a_running_run() {
    let client = client();
    let events = run_events(&client, json!({"code": "sleep 30", "stdin": ""}));
    let deadline = Instant::now() + Duration::from_secs(10);
    while events.lock().unwrap().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(client.request("stop_ruby", Value::Null).unwrap(), true);
    client.wait_idle();
    assert_eq!(
        events.lock().unwrap().last().unwrap()["result"]["status"],
        "stopped"
    );
}

#[test]
fn client_fails_waiting_work_when_the_agent_dies_and_starts_it_again() {
    let client = client();
    let events = run_events(&client, json!({"code": "sleep 30", "stdin": ""}));
    let first = client.pid().unwrap();
    unsafe { libc::kill(first as i32, libc::SIGKILL) };
    client.wait_idle();
    let last = events.lock().unwrap().last().unwrap().clone();
    assert_eq!(last["type"], "failed", "{last}");
    assert!(last["message"].as_str().unwrap().contains("エージェント"));
    let info = client.request("ruby_info", Value::Null).unwrap();
    assert!(info["version"].is_string());
    assert_ne!(client.pid().unwrap(), first);
}

#[test]
fn client_shutdown_ends_the_agent_and_its_runs() {
    let client = client();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    client
        .run(json!({"code": SPAWNING, "stdin": ""}), move |event| {
            // A slow consumer, like a host writing a large final event.
            if event["type"] == "completed" {
                std::thread::sleep(Duration::from_millis(300));
            }
            sink.lock().unwrap().push(event);
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let pids: Vec<i32> = loop {
        let text = output_text(&events.lock().unwrap(), "stdout");
        if text.ends_with('\n') {
            break text
                .split_whitespace()
                .map(|p| p.parse().unwrap())
                .collect();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    let agent = client.pid().unwrap() as i32;
    client.shutdown();
    // Everything the agent wrote before exiting has been relayed when shutdown returns.
    let last = events.lock().unwrap().last().unwrap().clone();
    assert_eq!(last["type"], "completed", "{last}");
    assert_eq!(last["result"]["status"], "stopped");
    assert!(gone_within(&[agent], Duration::from_secs(3)));
    assert!(gone_within(&pids, Duration::from_secs(2)));
    assert_eq!(client.pid(), None);
}

#[test]
fn a_failing_start_is_reported_and_tried_again_on_the_next_request() {
    let attempts = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&attempts);
    let client = AgentClient::new(move || {
        let mut attempts = counter.lock().unwrap();
        *attempts += 1;
        if *attempts == 1 {
            Err("WSLを起動できません。".into())
        } else {
            Ok(agent_command())
        }
    });
    assert_eq!(
        client.request("ruby_info", Value::Null).unwrap_err(),
        "WSLを起動できません。"
    );
    assert!(client.request("ruby_info", Value::Null).unwrap()["version"].is_string());
    assert_eq!(*attempts.lock().unwrap(), 2);
}
