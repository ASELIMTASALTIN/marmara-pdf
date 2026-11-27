; Installer hooks.
;  * Put the install folder on the user's PATH so the `marmara` command line works in any
;    new terminal (taken off again on uninstall).
;  * Install the AI assistant's model: Windows installers cannot hold files over 2 GB, so the
;    model (.gguf) ships in a "models" folder next to this setup program and is copied here.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); $$parts=@(); if($$p){$$parts=@($$p -split ';' | Where-Object {$$_})}; if($$parts -notcontains $$d){[Environment]::SetEnvironmentVariable('Path',(($$parts + $$d) -join ';'),'User')}"`
  ; The model goes to the per-user data folder, which installs, updates and uninstalls leave alone
  ; (only "delete application data" in the uninstaller removes it).
  IfFileExists "$EXEDIR\models\*.gguf" 0 marmara_no_model
    DetailPrint "Installing the AI assistant model (this can take a minute)..."
    CreateDirectory "$LOCALAPPDATA\com.marmara.pdf\models"
    CopyFiles "$EXEDIR\models\*.gguf" "$LOCALAPPDATA\com.marmara.pdf\models"
  marmara_no_model:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); if($$p){$$n=@($$p -split ';' | Where-Object {$$_ -and ($$_ -ne $$d)}) -join ';'; [Environment]::SetEnvironmentVariable('Path',$$n,'User')}"`
!macroend
