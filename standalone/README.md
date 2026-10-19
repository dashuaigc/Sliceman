# Sliceman 独立 UXP 本地版

与 Creative Cloud 版功能源码相同，单独的插件 ID 为 `com.sliceman.plugin.local`，面板名为 **Sliceman**。原版 `com.sliceman.plugin` 可继续共存，两者的插件设置数据各自独立。

## 安装

1. 完整解压 `Sliceman_Setup_v*.zip`，不要在压缩包里直接运行。
2. 双击带蓝色 S 图标的 **一键安装.exe**。
3. Photoshop 已打开时，窗口会提示“等待 Photoshop 退出”。保存工作并正常退出 PS，安装器确认进程完全结束后会自动安装。等待期间可点“取消”，不会修改插件文件。
4. 出现“安装完成”后，重新打开 Photoshop，在 **增效工具** 菜单中打开 **Sliceman**。

PS 没有打开时会自动开始安装。请保持安装窗口打开；安装事务开始后请等待完成，期间不要重新启动 PS。这里是“运行中预约、退出后安装”，不是运行中即时加载插件。

接收安装包的电脑不需要 Node.js、npm、UXP Developer Tool，也不调用 Creative Cloud。需要 Windows PowerShell 5.1、.NET Framework 4.5 或以上，以及符合插件 manifest 要求的 Photoshop（当前最低 23.3.0）。无需管理员权限，安装仅作用于当前 Windows 用户。受管理电脑的系统策略可能阻止运行脚本。

这是基于本项目已有本地安装机制制作的独立发行包，通过 UXP 插件目录和 `PS.json` 登记加载，不是 CEP，不需要 PlayerDebugMode，也不是 Adobe 官方 CCX 安装流程。不同 Photoshop 版本的兼容性需实机确认；文件安装成功不等于宿主已确认加载成功。

## 更新与卸载

更新：解压新版**本地版 ZIP**，再次双击一键安装。重复安装和升级只替换本地版。

卸载：双击带橙红色减号图标的 **卸载.exe**，在页面点击“确认卸载”即可，不需要输入数字。仅打开页面不会开始卸载。PS 仍在运行时同样等待退出，可取消。原 Creative Cloud 版和其他插件保留；本地版用户设置也保留，便于重装。

所有安装器提示使用中文；底层技术错误会写入临时目录日志，界面提供日志位置。Windows 系统自身的安全或权限提示由操作系统控制。

面板中的原有“检查更新”功能仍连接原项目发布页，下载的 `.ccx` 属于 Creative Cloud 版，**不会升级本地版**。本地版请使用本地版 ZIP 更新。

## 文件与恢复

- 本地版文件：`%APPDATA%\Adobe\UXP\Plugins\External\com.sliceman.plugin.local_<版本>`。
- 插件信息：`%APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json`。仅变更本地版 ID 对应条目，保留其他插件与其他字段。
- 每次变更前备份：`%APPDATA%\Adobe\UXP\SlicemanLocalBackups\<时间-唯一编号>`。包含变更前的 `PS.json.before`（原文件存在时）和旧本地版文件（存在时）。备份不会自动删除。
- 安装失败时，程序会尽力恢复已移动的本地版文件；错误信息保留在窗口中。`PS.json` 采用临时文件加原子替换写入。若安装后有其他插件变更，不要直接拿旧 `PS.json.before` 覆盖当前文件，以免撤销其他插件的变更。
- 脚本拒绝不认识的插件信息格式和目录重定向；遇到报错请保留窗口信息及备份目录。

## 从源码构建（开发者）

仓库已安装开发依赖时，在项目根目录运行：

```powershell
node standalone/build.mjs
node --test standalone/tests/*.test.mjs
```

构建只写 `standalone/release/`。直接读取原源码，并在本地版构建过程中替换 manifest 身份，不修改 `src/`、原构建脚本、`dist/` 或原 `.ccx`。两个 EXE 由 Windows 自带 .NET Framework 编译器构建，图标嵌入 EXE，无需额外图标文件。

`install.ps1` 是 EXE 调用的内部脚本，不提供图形等待流程；直接执行时 PS 必须已退出。卸载确认由 EXE 页面提供，直接以 `-Uninstall` 执行脚本会立即卸载。请优先使用完整发行目录中的 EXE，不要单独移动入口文件。

自动化安装测试使用 `%TEMP%\sliceman-standalone-test-*\data`，不会操作真实用户插件目录。`-SandboxRoot` 仅用于这些测试。
