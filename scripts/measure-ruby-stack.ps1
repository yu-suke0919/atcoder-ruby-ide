param(
  [string]$Ruby = (Join-Path $PSScriptRoot '../vendor/ruby/bin/ruby.exe'),
  [string]$Report = (Join-Path $PSScriptRoot '../artifacts/reports/ruby-stack.json')
)
$ErrorActionPreference = 'Stop'
$rubyPath = (Resolve-Path $Ruby).Path
$fixture = (Resolve-Path (Join-Path $PSScriptRoot '../tests/fixtures/deep-recursion.rb')).Path
$sourcePath = Join-Path ([IO.Path]::GetTempPath()) ("ruby-stack-" + [guid]::NewGuid() + '.rb')
$source = @'
require 'json'
Gem.use_paths(Gem.default_dir)
started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
begin
  result = send(ARGV[0], Integer(ARGV[1]))
  status = 'completed'
rescue SystemStackError => error
  status = 'stack-error'
end
elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
puts JSON.generate({ status: status, result: result, error: error&.message,
  durationMs: elapsed * 1000, ruby: RUBY_DESCRIPTION, defaults: RubyVM::DEFAULT_PARAMS })
STDOUT.flush
# Keep the exited recursion's OS high-water mark observable to the parent.
sleep 0.1
'@
[IO.File]::WriteAllText($sourcePath, $source, [Text.UTF8Encoding]::new($false))
$rows = [Collections.Generic.List[object]]::new()
try {
  $image = [IO.File]::ReadAllBytes($rubyPath)
  $optionalHeader = [BitConverter]::ToInt32($image, 0x3c) + 24
  if ([BitConverter]::ToUInt16($image, $optionalHeader) -ne 0x20b) { throw 'Expected a PE32+ Ruby executable' }
  $machineStackReserve = [BitConverter]::ToUInt64($image, $optionalHeader + 72)
  foreach ($stackBytes in @($null, 4194304, 16777216, 33554432, 67108864, 134217728, 268435456)) {
    foreach ($method in @('count_down', 'count_down_with_each', 'count_down_with_block')) {
      foreach ($depth in @(0, 100000, 1000000)) {
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $rubyPath
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        foreach ($key in @($startInfo.Environment.Keys)) {
          if ($key -match '^(RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|RUBYGEMS_GEMDEPS|BUNDLE_.*|BUNDLER_ORIG_.*|RUBY_THREAD_VM_STACK_SIZE|RUBY_THREAD_MACHINE_STACK_SIZE)$') {
            $startInfo.Environment.Remove($key) | Out-Null
          }
        }
        if ($null -ne $stackBytes) { $startInfo.Environment['RUBY_THREAD_VM_STACK_SIZE'] = [string]$stackBytes }
        foreach ($argument in @('--disable=rubyopt', '-EUTF-8:UTF-8', '-r', $fixture, $sourcePath, $method, [string]$depth)) {
          $startInfo.ArgumentList.Add($argument)
        }
        $childProcess = [Diagnostics.Process]::new()
        $childProcess.StartInfo = $startInfo
        $peakBytes = [int64]0
        $peakPagefileBytes = [int64]0
        $timedOut = $false
        try {
          $childProcess.Start() | Out-Null
          $outputTask = $childProcess.StandardOutput.ReadToEndAsync()
          $errorTask = $childProcess.StandardError.ReadToEndAsync()
          $deadline = [Diagnostics.Stopwatch]::StartNew()
          while (-not $childProcess.WaitForExit(10)) {
            try {
              $childProcess.Refresh()
              $peakBytes = [Math]::Max($peakBytes, $childProcess.PeakWorkingSet64)
              $peakPagefileBytes = [Math]::Max($peakPagefileBytes, $childProcess.PeakPagedMemorySize64)
            } catch { if (-not $childProcess.HasExited) { throw } }
            if ($deadline.Elapsed.TotalSeconds -gt 15) {
              $timedOut = $true
              $childProcess.Kill($true)
              $childProcess.WaitForExit()
            }
          }
          $stdout = $outputTask.GetAwaiter().GetResult()
          $stderr = $errorTask.GetAwaiter().GetResult()
          $probe = if ($childProcess.ExitCode -eq 0 -and $stdout.Trim()) { $stdout | ConvertFrom-Json } else { $null }
          $row = [ordered]@{
            vmStackBytes = $stackBytes; method = $method; depth = $depth
            status = $(if ($timedOut) { 'timeout' } elseif ($null -ne $probe) { $probe.status } else { 'process-error' })
            exitCode = $childProcess.ExitCode; peakWorkingSetBytes = $peakBytes
            peakPagefileBytes = $peakPagefileBytes; processDurationMs = $deadline.Elapsed.TotalMilliseconds
            durationMs = $probe.durationMs; ruby = $probe.ruby; defaults = $probe.defaults
            error = $probe.error; stderr = $stderr
          }
          $rows.Add($row)
          Write-Output ('RUBY_STACK ' + ($row | ConvertTo-Json -Depth 5 -Compress))
        } finally { $childProcess.Dispose() }
      }
    }
  }
  $destination = [IO.Path]::GetFullPath($Report)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
  [IO.File]::WriteAllText($destination, ([ordered]@{
    machineStackReserveBytes = $machineStackReserve; measurements = $rows
  } | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
  Write-Output "RUBY_STACK_MACHINE_RESERVE $machineStackReserve"
} finally { Remove-Item $sourcePath -Force }
