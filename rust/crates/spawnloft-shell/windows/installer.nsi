; SpawnLoft's fork of Tauri's NSIS template (tauri-bundler 2.10.4, kept beside this file as
; installer.upstream-tauri-bundler-2.10.4.nsi). Every change is marked "SPAWNLOFT:". Re-sync it
; with each Tauri bundler bump and have it reviewed (PLAN-RUST-TAURI.md Q25).
;
; What the changes do (PLAN-RUST-TAURI.md section 4, "Install folder and registry key"):
; - install where 1.x lives (%LOCALAPPDATA%\Programs\SpawnLoft) under 1.x's uninstall key
;   (HKCU\...\Uninstall\<UUIDv5 of the appId>, as electron-builder names it) and its
;   InstallLocation key, so Windows, shortcuts, task shims, launchers and MCP configs see the same
;   program at the same path;
; - take electron-updater's arguments (/S --updated --force-run) as well as Tauri's
;   (/P or /S, /UPDATE, /R, /ARGS), so 1.x can install 2.0 and 2.0 can update itself;
; - over a 1.x install, run the 1.x uninstaller the way electron-builder's own update does
;   (/S /KEEP_APP_DATA --updated --keep-shortcuts _?=<dir>): servers, tasks and data stay;
; - keep 1.x's uninstall behaviour: stop servers and remove scheduled tasks through
;   `uninstall --yes`, and ask (default no) whether to delete the data too;
; - a running spawnloft-core (daemons) never blocks an update: the old binary is renamed aside
;   into resources\bin\old-<stamp>\, keeping its file name (design section 4);
; - the bundled Node lives in a versioned folder, resources\runtime\node-<ver>\; a held node.exe
;   of the same version is renamed aside into resources\runtime\old-<stamp>\, and other
;   versions' folders go once nothing runs them (PLAN-2.0-REMAINING.md A6);
; - a 1.x installer can still roll back over this install (it finds the same keys and runs this
;   uninstaller with --updated);
; - over 1.x, servers are stopped gracefully through the installed 1.x CLI before the 1.x
;   uninstaller runs (`spawnloft-core handover stop`, extracted first) and started again through
;   2.0 afterwards (`handover resume`); a server that will not stop aborts the update and leaves
;   1.x as it was (rust/INSTALLER-UPDATER-DESIGN.md sections 2 to 4 and 9);
; - one setup and one uninstaller at a time (named mutexes), /ROLLBACK allows the one downgrade a
;   rollback asks for, /NORESUME leaves the stopped servers stopped (tests);
; - once servers are stopped for the handover, nothing ends the install without putting them
;   back: over 1.x a failed WebView2 download or install does not stop the install (design 2.6),
;   .onInstFailed starts them again under 1.x when a section gives up while 1.x is still there,
;   and `handover stop` is told this setup's process id, so it puts everything back itself when
;   the setup is ended under it. (A stop cut short with the whole session, by a shutdown or a
;   power cut, is put back at the next sign-in or by the next attempt: spawnloft-lib handover.)

Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include TextFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

; SPAWNLOFT: the hooks file (written by spawnloft-shell/installer/installer-config.mjs) names the
; core binary's source, which the installer extracts on its own before anything else (2.3 step 1)
!ifndef SPAWNLOFT_CORE_SRC
  !error "SPAWNLOFT_CORE_SRC is not defined: build with installer/installer-config.mjs"
!endif
; and the bundled Node's folder under resources\runtime\ (node-<version>)
!ifndef SPAWNLOFT_NODE_DIR
  !error "SPAWNLOFT_NODE_DIR is not defined: build with installer/installer-config.mjs"
!endif

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
; SPAWNLOFT: electron-builder's names for the same app id (UUIDv5 of io.github.joogiebear.mcctl in
; electron-builder's namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3), so this is the 1.x program
!define APPGUID "bd3d287b-0ff4-5383-8897-c9d8dbd7d2e3"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPGUID}"
!define MANUKEY "Software\${MANUFACTURER}"
; electron-builder's INSTALL_REGISTRY_KEY: InstallLocation, KeepShortcuts, ShortcutName
!define MANUPRODUCTKEY "Software\${APPGUID}"
!define LEGACYUNINSTALLER "Uninstall ${PRODUCTNAME}.exe"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName
; SPAWNLOFT: 1 when the install found is SpawnLoft 1.x (Electron), 1 when electron-updater asked
; for the app to be started afterwards
Var LegacyMode
Var LegacyDir
Var ForceRun
; SPAWNLOFT: the 1.x version found, the staged core, the stop's progress, and the new flags
Var LegacyVersion
Var CoreStaged
Var StopDone
Var StopRunning
Var StopLabel
Var Rollback
Var NoResume
; SPAWNLOFT: this setup's process id, for `handover stop --installer-pid`
Var SetupPid

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall

; Find a previous WiX installation and set $R6 to its uninstall registry key, or to "" if none.
;
; A WiX installer stores the installation info in registry
; using a UUID and so we have to loop through all keys under
; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
;
; This has a potential issue that there maybe another installation that matches
; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
; however, this should be fine since the user will have to confirm the uninstallation
; and they can chose to abort it if doesn't make sense.
Function FindWixInstall
  StrCpy $R6 ""
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
  wix_loop_done:
FunctionEnd

Function PageReinstall
  ; SPAWNLOFT: replacing 1.x is not a choice to offer; the Install section does it
  ${IfThen} $LegacyMode = 1 ${|} Abort ${|}

  ; Uninstall previous WiX installation if exists.
  Call FindWixInstall
  ${If} $R6 != ""
    StrCpy $WixMode 1
    Goto compare_version
  ${EndIf}

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0

  ; Read the install choice header through $R5 so a custom language file that only
  ; defines the misspelled `choowHowToInstall` still shows its own text
  ; TODO: remove the `choowHowToInstall` fallback in a future major version
  StrCpy $R5 "$(chooseHowToInstall)"
  ${IfThen} $R5 == "" ${|} StrCpy $R5 "$(choowHowToInstall)" ${|}

  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$R5"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$R5"
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the beginning
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1

    ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
    Pop $R3
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" "InstallLocation" ; SPAWNLOFT: 1.x value name
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other errors? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}

    ; The NSIS uninstaller was run in place (`_?=`), so it cannot delete itself
    ; and the install directory, clean them up here once the uninstall succeeded
    ; https://nsis.sourceforge.io/Docs/Chapter3.html#:~:text=path%20contains%20spaces.-,3.2.3%20Examples,-installer.exe%20/NCRC
    ${If} $WixMode = 0
    ${AndIf} $4 != ""
      Delete "$4\uninstall.exe"
      RMDir "$4"
    ${EndIf}
  reinst_done:
FunctionEnd

; SPAWNLOFT: 4b. over 1.x in the full UI, the servers are stopped on a page of their own, with
; progress and Cancel, before anything is changed (design 2.3.2)
Page custom PageStopping PageLeaveStopping

; 5. Choose install directory page
; SPAWNLOFT: not when replacing 1.x, which must stay where its shims and launchers point
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassiveOrLegacy
!insertmacro MUI_PAGE_DIRECTORY

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

; SPAWNLOFT: the core binary, extracted once, run from a per-user folder under the install folder
; (no AppLocker or SRP rule treats it as temp), $PLUGINSDIR when that cannot be written
Function StageCore
  ${If} $CoreStaged != ""
    Return
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\spawnloft-core.exe" "${SPAWNLOFT_CORE_SRC}"
  StrCpy $CoreStaged "$PLUGINSDIR\spawnloft-core.exe"
  ${If} $LegacyMode = 1
    ClearErrors
    CreateDirectory "$LegacyDir\resources\bin\staging"
    CopyFiles /SILENT "$PLUGINSDIR\spawnloft-core.exe" "$LegacyDir\resources\bin\staging"
    ${IfNot} ${Errors}
    ${AndIf} ${FileExists} "$LegacyDir\resources\bin\staging\spawnloft-core.exe"
      StrCpy $CoreStaged "$LegacyDir\resources\bin\staging\spawnloft-core.exe"
    ${EndIf}
  ${EndIf}
FunctionEnd

; SPAWNLOFT: what 1.x was running is running again under 1.x, after an abort that came after the
; stop (cancel, a failed 1.x uninstall). The copy in $PLUGINSDIR is used: staging may be gone.
Function RestoreLegacyServers
  ${If} $StopDone = 1
    DetailPrint "Starting the stopped servers again under SpawnLoft 1"
    nsExec::ExecToLog '"$PLUGINSDIR\spawnloft-core.exe" handover restore --legacy-dir "$LegacyDir"'
    Pop $0
    StrCpy $StopDone 0
  ${EndIf}
FunctionEnd

Function PageStopping
  ${If} $LegacyMode <> 1
  ${OrIf} $PassiveMode = 1
    Abort
  ${EndIf}
  ${If} $StopDone = 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Stopping servers for the update" "Each running server is asked to stop and save. They start again after the update."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 100% "Looking for running servers..."
  Pop $StopLabel
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  Call StageCore
  Delete "$PLUGINSDIR\handover-exit.txt"
  Delete "$PLUGINSDIR\handover-cancel"
  Delete "$PLUGINSDIR\handover-progress.txt"
  StrCpy $StopRunning 1
  ; not waited for: the page's timer follows it through the status files
  ExecShell "" '"$CoreStaged"' 'handover stop --legacy-dir "$LegacyDir" --legacy-version "$LegacyVersion" --status-dir "$PLUGINSDIR" --installer-pid $SetupPid' SW_HIDE
  ${NSD_CreateTimer} StopTick 400
  nsDialogs::Show
FunctionEnd

Function StopTick
  ClearErrors
  FileOpen $1 "$PLUGINSDIR\handover-progress.txt" r
  ${IfNot} ${Errors}
    StrCpy $2 ""
    ${Do}
      ClearErrors
      FileRead $1 $3
      ${IfThen} ${Errors} ${|} ${ExitDo} ${|}
      StrCpy $2 "$2$3"
    ${Loop}
    FileClose $1
    ${IfThen} $2 != "" ${|} SendMessage $StopLabel ${WM_SETTEXT} 0 "STR:$2" ${|}
  ${EndIf}
  ${IfNot} ${FileExists} "$PLUGINSDIR\handover-exit.txt"
    Return
  ${EndIf}
  ${NSD_KillTimer} StopTick
  StrCpy $StopRunning 0
  FileOpen $1 "$PLUGINSDIR\handover-exit.txt" r
  FileRead $1 $2
  FileRead $1 $3
  FileClose $1
  ${TrimNewLines} $2 $2
  ${TrimNewLines} $3 $3
  ${If} $2 == "0"
    StrCpy $StopDone 1
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 1
    ; on to the next page by itself
    SendMessage $HWNDPARENT 0x408 1 0
  ${ElseIf} ${FileExists} "$PLUGINSDIR\handover-cancel"
    SetErrorLevel 4
    Quit
  ${ElseIf} $2 == "3"
    MessageBox MB_ICONEXCLAMATION "$3 is still running and could not be stopped in 5 minutes. Stop it and run the update again. Nothing was changed." /SD IDOK
    SetErrorLevel 4
    Quit
  ${Else}
    MessageBox MB_ICONSTOP "The servers could not be stopped for the update (code $2). Nothing was changed." /SD IDOK
    SetErrorLevel 4
    Quit
  ${EndIf}
FunctionEnd

Function PageLeaveStopping
  ${If} $StopDone <> 1
    Abort
  ${EndIf}
FunctionEnd

; Cancel (MUI's .onUserAbort calls it, MUI_CUSTOMFUNCTION_ABORT): a stop in progress is told to stop (it starts again what it had stopped, under 1.x);
; servers already stopped are started again; 1.x is left exactly as it was.
Function SpawnLoftUserAbort
  ${If} $StopRunning = 1
    FileOpen $1 "$PLUGINSDIR\handover-cancel" w
    FileClose $1
    StrCpy $0 0
    ${DoUntil} ${FileExists} "$PLUGINSDIR\handover-exit.txt"
      Sleep 250
      IntOp $0 $0 + 1
      ${IfThen} $0 > 2400 ${|} ${ExitDo} ${|}
    ${Loop}
    StrCpy $StopRunning 0
    ; A stop that had already ended with everything stopped (its answer not read yet by the
    ; page's timer) never saw the Cancel: its servers are started again here.
    ClearErrors
    FileOpen $1 "$PLUGINSDIR\handover-exit.txt" r
    ${IfNot} ${Errors}
      FileRead $1 $2
      FileClose $1
      IntOp $2 $2 + 0
      ${If} $2 = 0
        StrCpy $StopDone 1
        Call RestoreLegacyServers
      ${EndIf}
    ${EndIf}
  ${Else}
    Call RestoreLegacyServers
  ${EndIf}
  SetErrorLevel 4
FunctionEnd

; SPAWNLOFT: one setup and one uninstaller at a time. A second one (the 1.x panel's install on
; quit starting the pending setup again, a double-click) exits at once with error level 5.
!macro SPAWNLOFT_SINGLE_INSTANCE NAME
  System::Call 'kernel32::CreateMutexW(p 0, i 1, w "${NAME}") p .R9 ?e'
  Pop $R8
  ${If} $R8 = 183
    SetErrorLevel 5
    Quit
  ${EndIf}
!macroend

; SPAWNLOFT: core binaries moved aside by earlier updates, once nothing runs them any more (a
; held file is not deleted, so its folder stays for the next install)
!macro SPAWNLOFT_CLEAN_OLD_CORES
  Delete "$INSTDIR\resources\bin\spawnloft-core.old-*.exe"
  ClearErrors
  FindFirst $R7 $R8 "$INSTDIR\resources\bin\old-*"
  ${DoWhile} $R8 != ""
    Delete "$INSTDIR\resources\bin\$R8\spawnloft-core.exe"
    RMDir "$INSTDIR\resources\bin\$R8"
    FindNext $R7 $R8
  ${Loop}
  FindClose $R7
!macroend

; SPAWNLOFT: Node runtimes moved aside by earlier updates, once nothing runs them (a held
; node.exe is not deleted, so its folder stays for the next install)
!macro SPAWNLOFT_CLEAN_OLD_RUNTIMES
  ClearErrors
  FindFirst $R7 $R8 "$INSTDIR\resources\runtime\old-*"
  ${DoWhile} $R8 != ""
    Delete "$INSTDIR\resources\runtime\$R8\node.exe"
    RMDir "$INSTDIR\resources\runtime\$R8"
    FindNext $R7 $R8
  ${Loop}
  FindClose $R7
!macroend

; SPAWNLOFT: other versions' runtime folders, once nothing runs them. Only after this build's
; runtime and runtime.json are in place: until then the installed copy still runs the old one,
; and an install that stops early (cancelled, a held file) must leave it working.
!macro SPAWNLOFT_CLEAN_OTHER_RUNTIMES
  ClearErrors
  FindFirst $R7 $R8 "$INSTDIR\resources\runtime\node-*"
  ${DoWhile} $R8 != ""
    ${If} $R8 != "${SPAWNLOFT_NODE_DIR}"
      Delete "$INSTDIR\resources\runtime\$R8\node.exe"
      Delete "$INSTDIR\resources\runtime\$R8\LICENSE"
      RMDir "$INSTDIR\resources\runtime\$R8"
    ${EndIf}
    FindNext $R7 $R8
  ${Loop}
  FindClose $R7
!macroend

; SPAWNLOFT: this build's node.exe, when the same version is installed already and a long-lived
; process runs it (`spawnloft mcp`, the bot host, a console): a running exe cannot be overwritten
; but can be renamed, so it moves into a dated folder of its own, as the core does, and the new
; copy is written in its place (PLAN-2.0-REMAINING.md A6).
!macro SPAWNLOFT_MOVE_HELD_NODE
  ${If} ${FileExists} "$INSTDIR\resources\runtime\${SPAWNLOFT_NODE_DIR}\node.exe"
    ClearErrors
    Delete "$INSTDIR\resources\runtime\${SPAWNLOFT_NODE_DIR}\node.exe"
    ${If} ${Errors}
      ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
      StrCpy $R6 "old-$2$1$0-$4$5$6"
      ${If} ${FileExists} "$INSTDIR\resources\runtime\$R6\*.*"
        System::Call "kernel32::GetTickCount() i .r0"
        StrCpy $R6 "$R6-$0"
      ${EndIf}
      ClearErrors
      CreateDirectory "$INSTDIR\resources\runtime\$R6"
      Rename "$INSTDIR\resources\runtime\${SPAWNLOFT_NODE_DIR}\node.exe" "$INSTDIR\resources\runtime\$R6\node.exe"
      ${If} ${Errors}
        SetErrorLevel 2
        Abort "node.exe is in use and could not be moved aside"
      ${EndIf}
      DetailPrint "node.exe is in use; it was moved to resources\runtime\$R6 until that program ends"
    ${EndIf}
  ${EndIf}
!macroend

!define MUI_CUSTOMFUNCTION_ABORT SpawnLoftUserAbort
;Languages
; PageReinstall reads the misspelled `choowHowToInstall` as a fallback, and makensis warns
; about a language string that is read but never set, so default it to an empty string for
; every language. This runs before the language files are included, so a custom language
; file that only defines the old spelling overrides the default and the fallback shows its
; text. `0` as the language id means the language inserted right above.
; TODO: remove the `choowHowToInstall` fallback in a future major version
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
LangString choowHowToInstall 0 ""
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}
; SPAWNLOFT: the uninstaller's one question is 1.x's (installer.nsh), default no
LangString deleteAppData ${LANG_ENGLISH} "Also delete servers, worlds, backups, jars and settings"

Function .onInit
  !insertmacro SPAWNLOFT_SINGLE_INSTANCE "Local\SpawnLoftSetup-${APPGUID}"
  System::Call 'kernel32::GetCurrentProcessId() i .s'
  Pop $SetupPid

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  ; SPAWNLOFT: electron-updater runs the new installer with `--updated /S --force-run`. Read from
  ; the parameters only: an unquoted installer path with a ' in it confuses GetOptions.
  ${GetParameters} $R1
  ${GetOptions} $R1 "--updated" $R0
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ${GetOptions} $R1 "--force-run" $R0
  ${IfNot} ${Errors}
    StrCpy $ForceRun 1
  ${EndIf}
  ; SPAWNLOFT: /ROLLBACK (the one downgrade a rollback asks for; the app is started again
  ; through --force-run, so the flag never reaches it) and /NORESUME (tests)
  ${GetOptions} $R1 "/ROLLBACK" $R0
  ${IfNot} ${Errors}
    StrCpy $Rollback 1
    ${IfThen} $PassiveMode = 1 ${|} StrCpy $ForceRun 1 ${|}
  ${EndIf}
  ${GetOptions} $R1 "/NORESUME" $R0
  ${IfNot} ${Errors}
    StrCpy $NoResume 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      ; SPAWNLOFT: electron-builder's per-user folder, where every 1.x install is
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}

  ; SPAWNLOFT: is the install found SpawnLoft 1.x? Only 1.x has an uninstaller by that name (2.x
  ; never ships one and RemoveLegacyInstall deletes it). Not a registry marker: a 1.x rollback
  ; over 2.x rewrites the keys but keeps any value it does not know.
  ${If} ${FileExists} "$INSTDIR\${LEGACYUNINSTALLER}"
    StrCpy $LegacyMode 1
    StrCpy $LegacyDir $INSTDIR
    ; "1.6.0-beta.413"; empty on a key without it (the core then reads resources\core\package.json)
    ReadRegStr $LegacyVersion SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif

  ; Abort downgrades if they are disabled, in the modes that skip the reinstall page choice:
  ; silent, passive and update
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} $Rollback = 1
    ; SPAWNLOFT: a rollback the person asked for (design 5.6)
  ${ElseIf} ${Silent}
  ${OrIf} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    ; Compare with the same installation the reinstall page would: a WiX one first
    Call FindWixInstall
    ${If} $R6 != ""
      ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
    ${Else}
      ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
    ${EndIf}
    nsis_tauri_utils::SemverCompare "${VERSION}" $R0
    Pop $R0
    ; If downgrading
    ${If} $R0 = -1
      ${If} ${Silent}
        System::Call 'kernel32::AttachConsole(i -1)i.r0'
        ${If} $0 <> 0
          System::Call 'kernel32::GetStdHandle(i -11)i.r0'
          System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
          FileWrite $0 "$(silentDowngrades)"
        ${EndIf}
      ${Else}
        MessageBox MB_ICONSTOP "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif
FunctionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating, except from 1.x, which never needed WebView2 (SPAWNLOFT)
    ${If} $UpdateMode <> 1
    ${OrIf} $LegacyMode = 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          ; SPAWNLOFT: over 1.x the install goes on (design 2.6). In the full UI the servers are
          ; stopped by now, and stopping here would leave them down; the CLI, daemons and MCP
          ; need no WebView2, and the app's first start says where to get it.
          ${If} $LegacyMode = 1
            DetailPrint "SpawnLoft 2 is being installed without Microsoft Edge WebView2. Its window will say how to get it."
            Goto webview2_done
          ${EndIf}
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          ; SPAWNLOFT: as above
          ${If} $LegacyMode = 1
            DetailPrint "SpawnLoft 2 is being installed without Microsoft Edge WebView2. Its window will say how to get it."
            Goto webview2_done
          ${EndIf}
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              ; SPAWNLOFT: Quit runs no callback; servers the stopping page stopped start again
              Call RestoreLegacyServers
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  ; SPAWNLOFT: the core first (2.3 step 1), then, over 1.x, the servers stopped through 1.x
  ; before its uninstaller can kill them (step 2), then 1.x removed the way its own updates do
  ; (step 3)
  Call StageCore
  !insertmacro SPAWNLOFT_CLEAN_OLD_CORES
  !insertmacro SPAWNLOFT_CLEAN_OLD_RUNTIMES
  ${If} $LegacyMode = 1
    ${If} $StopDone <> 1
      DetailPrint "Stopping servers for the update"
      StrCpy $0 ""
      ${If} ${Silent}
      ${OrIf} $PassiveMode = 1
        StrCpy $0 "--silent"
      ${EndIf}
      nsExec::ExecToLog '"$CoreStaged" handover stop --legacy-dir "$LegacyDir" --legacy-version "$LegacyVersion" --installer-pid $SetupPid $0'
      Pop $1
      ; string compares: nsExec pushes "error" or "timeout" when the core did not run, which an
      ; integer compare would read as 0 (stopped) and let the 1.x uninstaller kill the servers
      ${If} $1 == "0"
        StrCpy $StopDone 1
      ${ElseIf} $1 == "3"
        DetailPrint "A server is still running and could not be stopped; SpawnLoft 1 was left as it was"
        MessageBox MB_ICONEXCLAMATION "A server is still running and could not be stopped in 5 minutes. Stop it and run the update again. Nothing was changed." /SD IDOK
        SetErrorLevel 4
        Quit
      ${Else}
        DetailPrint "The servers could not be stopped for the update (code $1); SpawnLoft 1 was left as it was"
        MessageBox MB_ICONSTOP "The servers could not be stopped for the update (code $1). Nothing was changed." /SD IDOK
        SetErrorLevel 4
        Quit
      ${EndIf}
    ${EndIf}
    Call RemoveLegacyInstall
  ${EndIf}

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; SPAWNLOFT: a rollback (design 5.6) removes the newer version's files first; update mode keeps
  ; keys, shortcuts, tasks and data
  ${If} $Rollback = 1
  ${AndIf} $LegacyMode = 0
  ${AndIf} ${FileExists} "$INSTDIR\uninstall.exe"
    DetailPrint "Removing the newer version's files"
    ExecWait '"$INSTDIR\uninstall.exe" /S /UPDATE _?=$INSTDIR' $0
  ${EndIf}

  ; SPAWNLOFT: servers' daemons run from resources\bin\spawnloft-core.exe and keep running
  ; through an update. A running exe cannot be overwritten but can be renamed: move it into a
  ; dated folder of its own, keeping its file name (design section 4), and install the new one in
  ; its place; the folder goes at a later install once nothing runs it.
  ${If} ${FileExists} "$INSTDIR\resources\bin\spawnloft-core.exe"
    ClearErrors
    Delete "$INSTDIR\resources\bin\spawnloft-core.exe"
    ${If} ${Errors}
      ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
      StrCpy $R6 "old-$2$1$0-$4$5$6"
      ${If} ${FileExists} "$INSTDIR\resources\bin\$R6\*.*"
        System::Call "kernel32::GetTickCount() i .r0"
        StrCpy $R6 "$R6-$0"
      ${EndIf}
      ClearErrors
      CreateDirectory "$INSTDIR\resources\bin\$R6"
      Rename "$INSTDIR\resources\bin\spawnloft-core.exe" "$INSTDIR\resources\bin\$R6\spawnloft-core.exe"
      ${If} ${Errors}
        SetErrorLevel 2
        Abort "spawnloft-core.exe is in use and could not be moved aside"
      ${EndIf}
      DetailPrint "spawnloft-core.exe is in use by running servers; it was moved to resources\bin\$R6 until they restart"
    ${EndIf}
  ${EndIf}
  !insertmacro SPAWNLOFT_MOVE_HELD_NODE

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0" "Open with ${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  ; SPAWNLOFT: under 1.x's value names, so a 1.x installer (a rollback) finds this install, plus a
  ; marker that tells the next 2.x installer this is not 1.x
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "InstallLocation" $INSTDIR
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "KeepShortcuts" "true"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "ShortcutName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "SpawnLoftShell" "tauri"

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  ; SPAWNLOFT: the staged copy has done its job
  RMDir /r "$INSTDIR\resources\bin\staging"
  ; and the Node runtimes of other versions, now that this one is in place
  !insertmacro SPAWNLOFT_CLEAN_OTHER_RUNTIMES

  ; SPAWNLOFT: `spawnloft` in a new terminal (spawnloft-lib user_path.rs). A new install and the
  ; 1.x handover put resources\bin on the user PATH; a 2.x update leaves the PATH as the user has
  ; it, so an entry they removed stays removed. A failure is logged and never fails the install.
  ${If} $UpdateMode <> 1
  ${OrIf} $LegacyMode = 2
    nsExec::ExecToLog '"$INSTDIR\resources\bin\spawnloft-core.exe" user-path add'
    Pop $0
  ${EndIf}

  ; SPAWNLOFT: task shims and server launchers rewritten for this install before any server
  ; starts again (2.3 step 8)
  ${If} $LegacyMode = 2
    DetailPrint "Updating scheduled tasks and server launchers"
    nsExec::ExecToLog '"$INSTDIR\resources\bin\spawnloft-core.exe" repair --quiet'
    Pop $0
    ; in the full UI, the servers start again here, before the Finish page, not when the window
    ; closes; silent and passive installs do it in .onInstSuccess, after the app is up
    ${IfNot} ${Silent}
    ${AndIf} $PassiveMode <> 1
      DetailPrint "Starting the servers again"
      ${If} $NoResume = 1
        nsExec::ExecToLog '"$INSTDIR\resources\bin\spawnloft-core.exe" handover resume --skip-start'
      ${Else}
        nsExec::ExecToLog '"$INSTDIR\resources\bin\spawnloft-core.exe" handover resume'
      ${EndIf}
      Pop $0
    ${EndIf}
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

; SPAWNLOFT: a section gave up (Abort, a file that could not be written). While 1.x is still
; installed, what the stop stopped is started again under it and its tasks are enabled again; in
; the full UI this runs when the person closes the failed setup. Once 1.x is removed there is
; nothing to start them with until SpawnLoft 2 is in place: the record stays, and the next run of
; this setup followed by SpawnLoft 2's first start puts them back.
Function .onInstFailed
  ${If} $LegacyMode = 1
    Call RestoreLegacyServers
  ${ElseIf} $LegacyMode = 2
    MessageBox MB_ICONSTOP "SpawnLoft 1 was removed, but SpawnLoft 2 could not be installed completely. Run this setup again, then open SpawnLoft: the servers that were running start again and the scheduled tasks are switched back on." /SD IDOK
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ; SPAWNLOFT: "/R" also matches the start of "/ROLLBACK", which never asks for /R
    StrCpy $R1 0
    ${If} $Rollback <> 1
      ClearErrors
      ${GetOptions} $CMDLINE "/R" $R0
      ${IfNot} ${Errors}
        StrCpy $R1 1
      ${EndIf}
    ${EndIf}
    ${If} $R1 = 1
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${ElseIf} $ForceRun = 1
      ; SPAWNLOFT: electron-updater's --force-run
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}

  ; SPAWNLOFT: after a handover, start again what was stopped, through 2.0: databases, then
  ; servers (2.3 step 9). Silent and passive: after the app is started on the Restart path, so
  ; the window is up first, and also on an install on quit with nobody there. The full UI did it
  ; at the end of the Install section, before the Finish page.
  StrCpy $R2 0
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    StrCpy $R2 1
  ${EndIf}
  ${If} $LegacyMode = 2
  ${AndIf} $R2 = 1
    ${If} $NoResume = 1
      nsExec::Exec '"$INSTDIR\resources\bin\spawnloft-core.exe" handover resume --skip-start'
    ${Else}
      nsExec::Exec '"$INSTDIR\resources\bin\spawnloft-core.exe" handover resume'
    ${EndIf}
    Pop $0
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SPAWNLOFT_SINGLE_INSTANCE "Local\SpawnLoftUninstall-${APPGUID}"
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  ; SPAWNLOFT: a 1.x installer replacing this install (rollback) runs it with --updated
  ${GetParameters} $R1
  ${GetOptions} $R1 "--updated" $R0
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ; SPAWNLOFT: the data box for a silent uninstall (the full UI shows the box, default off)
  ${GetOptions} $R1 "/DELETEAPPDATA" $R0
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; SPAWNLOFT: what 1.x's installer.nsh does: stop the servers and remove the scheduled tasks,
  ; and with the box ticked delete the data, while the program is still there to do it. Not on
  ; an update (1.x rolling back included): servers, tasks and data carry across.
  ${If} $UpdateMode <> 1
    StrCpy $R9 ""
    ${If} $DeleteAppDataCheckboxState = 1
      StrCpy $R9 "--data"
    ${EndIf}
    ; resources\bin off the user PATH: the folder is going away (user_path.rs)
    nsExec::ExecToLog '"$INSTDIR\resources\bin\spawnloft-core.exe" user-path remove'
    Pop $R8
    DetailPrint "Stopping servers and removing scheduled tasks"
    ; SPAWNLOFT: through the core binary, never the Node core directly (D10, P0-F H3)
    nsExec::ExecToLog '"$INSTDIR\resources\bin\spawnloft-core.exe" uninstall --yes $R9'
    Pop $R8
  ${EndIf}

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"
  ; SPAWNLOFT: core binaries and Node runtimes moved aside by updates, and other versions'
  ; runtime folders, once nothing runs them
  !insertmacro SPAWNLOFT_CLEAN_OLD_CORES
  !insertmacro SPAWNLOFT_CLEAN_OLD_RUNTIMES
  !insertmacro SPAWNLOFT_CLEAN_OTHER_RUNTIMES
  RMDir /r "$INSTDIR\resources\bin\staging"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; SPAWNLOFT: 1.x's install key goes with the program, as electron-builder's uninstaller does;
  ; on an update the next installer writes it again
  ${If} $UpdateMode <> 1
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
  ${Else}
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "SpawnLoftShell"
  ${EndIf}

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" "InstallLocation" ; SPAWNLOFT: 1.x value name
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

; SPAWNLOFT: remove SpawnLoft 1.x from $INSTDIR exactly as electron-builder's installer removes the
; previous version on an update (installUtil.nsh uninstallOldVersion): its uninstaller, copied out
; of the folder, run silently with --updated so its customUnInstall (stop servers, remove tasks,
; offer to delete data) does nothing, and --keep-shortcuts so the Start menu entry, the desktop
; shortcut and any taskbar pin stay (same path, same AppUserModelId). It removes the files and
; 1.x's registry keys; this installer then writes the same keys again.
;
; Its running-app check closes every process whose image is under $INSTDIR, which includes 1.x's
; Node daemons (SpawnLoft.exe as Node): by now `handover stop` has stopped every server they
; supervised (design 2.3), so only the panel, MCP servers and the bot host are closed.
Function RemoveLegacyInstall
  DetailPrint "Replacing SpawnLoft 1"
  InitPluginsDir
  StrCpy $INSTDIR $LegacyDir
  StrCpy $R5 0
  CopyFiles /SILENT "$INSTDIR\${LEGACYUNINSTALLER}" "$PLUGINSDIR\old-uninstaller.exe"
  legacy_retry:
    IntOp $R5 $R5 + 1
    ClearErrors
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=$INSTDIR' $R0
    ${If} ${Errors}
      ; a policy may forbid running from the temp folder: run it in place, as electron-builder does
      ClearErrors
      ExecWait '"$INSTDIR\${LEGACYUNINSTALLER}" /S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=$INSTDIR' $R0
      ${IfThen} ${Errors} ${|} StrCpy $R0 2 ${|}
    ${EndIf}
    ${If} $R0 <> 0
      ${If} $R5 < 5
        Sleep 1000
        Goto legacy_retry
      ${EndIf}
      Goto legacy_failed
    ${EndIf}
  ; exit code 0 is not proof: electron-builder's running-app check can Quit with 0 and leave
  ; everything in place. Electron's app.asar gone is the proof.
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    StrCpy $R0 "0, but SpawnLoft 1 is still there"
    Goto legacy_failed
  ${EndIf}
  ; run in place (_?=), it could not delete itself
  Delete "$INSTDIR\${LEGACYUNINSTALLER}"
  StrCpy $LegacyMode 2
  Return
  legacy_failed:
    DetailPrint "SpawnLoft 1 could not be removed (exit code $R0)"
    ; SPAWNLOFT: what the stop stopped runs again under the 1.x that is still there
    Call RestoreLegacyServers
    MessageBox MB_ICONSTOP "SpawnLoft 1 could not be removed, so SpawnLoft 2 was not installed. Close SpawnLoft and try again." /SD IDOK
    SetErrorLevel 2
    Quit
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function SkipIfPassiveOrLegacy
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
  ${IfThen} $LegacyMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
