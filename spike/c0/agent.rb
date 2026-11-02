# C0 spike: a tiny agent that reads one JSON request per line and answers one JSON line each.
# Not for merge. It checks the stdio channel through wsl.exe, not the real protocol.
require 'json'
$stdout.sync = true
groups = []
STDIN.each_line do |line|
  request = JSON.parse(line)
  case request['type']
  when 'echo'
    puts JSON.generate(type: 'echo', id: request['id'], text: request['text'])
  when 'flood'
    # Large output: many lines in a row, then a marker.
    request['lines'].times { |i| puts JSON.generate(type: 'chunk', i: i, text: 'あ' * 100) }
    puts JSON.generate(type: 'flood-done', id: request['id'])
  when 'spawn'
    # A process group like a user's Ruby with children, killed on request.
    pid = Process.spawn('bash', '-c', 'sleep 300 & sleep 300 & wait', pgroup: true, in: File::NULL, out: File::NULL, err: File::NULL)
    groups << pid
    puts JSON.generate(type: 'spawned', id: request['id'], pid: pid)
  when 'kill'
    Process.kill(:KILL, -request['pid']) rescue nil
    Process.wait(request['pid']) rescue nil
    groups.delete(request['pid'])
    alive = `pgrep -x sleep`.split.size
    puts JSON.generate(type: 'killed', id: request['id'], sleeping: alive)
  when 'limits'
    ruby = RbConfig.ruby
    # Memory caps seen by a child Ruby: address space (AS) and data segment (DATA).
    caps = %w[AS DATA].to_h do |name|
      code = "Process.setrlimit(:#{name}, 256 * 1024 * 1024); begin; s = 'x' * (512 * 1024 * 1024); puts 'allocated'; rescue NoMemoryError; puts 'NoMemoryError'; end"
      [name, IO.popen([ruby, '-e', code], err: [:child, :out], &:read).strip.lines.last.to_s.strip]
    end
    stack = `bash -c 'ulimit -s'`.strip
    deep = IO.popen([ruby, '-e', 'def f(n) = n.zero? ? 0 : 1 + f(n - 1); begin; p f(100_000); rescue SystemStackError; puts "SystemStackError"; end'], err: [:child, :out], &:read)
    # A bigger stack for the child: RLIMIT_STACK set before exec, and Ruby's own VM stack size.
    big = IO.popen(['bash', '-c', "ulimit -s 1048576 && RUBY_THREAD_VM_STACK_SIZE=1073741824 #{ruby} -e 'def f(n) = n.zero? ? 0 : 1 + f(n - 1); begin; p f(1_000_000); rescue SystemStackError; puts %q(SystemStackError); end'"], err: [:child, :out], &:read)
    cgroup = File.exist?('/sys/fs/cgroup/cgroup.controllers') ? File.read('/sys/fs/cgroup/cgroup.controllers').strip : 'none'
    puts JSON.generate(type: 'limits', id: request['id'], caps: caps, stack: stack, deep: deep.strip, bigStack: big.strip, cgroup: cgroup,
                       kernel: File.read('/proc/version').strip)
  when 'quit'
    puts JSON.generate(type: 'bye', id: request['id'])
    break
  end
end
# Windows closed the pipe (the app quit or killed wsl.exe): stop what is still running.
groups.each { |pid| Process.kill(:KILL, -pid) rescue nil }
