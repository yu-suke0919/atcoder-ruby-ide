param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DialogMessages {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, string text);
}
'@
$request = [IO.File]::ReadAllText($RequestFile) | ConvertFrom-Json
$scope = [System.Windows.Automation.TreeScope]::Descendants
$properties = [System.Windows.Automation.AutomationElement]
function Find-Element($root, $property, $value) {
  $condition = [System.Windows.Automation.PropertyCondition]::new($property, $value)
  return $root.FindFirst($scope, $condition)
}
function Click-Button($button) {
  if (!$button) { throw 'Dialog button was not found' }
  $handle = $button.Current.NativeWindowHandle
  if ($handle -ne 0) {
    [void][DialogMessages]::PostMessage([IntPtr]$handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
  } else {
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
}
try {
  foreach ($step in $request.steps) {
    $dialog = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
      $condition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new($properties::ProcessIdProperty, [int]$request.processId),
        [System.Windows.Automation.PropertyCondition]::new($properties::NameProperty, [string]$step.title))
      $dialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst($scope, $condition)
      if ($dialog) { break }
      Start-Sleep -Milliseconds 100
    }
    if (!$dialog) { throw "Dialog not found: $($step.title)" }
    if ($step.path) {
      $hostControl = Find-Element $dialog $properties::AutomationIdProperty 'FileNameControlHost'
      $edit = if ($hostControl) { Find-Element $hostControl $properties::ClassNameProperty 'Edit' }
      if (!$edit) {
        $candidates = $dialog.FindAll($scope, [System.Windows.Automation.PropertyCondition]::new($properties::AutomationIdProperty, '1148'))
        foreach ($candidate in $candidates) {
          if ($candidate.Current.ClassName -eq 'Edit') { $edit = $candidate; break }
          $edit = Find-Element $candidate $properties::ClassNameProperty 'Edit'
          if ($edit) { break }
        }
      }
      if (!$edit) { throw 'File name edit control was not found' }
      # These standard HWND controls sometimes expose only a generic UIA pane.
      # WM_SETTEXT works with their actual Edit handles without keyboard/clipboard races.
      [void][DialogMessages]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, [string]$step.path)
    }
    $button = if ($step.buttonName) {
      Find-Element $dialog $properties::NameProperty ([string]$step.buttonName)
    } else { Find-Element $dialog $properties::AutomationIdProperty ([string]$step.buttonId) }
    Click-Button $button
    Start-Sleep -Milliseconds 150
  }
} catch {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll($scope,
    [System.Windows.Automation.PropertyCondition]::new($properties::ProcessIdProperty, [int]$request.processId))
  foreach ($element in $windows) {
    Write-Output "$($element.Current.ControlType.ProgrammaticName) class=$($element.Current.ClassName) id=$($element.Current.AutomationId) name=$($element.Current.Name)"
  }
  if ($dialog) {
    [void][DialogMessages]::PostMessage([IntPtr]$dialog.Current.NativeWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  throw
}
