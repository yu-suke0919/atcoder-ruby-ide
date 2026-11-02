//! `atcoder-ruby-agent <ruby> <ruby-lsp>`: runs Ruby and Ruby LSP for the app inside WSL.
//! See docs/architecture.md#wslのエージェント.

#[cfg(unix)]
fn main() {
    use atcoder_ruby_ide::agent::Agent;
    use std::sync::Arc;
    use std::time::Duration;

    let mut args = std::env::args_os().skip(1);
    let (Some(ruby), Some(resources), None) = (args.next(), args.next(), args.next()) else {
        eprintln!("使い方: atcoder-ruby-agent <Ruby> <Ruby LSPのフォルダー>");
        std::process::exit(2);
    };
    // Killing wsl.exe sends SIGHUP. Block the signals before any thread starts so that only the
    // waiting thread below receives them; Command resets the mask for Ruby.
    let signals = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGHUP, libc::SIGTERM, libc::SIGINT] {
            libc::sigaddset(&mut set, signal);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };
    let agent = Arc::new(Agent::new(
        ruby.into(),
        resources.into(),
        Duration::from_secs(5),
    ));
    let stopping = Arc::clone(&agent);
    std::thread::spawn(move || {
        let mut signal = 0;
        unsafe { libc::sigwait(&signals, &mut signal) };
        stopping.stop_all();
        std::process::exit(1);
    });
    agent.serve(std::io::stdin().lock(), std::io::stdout());
}

#[cfg(not(unix))]
fn main() {
    eprintln!("atcoder-ruby-agent はLinux（WSLの中）で動きます。");
    std::process::exit(2);
}
