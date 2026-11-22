; The 1.x (electron-builder) installer hooks, kept as the reference for what the 2.0 installer
; (rust/crates/spawnloft-shell/windows/installer.nsi) does the same way. Nothing includes it now.
;
; The uninstaller removes the program folder and nothing else, on purpose. Two leftovers are never
; wanted though: scheduled tasks that would keep firing at a program that is gone, and servers left
; running with nothing to stop them. Both are cleared by the program's own `uninstall` command, run
; here while the files are still in place - customUnInstall runs before the folder is removed.
; Whether the data goes too is the person's choice, asked here, defaulting to no.
;
; An update runs the old uninstaller with --updated. Nothing here runs in that case: the servers,
; the tasks and the data all carry across.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $R9 ""
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "Also delete your servers, worlds, backups, downloaded jars and settings?$\r$\n$\r$\n\
No keeps them on disk for a later reinstall.$\r$\n\
Servers you added from folders you already had are never deleted either way." \
        IDYES customUnInstall_purge
      Goto customUnInstall_run
      customUnInstall_purge:
        StrCpy $R9 "--data"
      customUnInstall_run:
    ${endIf}
    ; The executable is Electron: told to run as Node, it runs the command line instead of the app.
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    DetailPrint "Stopping servers and removing scheduled tasks"
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\core\mcctl.mjs" uninstall --yes $R9'
    Pop $R8
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0)'
  ${endIf}
!macroend
