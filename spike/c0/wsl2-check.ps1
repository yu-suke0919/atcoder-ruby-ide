# C0 spike (not for merge): the checks GitHub's Windows runners cannot do, because they only have WSL1.
# Run it on your own PC from the folder you extracted the kit to:
#   powershell -ExecutionPolicy Bypass -File .\wsl2-check.ps1
# It uses your default WSL distribution, runs "wsl --shutdown" once, puts the Ruby in ~/.c0-check
# and removes that folder at the end. The results go to c0-report.txt next to this script.
# Continue: Windows PowerShell turns a native command's stderr into errors, and this script reads it as text.
$ErrorActionPreference = 'Continue'
$env:WSL_UTF8 = '1'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$report = New-Object System.Collections.Generic.List[string]
function Note($label, $value) { $line = "${label}: $value"; Write-Host $line; $report.Add($line) }
function Wsl([string]$command) { ((& wsl.exe -e bash -c $command 2>&1) | Out-String).Trim() }
function Timed([scriptblock]$block) { $sw = [Diagnostics.Stopwatch]::StartNew(); $null = & $block; $sw.ElapsedMilliseconds }
function Count([string]$pattern) { Wsl "pgrep -f '$pattern' | wc -l" }
function Sleeps { Count '^sleep 300$' }
$utf8 = New-Object Text.UTF8Encoding $false
$agentCommand = '-e bash -c "exec ~/.c0-check/ruby/bin/ruby ~/.c0-check/agent.rb"'

function Start-Agent {
  $info = New-Object Diagnostics.ProcessStartInfo 'wsl.exe', $agentCommand
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.StandardOutputEncoding = $utf8
  $process = [Diagnostics.Process]::Start($info)
  $writer = New-Object IO.StreamWriter($process.StandardInput.BaseStream, $utf8)
  $writer.AutoFlush = $true
  $writer.NewLine = "`n"
  @{ Process = $process; In = $writer; Out = $process.StandardOutput }
}
function Send($agent, $request) { $agent.In.WriteLine(($request | ConvertTo-Json -Compress)) }
function Ask($agent, $request) { Send $agent $request; $agent.Out.ReadLine() | ConvertFrom-Json }

try {
  $os = Get-CimInstance Win32_OperatingSystem
  Note 'windows' "$($os.Caption) $($os.Version)"
  Note 'wsl --version' (((& wsl.exe --version) | Out-String).Trim() -replace '\s*\r?\n\s*', ' / ')
  Note 'wsl -l -v' (((& wsl.exe -l -v) | Out-String).Trim() -replace '\s*\r?\n\s*', ' / ')
  & wsl.exe --shutdown
  Note 'start after shutdown ms' (Timed { & wsl.exe -e true })
  Note 'start again ms' (Timed { & wsl.exe -e true })
  Note 'kernel' (Wsl 'uname -r')
  Note 'distribution' (Wsl '. /etc/os-release; echo $PRETTY_NAME')

  $archive = Wsl ("wslpath -a '" + ((Join-Path $here 'ruby-linux.tar.gz') -replace '\\', '/') + "'")
  $kit = Wsl ("wslpath -a '" + ($here -replace '\\', '/') + "'")
  Note 'extract ms' (Timed { Wsl "rm -rf ~/.c0-check && mkdir -p ~/.c0-check && tar -xzf '$archive' -C ~/.c0-check && cp '$kit/agent.rb' '$kit/checks.rb' ~/.c0-check/" })
  Note 'first ruby run ms' (Timed { Wsl '~/.c0-check/ruby/bin/ruby -e 0' })
  Note 'second ruby run ms' (Timed { Wsl '~/.c0-check/ruby/bin/ruby -e 0' })
  Note 'missing libraries' (Wsl "{ find ~/.c0-check/ruby -name '*.so' -exec ldd {} \; ; ldd ~/.c0-check/ruby/bin/ruby; } | grep 'not found' | sort -u | tr '\n' ' '; echo end")
  foreach ($line in ((Wsl '~/.c0-check/ruby/bin/ruby ~/.c0-check/checks.rb') -split "`r?`n")) { $report.Add($line); Write-Host $line }

  # The channel: Japanese, emoji and control characters, then a large output.
  $agent = Start-Agent
  $text = (-join [char[]](0x65E5, 0x672C, 0x8A9E)) + ' ' + [char]::ConvertFromUtf32(0x1F600) + "`t`"q`"\"
  $mismatched = 0
  $ms = Timed { for ($i = 0; $i -lt 300; $i++) { if ((Ask $agent @{ type = 'echo'; id = $i; text = "$text $i" }).text -ne "$text $i") { $mismatched++ } } }
  Note 'echo 300 (mismatched, ms)' "$mismatched, $ms"
  $chunks = 0
  $ms = Timed {
    Send $agent @{ type = 'flood'; id = 1; lines = 20000 }
    while ((($line = $agent.Out.ReadLine()) | ConvertFrom-Json).type -eq 'chunk') { $chunks++ }
  }
  Note 'flood 20000 lines (received, ms)' "$chunks, $ms"

  # WSL2 stops its VM when nothing runs; the agent must keep it alive. Nothing else touches WSL meanwhile.
  Start-Sleep -Seconds 75
  Note 'echo after 75 s idle' ((Ask $agent @{ type = 'echo'; id = 2; text = 'ok' }).text)

  # 1. The app quits normally: it closes the agent's stdin.
  $null = Ask $agent @{ type = 'spawn'; id = 3 }
  $agent.In.Close()
  Note 'after closing stdin: agent exited' ($agent.Process.WaitForExit(5000))
  Start-Sleep -Milliseconds 500
  Note 'after closing stdin: agents, sleeps' "$(Count '[a]gent.rb'), $(Sleeps)"
  $null = Wsl "pkill -f '^sleep 300$'; rm -f /tmp/c0-agent-signal; true"

  # 2. The app crashes: Windows kills wsl.exe.
  $agent = Start-Agent
  $null = Ask $agent @{ type = 'spawn'; id = 4 }
  $null = Ask $agent @{ type = 'spawn'; id = 5; timeout = 8 }
  $agent.Process.Kill()
  Start-Sleep -Seconds 3
  Note 'after killing wsl.exe: agents, sleeps, timeout groups, signal' "$(Count '[a]gent.rb'), $(Sleeps), $(Count '[t]imeout -s KILL'), $(Wsl 'cat /tmp/c0-agent-signal 2>/dev/null || echo none')"
  Start-Sleep -Seconds 7
  Note 'after 8 s timeout: sleeps, timeout groups' "$(Sleeps), $(Count '[t]imeout -s KILL')"
} catch {
  Note 'error' $_
} finally {
  $null = Wsl "pkill -f '^sleep 300$'; rm -rf ~/.c0-check /tmp/c0-agent-signal; true"
  [IO.File]::WriteAllLines((Join-Path $here 'c0-report.txt'), $report, $utf8)
  Write-Host "Saved $(Join-Path $here 'c0-report.txt')"
}
