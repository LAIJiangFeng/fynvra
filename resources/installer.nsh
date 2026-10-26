!ifndef BUILD_UNINSTALLER
  # 浏览目录时立即补上应用子目录；选择同名目录时由 NSIS 避免重复追加。
  # 实际初始路径和升级目录仍由安装模式及已有安装记录决定。
  InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"
!endif
