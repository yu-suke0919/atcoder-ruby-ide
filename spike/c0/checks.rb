# C0 spike (not for merge): checks run inside WSL with the shipped Ruby. One "label: value" per line.
ruby = RbConfig.ruby
run = ->(*command) { IO.popen(command, err: [:child, :out], &:read).strip.lines.last.to_s.strip }
memory_test = lambda do |name, limit_mb, size_mb|
  code = "Process.setrlimit(:#{name}, #{limit_mb} * 1024 * 1024); begin; s = 'x' * (#{size_mb} * 1024 * 1024); puts 'allocated'; rescue NoMemoryError; puts 'NoMemoryError'; end"
  run.call(ruby, '--yjit', '-e', code)
end
deep = "def f(n) = n.zero? ? 0 : 1 + f(n - 1); begin; p f(ARGV[0].to_i); rescue SystemStackError; puts 'SystemStackError'; end"

puts "ruby: #{RUBY_DESCRIPTION}"
puts "yjit: #{run.call(ruby, '--yjit', '-e', 'p RubyVM::YJIT.enabled?')}"
puts "stdlib: #{run.call(ruby, '-e', '%w[json openssl psych zlib fiddle bigdecimal set prime].each { |l| require l }; puts :ok')}"
puts "memory total: #{File.read('/proc/meminfo')[/MemTotal:\s+(\d+)/, 1].to_i / 1024} MB"
# AtCoder's memory limit is 1024 MB: under it, 512 MB works and 1.5 GB fails.
puts "AS 1024MB, 512MB string: #{memory_test.call('AS', 1024, 512)}"
puts "AS 1024MB, 1536MB string: #{memory_test.call('AS', 1024, 1536)}"
puts "DATA 1024MB, 1536MB string: #{memory_test.call('DATA', 1024, 1536)}"
controllers = '/sys/fs/cgroup/cgroup.controllers'
puts "cgroup v2 controllers: #{File.exist?(controllers) ? File.read(controllers).strip : 'none'}"
puts "cgroup writable: #{File.writable?('/sys/fs/cgroup')}"
puts "systemd: #{File.read('/proc/1/comm').strip}"
puts "user: #{`id -un`.strip}"
puts "ulimit -s: #{`bash -c 'ulimit -s'`.strip} / hard #{`bash -c 'ulimit -Hs'`.strip}"
puts "recursion 100000, default stack: #{run.call(ruby, '-e', deep, '100000')}"
big = "ulimit -s 1048576 && RUBY_THREAD_VM_STACK_SIZE=1073741824 #{ruby} -e \"#{deep}\" 1000000"
puts "recursion 1000000, 1GB stacks: #{run.call('bash', '-c', big)}"
