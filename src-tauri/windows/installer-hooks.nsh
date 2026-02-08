; RainyDesk NSIS installer hooks
; Cleans up autostart registry entry on uninstall

!macro NSIS_HOOK_PREUNINSTALL
    ; Remove autostart registry entry if it exists
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "RainyDesk"
!macroend
