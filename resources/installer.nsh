!ifndef BUILD_UNINSTALLER
  # 浏览目录时立即补上应用子目录；选择同名目录时由 NSIS 避免重复追加。
  # 实际初始路径和升级目录仍由安装模式及已有安装记录决定。
  InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"
!endif

# 替换默认完成页：全新安装照常显示「运行」复选框；更新（--updated）时跳过完成页，
# 只留安装进度页，直接重新打开应用并退出安装器。
!macro customFinishPage
  Function fynvraStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function fynvraSkipFinishIfUpdated
    ${if} ${isUpdated}
      HideWindow
      ${if} ${isForceRun}
        Call fynvraStartApp
      ${endif}
      Abort
    ${endif}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "fynvraStartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE fynvraSkipFinishIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend
