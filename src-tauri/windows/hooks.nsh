; Uninstalling removes the app's WSL distribution; it holds no user data (docs/architecture.md#wslのエージェント).
; The installer may be 32-bit: Sysnative reaches the 64-bit wsl.exe from there.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} ${FileExists} "$WINDIR\Sysnative\wsl.exe"
    nsExec::Exec '"$WINDIR\Sysnative\wsl.exe" --unregister AtCoderRubyIDE'
  ${Else}
    nsExec::Exec '"$SYSDIR\wsl.exe" --unregister AtCoderRubyIDE'
  ${EndIf}
  Pop $0
!macroend
