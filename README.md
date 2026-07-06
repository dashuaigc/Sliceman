# Sliceman

Photoshop UXP 切图插件：把当前 PSD 按图层/组一键切成规范命名的 PNG，附带批量前缀重命名工具。

## 功能

- **零配置一键切图**：默认把当前文档每个叶子图层切成独立 PNG（紧贴像素裁切、带透明）。
- **颜色标记规则**：图层/组标**红色**→不切；组标**蓝色**→整组合并为一张（组内红色图层自动排除）。优先级 红 > 蓝 > 默认。
- **规范命名**：`[项目名_]PSD名_组名(逐层)_图层名`，`_` 分隔；中文取拼音首字母、全小写、去空格与符号；重名自动加 `_2/_3`，不覆盖磁盘旧文件。
- **项目名称**：可选、记住上次输入、也走拼音规范化。
- **两个开关**：包含隐藏图层（默认关）、完整切出超出画布部分（默认开）。
- **批量前缀重命名**：给选中图层/组批量加规范化后的前缀（原名不变、直接拼接），改前弹预览、可撤销。

## 开发环境

- Node ≥ 18、npm
- Photoshop 2021+（UXP manifest v5）
- [Adobe UXP Developer Tool (UDT)](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/) —— 用于开发期加载、调试、打包

## 命令

```bash
npm install        # 安装依赖
npm test           # 运行纯逻辑单测（normalize / naming / traversal / buildPreview）
npm run build      # 打包出可加载的插件目录 dist/plugin/
```

`npm run build` 会把 `src/ui/panel.js` 打包（内联 pinyin-pro 离线词典，`photoshop`/`uxp` 作为宿主注入保持 external），并把 `manifest.json`、`index.html`、`styles.css` 一起拷进扁平目录 `dist/plugin/`。

## 开发期加载（UDT）

1. `npm run build`
2. 打开 UXP Developer Tool → `Add Plugin` → 选 **`dist/plugin/manifest.json`**（注意是 dist 里的那个，不是 src）
3. `Load` → Photoshop 出现「Sliceman」面板
4. 改代码后重新 `npm run build`，UDT 里点 `Reload`

## 打包成 .ccx 并双击安装

1. `npm run build`
2. UDT 中选中插件 → `⋯` → `Package` → 生成 `Sliceman.ccx`
3. 关闭 UDT 里加载的开发版（避免冲突）
4. **双击 `Sliceman.ccx`** → Creative Cloud 的 Unified Plugin Installer 弹确认 → 安装
5. 重启 Photoshop → 插件菜单出现「Sliceman」

> 双击无反应时：确认已登录 Creative Cloud 桌面端，且 `UnifiedPluginInstallerAgent` 存在
> （通常在 `C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\...`）。

## 代码结构

| 路径 | 职责 | 是否单测 |
|---|---|---|
| `src/lib/normalize.js` | 单段规范化（拼音首字母 + slug） | ✅ |
| `src/lib/naming.js` | 文件名拼接 + 占位兜底 + 去重 | ✅ |
| `src/lib/traversal.js` | 图层树遍历，产出导出任务（红/蓝/默认规则） | ✅ |
| `src/ps/renamer.js` | `buildPreview`（✅ 单测）+ 选中读取/写回（PS，手动验证） | 部分 |
| `src/ps/layer-tree.js` | 读文档图层树为纯数据（含颜色标记、id） | 手动验证 |
| `src/ps/exporter.js` | 临时文档 + mergeVisible 隔离 + trim + 存 PNG | 手动验证 |
| `src/ui/` | 面板 HTML/CSS/JS | 手动验证 |

纯逻辑（`src/lib/*`、`renamer` 的 `buildPreview`）在 Node 下用 vitest 覆盖；`src/ps/*` 与 UI 依赖 Photoshop 运行时，需在 UDT 里对真实 PSD 手动验证。

## 手动验证清单（在 Photoshop 里）

- [ ] `layer-tree`：红色图层 `label==='red'`、蓝色组 `label==='blue'`、结构与图层面板一致（Task 5）
- [ ] `exporter`：普通层紧贴像素、超画布开关两态、蓝组合并排除红色、全透明跳过（Task 6）
  - [ ] 蓝组内嵌套**红色组**（不只是红色图层）也被排除
  - [ ] 单图层任务的 `mergeVisible`（仅一个可见层）不报错、正常输出
- [ ] 端到端切图：命名/去重/红蓝规则/隐藏开关全部符合（Task 7）
- [ ] 前缀重命名：预览 `原名→前缀+原名`、只改组名、同名标注、确认写回、Ctrl+Z 一步撤销（Task 9）
- [ ] `.ccx` 双击安装可用（Task 10）

设计与计划见 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`。
