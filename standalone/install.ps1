# Windows PowerShell 5.1. Only manages com.sliceman.plugin.local.
[CmdletBinding()]
param([switch]$Uninstall, [string]$SandboxRoot)
$ErrorActionPreference = 'Stop'
$pluginId = 'com.sliceman.plugin.local'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

function Assert-NoRedirect([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw ('[Sliceman]' + "为避免操作错误位置，不能使用目录联接或符号链接：$cursor")
            }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Assert-Child([string]$Path, [string]$Parent) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('[Sliceman]' + "文件路径超出允许的安装目录：$full")
    }
    Assert-NoRedirect $full
}
function Check-Photoshop {
    if (-not $SandboxRoot -and (Get-Process -Name Photoshop -ErrorAction SilentlyContinue)) {
        throw ('[Sliceman]' + '检测到 Photoshop 正在运行或重新启动。请保存工作并退出 Photoshop，再运行一键安装程序。')
    }
}

$mutex = $null
$locked = $false
try {
    if ($SandboxRoot) {
        $sandbox = [IO.Path]::GetFullPath($SandboxRoot).TrimEnd('\')
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if ((Split-Path -Parent $sandbox) -ne $temp -or (Split-Path -Leaf $sandbox) -notlike 'sliceman-standalone-test-*') {
            throw ('[Sliceman]' + '测试目录不合法：必须是临时目录下以 sliceman-standalone-test- 开头的文件夹。')
        }
        Assert-NoRedirect $sandbox
        $dataRoot = Join-Path $sandbox 'data'
    } else {
        $dataRoot = [Environment]::GetFolderPath('ApplicationData')
        if (-not $dataRoot) { throw ('[Sliceman]' + '无法找到当前用户的应用数据目录。') }
    }
    Check-Photoshop
    $mutex = New-Object Threading.Mutex($false, 'Local\SlicemanLocalInstaller')
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw ('[Sliceman]' + '另一个 Sliceman 安装或卸载程序正在执行，请等待其完成。') }

    $uxp = Join-Path $dataRoot 'Adobe\UXP'
    $external = Join-Path $uxp 'Plugins\External'
    $infoPath = Join-Path $uxp 'PluginsInfo\v1\PS.json'
    $backupRoot = Join-Path $uxp 'SlicemanLocalBackups'
    foreach ($path in @($external, $infoPath, $backupRoot)) { Assert-Child $path $dataRoot }
    $hadInfo = Test-Path -LiteralPath $infoPath
    $originalText = $null
    if ($hadInfo) {
        $originalText = [IO.File]::ReadAllText($infoPath)
        $info = $originalText | ConvertFrom-Json
        if ($null -eq $info -or $info -is [Array] -or $info.plugins -isnot [Array]) {
            throw ('[Sliceman]' + '无法识别 PS.json 的格式，已停止操作以保留其他插件信息。')
        }
    } else {
        $info = [pscustomobject]@{ plugins = @() }
    }
    # Validate before creating any directories or moving existing installations.
    $payload = Join-Path $PSScriptRoot 'plugin'
    if (-not $Uninstall) {
        Assert-NoRedirect $payload
        foreach ($file in @('manifest.json', 'index.html', 'panel.js', 'styles.css')) {
            if (-not (Test-Path -LiteralPath (Join-Path $payload $file) -PathType Leaf)) {
                throw ('[Sliceman]' + "安装包不完整：缺少 plugin/$file。请先完整解压安装包，再运行其中的一键安装程序。")
            }
        }
        Get-ChildItem -LiteralPath $payload -Recurse -Force | ForEach-Object { Assert-NoRedirect $_.FullName }
        $manifest = Get-Content -LiteralPath (Join-Path $payload 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.id -cne $pluginId) { throw ('[Sliceman]' + '插件身份不匹配，已停止操作；原 Creative Cloud 版未被修改。') }
        if ($manifest.version -notmatch '^\d+\.\d+\.\d+$' -or $manifest.main -ne 'index.html' -or -not $manifest.host.minVersion) {
            throw ('[Sliceman]' + '插件配置文件无效，请重新获取完整安装包。')
        }
        $folder = $pluginId + '_' + $manifest.version
        $target = Join-Path $external $folder
        Assert-Child $target $external
    }
    $oldDirs = @()
    if (Test-Path -LiteralPath $external) {
        $oldDirs = @(Get-ChildItem -LiteralPath $external -Force | Where-Object { $_.Name.StartsWith($pluginId + '_', [StringComparison]::Ordinal) })
        foreach ($dir in $oldDirs) {
            Assert-Child $dir.FullName $external
            if (-not $dir.PSIsContainer) { throw ('[Sliceman]' + "插件目录被同名文件占用：$($dir.FullName)") }
            # Moving a directory must not move nested redirections.
            Get-ChildItem -LiteralPath $dir.FullName -Recurse -Force | ForEach-Object { Assert-NoRedirect $_.FullName }
        }
    }
    $remaining = @($info.plugins | Where-Object { $_.pluginId -cne $pluginId })
    if ($Uninstall -and $oldDirs.Count -eq 0 -and $remaining.Count -eq $info.plugins.Count) {
        Write-Host '未发现已安装的独立版，无需重复卸载。'
        exit 0
    }
    $info.plugins = $remaining
    if (-not $Uninstall) {
        $info.plugins = @($remaining) + @([pscustomobject]@{
            hostMinVersion = $manifest.host.minVersion
            name = $manifest.name
            path = '$localPlugins\External\' + $folder
            pluginId = $pluginId
            status = 'enabled'
            type = 'uxp'
            versionString = $manifest.version
        })
    }
    $newJson = ConvertTo-Json -InputObject $info -Depth 100
    $backup = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    if ($hadInfo) { Copy-Item -LiteralPath $infoPath -Destination (Join-Path $backup 'PS.json.before') }
    $stage = Join-Path $backup 'staged-plugin'
    if (-not $Uninstall) { Copy-Item -LiteralPath $payload -Destination $stage -Recurse }
    New-Item -ItemType Directory -Path $external -Force | Out-Null
    $infoDir = Split-Path -Parent $infoPath
    New-Item -ItemType Directory -Path $infoDir -Force | Out-Null
    $pending = Join-Path $infoDir ('PS.json.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($pending, $newJson, $utf8)
    $moved = @()
    $placed = $false
    try {
        Check-Photoshop
        foreach ($dir in $oldDirs) {
            Assert-Child $dir.FullName $external
            $saved = Join-Path $backup $dir.Name
            Move-Item -LiteralPath $dir.FullName -Destination $saved
            $moved += [pscustomobject]@{ From = $saved; To = $dir.FullName }
        }
        if (-not $Uninstall) {
            Assert-Child $stage $backup
            Assert-Child $target $external
            Move-Item -LiteralPath $stage -Destination $target
            $placed = $true
        }
        # Refuse to overwrite concurrent changes from another installer/host.
        Check-Photoshop
        if ($hadInfo) {
            if (-not (Test-Path -LiteralPath $infoPath) -or [IO.File]::ReadAllText($infoPath) -cne $originalText) {
                throw ('[Sliceman]' + '操作期间插件信息被其他程序修改。已停止写入，请退出 Adobe 相关工具后重试。')
            }
            # PowerShell 5.1 coerces $null to an empty string for this overload.
            [IO.File]::Replace($pending, $infoPath, (Join-Path $backup 'PS.json.replaced'))
        } else {
            [IO.File]::Move($pending, $infoPath)
        }
    } catch {
        if ($placed) {
            Assert-Child $target $external
            Move-Item -LiteralPath $target -Destination (Join-Path $backup 'failed-plugin')
        }
        foreach ($move in $moved) {
            Assert-Child $move.From $backup
            Assert-Child $move.To $external
            Move-Item -LiteralPath $move.From -Destination $move.To
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $pending) {
            Assert-Child $pending $infoDir
            Remove-Item -LiteralPath $pending -Force
        }
    }
    Write-Host "备份位置：$backup"
    if ($Uninstall) { Write-Host '卸载完成。原 Creative Cloud 版及其他插件已保留。' }
    else { Write-Host '安装完成。请启动 Photoshop，在“增效工具”菜单中打开 Sliceman。' }
    exit 0
} catch {
    $failure = $_
    $message = $failure.Exception.Message
    # Keep framework/PowerShell diagnostics in a log instead of showing English errors.
    if ($message.StartsWith('[Sliceman]', [StringComparison]::Ordinal)) {
        $message = $message.Substring(10)
    } else {
        $message = '无法读取或写入插件文件。请检查安装包是否完整、磁盘空间、文件权限及占用情况。'
    }
    Write-Host ('操作失败：' + $message) -ForegroundColor Red
    try {
        $logPath = Join-Path ([IO.Path]::GetTempPath()) ('Sliceman-' + [Guid]::NewGuid().ToString('N') + '.log')
        [IO.File]::WriteAllText($logPath, ($failure | Out-String), $utf8)
        Write-Host "诊断日志：$logPath"
    } catch { Write-Host '无法保存诊断日志，请保留当前提示。' }
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
