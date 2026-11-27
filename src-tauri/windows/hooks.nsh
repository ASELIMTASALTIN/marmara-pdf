; Installer hooks: put the install folder on the user's PATH so the `marmara`
; command line works in any new terminal, and take it off again on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); $$parts=@(); if($$p){$$parts=@($$p -split ';' | Where-Object {$$_})}; if($$parts -notcontains $$d){[Environment]::SetEnvironmentVariable('Path',(($$parts + $$d) -join ';'),'User')}"`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); if($$p){$$n=@($$p -split ';' | Where-Object {$$_ -and ($$_ -ne $$d)}) -join ';'; [Environment]::SetEnvironmentVariable('Path',$$n,'User')}"`
!macroend
