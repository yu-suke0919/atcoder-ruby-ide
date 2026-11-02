# C0 spike: a tiny agent that reads one JSON request per line and answers one JSON line each.
# Not for merge. It checks the stdio channel through wsl.exe, not the real protocol.
require 'json'
$stdout.sync = true
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
    puts JSON.generate(type: 'spawned', id: request['id'], pid: pid)
  when 'kill'
    Process.kill(:KILL, -request['pid']) rescue nil
    Process.wait(request['pid']) rescue nil
    alive = `pgrep -x sleep`.split.size
    puts JSON.generate(type: 'killed', id: request['id'], sleeping: alive)
  when 'limits'
    # Memory cap by setrlimit (AS) and the native stack limit seen by a child Ruby.
    as = IO.popen(['ruby', '-e', 'Process.setrlimit(:AS, 256 * 1024 * 1024); begin; s = "x" * (512 * 1024 * 1024); puts "allocated"; rescue NoMemoryError; puts "NoMemoryError"; end'], err: [:child, :out], &:read)
    stack = `bash -c 'ulimit -s'`.strip
    deep = IO.popen(['ruby', '-e', 'def f(n) = n.zero? ? 0 : 1 + f(n - 1); begin; p f(100_000); rescue SystemStackError; puts "SystemStackError"; end'], err: [:child, :out], &:read)
    cgroup = File.exist?('/sys/fs/cgroup/cgroup.controllers') ? File.read('/sys/fs/cgroup/cgroup.controllers').strip : 'none'
    puts JSON.generate(type: 'limits', id: request['id'], as: as.strip, stack: stack, deep: deep.strip, cgroup: cgroup)
  when 'quit'
    puts JSON.generate(type: 'bye', id: request['id'])
    break
  end
end
