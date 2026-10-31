require 'fiddle/import'
require 'json'
module WinMemory
  extend Fiddle::Importer
  dlload 'kernel32.dll'
  extern 'int QueryInformationJobObject(void*, int, void*, unsigned long, void*)'
  extern 'void* VirtualAlloc(void*, size_t, unsigned long, unsigned long)'
end

def job_memory
  info = "\0" * 144 # JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows x64
  raise 'QueryInformationJobObject failed' if WinMemory.QueryInformationJobObject(nil, 9, info, info.bytesize, nil) == 0
  { limit: info[120, 8].unpack1('Q<'), peak: info[136, 8].unpack1('Q<') }
end

mode = STDIN.read.strip
raise "unexpected job limit: #{job_memory}" unless job_memory[:limit] == 1024**3
STDOUT.sync = true
puts JSON.generate(job_memory.merge(mode: mode, source: __FILE__))
case mode
when 'normal'
  block = 'x' * (64 * 1024**2)
  puts JSON.generate(job_memory.merge(size: block.bytesize))
when 'reserve'
  pointer = WinMemory.VirtualAlloc(nil, 2 * 1024**3, 0x2000, 4)
  raise 'address reservation failed' if pointer.null?
  puts JSON.generate(job_memory.merge(reserved: 2 * 1024**3))
when 'single'
  block = 'x' * 1024**3
  abort 'allocation unexpectedly succeeded'
when 'denied'
  pointer = WinMemory.VirtualAlloc(nil, 2 * 1024**3, 0x3000, 4)
  abort 'allocation unexpectedly succeeded' unless pointer.null?
  puts 'allocation denied'
  # A program may catch allocation failure and keep running. The Job event must stop it.
  sleep 30
when 'descendants'
  require 'rbconfig'
  child = <<~RUBY
    require 'fiddle/import'
    module K
      extend Fiddle::Importer
      dlload 'kernel32.dll'
      extern 'void* VirtualAlloc(void*, size_t, unsigned long, unsigned long)'
    end
    STDOUT.sync = true
    p = K.VirtualAlloc(nil, 600 * 1024**2, 0x3000, 4)
    puts(p.null? ? 'child denied' : 'child allocated')
    sleep 30
  RUBY
  # Each process is below 1 GiB; only their aggregate exceeds the Job limit.
  reader, writer = IO.pipe
  spawn(RbConfig.ruby, '-e', child, out: writer)
  writer.close
  puts reader.gets
  reader.close
  puts JSON.generate(job_memory)
  spawn(RbConfig.ruby, '-e', child)
  sleep 30
end
