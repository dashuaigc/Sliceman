# PS 切图插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Photoshop UXP 插件，能一键把当前 PSD 按图层/组（含红/蓝颜色标记规则）切成规范命名的 PNG，并附带一个批量给选中图层加前缀的重命名工具。

**Architecture:** 把「纯逻辑」（规范化 normalize / 命名 naming / 遍历 traversal）与「PS API 封装」（layer-tree / exporter / renamer / panel）彻底分开。纯逻辑不依赖 Photoshop，用 vitest 在 Node 下做 TDD；PS 封装层只做薄薄一层调用，在 Adobe UXP Developer Tool (UDT) 里手动加载真实 PSD 验证。最终用 UXP CLI 打包成 `.ccx` 双击安装。

**Tech Stack:** JavaScript (ES Modules)、UXP for Photoshop (PS 2021+)、`pinyin-pro`（离线拼音首字母）、`vitest`（单测）、`esbuild`（打包）、`@adobe/uxp`/UXP CLI（生成 `.ccx`）。

**Spec:** `docs/superpowers/specs/2026-07-06-ps-slice-plugin-design.md`

---

## 文件结构

纯逻辑（可单测，不碰 PS API）：
- `src/lib/normalize.js` — `normalize(segment)`：中文→拼音首字母、小写、仅留 `[a-z0-9]`
- `src/lib/naming.js` — `buildBaseName(segments)`、`makeUniqueName(base, usedSet)`：拼接、占位兜底、去重
- `src/lib/traversal.js` — `walk(tree, opts)`：按红/蓝/默认规则产出导出任务列表

PS API 封装（在 UDT 里手动验证）：
- `src/ps/layer-tree.js` — 读当前文档图层树 → 纯数据 tree（含 name/kind/label/visible/children）
- `src/ps/exporter.js` — 临时文档 + trim + 画布裁切开关 + 存 PNG + 磁盘去重
- `src/ps/renamer.js` — 读选中图层/组 → 预览列表 → 单次可撤销地写回名字

UI 与工程：
- `src/ui/index.html`、`src/ui/panel.js`、`src/ui/styles.css` — 面板
- `src/manifest.json` — UXP manifest
- `package.json`、`esbuild.config.mjs`、`vitest.config.js`
- `tests/normalize.test.js`、`tests/naming.test.js`、`tests/traversal.test.js`

数据结构约定：

```js
// 图层树节点（layer-tree 产出，traversal 消费）
// { name: string, kind: 'layer'|'group', label: 'red'|'blue'|null, visible: boolean, children: Node[] }

// 导出任务（traversal 产出，naming + exporter 消费）
// { type: 'layer'|'merged', node: Node, pathSegments: string[] }   // pathSegments 为原始未规范化名
```

---

## Task 0: 工程脚手架

**Files:**
- Create: `package.json`, `vitest.config.js`, `esbuild.config.mjs`, `.gitignore`

- [ ] **Step 1: 初始化 git 与 npm**

Run:
```bash
cd /d/Sliceman
git init
npm init -y
```
Expected: 生成 `.git/` 与 `package.json`。

- [ ] **Step 2: 安装依赖**

Run:
```bash
npm install pinyin-pro
npm install -D vitest esbuild
```
Expected: `node_modules/` 出现，`package.json` 有 dependencies/devDependencies。

- [ ] **Step 3: 写 `.gitignore`**

```
node_modules/
dist/
*.ccx
```

- [ ] **Step 4: 配置 `package.json` scripts 与 ESM**

在 `package.json` 中加入（保留 npm init 生成的其它字段）：
```json
{
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "node esbuild.config.mjs"
  }
}
```

- [ ] **Step 5: 写 `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
});
```

- [ ] **Step 6: 写 `esbuild.config.mjs`（占位，Task 4 后再接真实入口）**

```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/ui/panel.js'],
  bundle: true,
  format: 'cjs',            // UXP 面板脚本用 CommonJS 更稳
  outfile: 'dist/panel.js',
  platform: 'browser',
  target: ['chrome88'],     // UXP 内核约等于此
  external: ['photoshop', 'uxp'],   // 宿主注入，不打包
}).then(() => console.log('build ok'));
```

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "chore: scaffold uxp slice plugin project"
```

---

## Task 1: normalize 模块（纯逻辑，TDD）

规则（spec §3）：中文→拼音首字母、英文/数字保留、全小写、删除空格与所有非 `[a-z0-9]` 字符。多音字取词典默认读音。

**Files:**
- Create: `src/lib/normalize.js`
- Test: `tests/normalize.test.js`

- [ ] **Step 1: 写失败测试**

```js
// tests/normalize.test.js
import { describe, it, expect } from 'vitest';
import { normalize } from '../src/lib/normalize.js';

describe('normalize', () => {
  it('英文原样转小写', () => {
    expect(normalize('Home')).toBe('home');
  });
  it('数字保留', () => {
    expect(normalize('icon2')).toBe('icon2');
  });
  it('中文取拼音首字母', () => {
    expect(normalize('图标')).toBe('tb');
  });
  it('中英数字混合', () => {
    expect(normalize('Icon图标 2')).toBe('icontb2');
  });
  it('删除空格与符号', () => {
    expect(normalize('a b-c_d.e')).toBe('abcde');
  });
  it('全部非法字符 → 空串', () => {
    expect(normalize('！@#')).toBe('');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/normalize.test.js`
Expected: FAIL（`normalize` 未定义 / 模块不存在）。

- [ ] **Step 3: 实现**

```js
// src/lib/normalize.js
import { pinyin } from 'pinyin-pro';

/**
 * 把单段名称规范化：中文→拼音首字母，英文/数字保留，
 * 全部小写，删除空格与所有非 [a-z0-9] 字符。
 * @param {string} input
 * @returns {string}
 */
export function normalize(input) {
  if (!input) return '';
  // 逐字符处理：中文走 pinyin 首字母，其余保留原字符后统一过滤
  let out = '';
  for (const ch of input) {
    if (/[一-鿿]/.test(ch)) {
      // toneType:'none' + pattern:'first' → 单字首字母
      const first = pinyin(ch, { pattern: 'first', toneType: 'none' });
      out += first;
    } else {
      out += ch;
    }
  }
  return out.toLowerCase().replace(/[^a-z0-9]/g, '');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/normalize.test.js`
Expected: PASS（6 passed）。若某个中文首字母不符预期，检查 pinyin-pro 的 `pattern:'first'` 返回值并调整。

- [ ] **Step 5: 提交**

```bash
git add src/lib/normalize.js tests/normalize.test.js
git commit -m "feat: add normalize (pinyin-first-letter + slug)"
```

---

## Task 2: naming 模块（纯逻辑，TDD）

职责（spec §3）：把多段路径拼成文件名基名（每段先 normalize，空段用占位名），并在给定「已用名集合」下去重加 `_2/_3`。

**Files:**
- Create: `src/lib/naming.js`
- Test: `tests/naming.test.js`

- [ ] **Step 1: 写失败测试**

```js
// tests/naming.test.js
import { describe, it, expect } from 'vitest';
import { buildBaseName, makeUniqueName } from '../src/lib/naming.js';

describe('buildBaseName', () => {
  it('各段 normalize 后用下划线拼接', () => {
    expect(buildBaseName(['首页', '导航', '图标'])).toBe('sy_dh_tb');
  });
  it('空段用占位名 + 序号', () => {
    // 第二段为符号，normalize 后为空 → group2 占位（索引从1计）
    expect(buildBaseName(['home', '！@#', 'icon'])).toBe('home_seg2_icon');
  });
  it('过滤掉整体为空的输入返回占位', () => {
    expect(buildBaseName(['！'])).toBe('seg1');
  });
});

describe('makeUniqueName', () => {
  it('未冲突时原样返回并登记', () => {
    const used = new Set();
    expect(makeUniqueName('tb', used)).toBe('tb');
    expect(used.has('tb')).toBe(true);
  });
  it('冲突时追加 _2 _3', () => {
    const used = new Set(['tb']);
    expect(makeUniqueName('tb', used)).toBe('tb_2');
    expect(makeUniqueName('tb', used)).toBe('tb_3');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/naming.test.js`
Expected: FAIL（未定义）。

- [ ] **Step 3: 实现**

```js
// src/lib/naming.js
import { normalize } from './normalize.js';

/**
 * 把路径各段规范化后用 '_' 拼接；某段规范化为空时用 'seg{index}' 占位（index 从 1 起）。
 * @param {string[]} segments 原始名（含 项目名/psd名/组名/图层名，调用方按需组装）
 * @returns {string}
 */
export function buildBaseName(segments) {
  const parts = segments.map((seg, i) => {
    const n = normalize(seg);
    return n || `seg${i + 1}`;
  });
  return parts.join('_') || 'seg1';
}

/**
 * 在 usedSet 下生成唯一名：冲突则追加 _2、_3…，并把结果登记进 usedSet。
 * usedSet 可预先塞入目标文件夹已存在的文件名（不含扩展名）以避免覆盖磁盘旧文件。
 * @param {string} base
 * @param {Set<string>} usedSet
 * @returns {string}
 */
export function makeUniqueName(base, usedSet) {
  if (!usedSet.has(base)) {
    usedSet.add(base);
    return base;
  }
  let i = 2;
  while (usedSet.has(`${base}_${i}`)) i++;
  const unique = `${base}_${i}`;
  usedSet.add(unique);
  return unique;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/naming.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/naming.js tests/naming.test.js
git commit -m "feat: add naming (join + placeholder + dedup)"
```

---

## Task 3: traversal 模块（纯逻辑，TDD）

职责（spec §2）：DFS 图层树，按 **红 > 蓝 > 默认** 产出任务列表。红色跳过整棵子树；蓝色组整体合并（type:'merged'，不递归，pathSegments 到组名为止）；普通组作前缀递归；叶子图层按可见性与 includeHidden 决定是否导出。

**Files:**
- Create: `src/lib/traversal.js`
- Test: `tests/traversal.test.js`

- [ ] **Step 1: 写失败测试**

```js
// tests/traversal.test.js
import { describe, it, expect } from 'vitest';
import { walk } from '../src/lib/traversal.js';

const g = (name, label, children, visible = true) => ({ name, kind: 'group', label, visible, children });
const l = (name, label = null, visible = true) => ({ name, kind: 'layer', label, visible, children: [] });

describe('walk', () => {
  it('默认：每个可见叶子各一任务，组作前缀', () => {
    const tree = g('root', null, [ g('nav', null, [ l('home'), l('icon') ]) ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks).toEqual([
      { type: 'layer', node: expect.any(Object), pathSegments: ['nav', 'home'] },
      { type: 'layer', node: expect.any(Object), pathSegments: ['nav', 'icon'] },
    ]);
  });

  it('红色图层被跳过', () => {
    const tree = g('root', null, [ l('a'), l('b', 'red') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['a']);
  });

  it('红色组整棵子树被跳过', () => {
    const tree = g('root', null, [ g('skip', 'red', [ l('x'), l('y') ]), l('keep') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['keep']);
  });

  it('蓝色组产出单个 merged 任务，不递归', () => {
    const tree = g('root', null, [ g('card', 'blue', [ l('bg'), l('txt') ]) ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks).toEqual([
      { type: 'merged', node: expect.any(Object), pathSegments: ['card'] },
    ]);
  });

  it('隐藏叶子默认跳过，开开关后纳入', () => {
    const tree = g('root', null, [ l('vis'), l('hid', null, false) ]);
    expect(walk(tree, { includeHidden: false }).map(t => t.pathSegments.join('/'))).toEqual(['vis']);
    expect(walk(tree, { includeHidden: true }).map(t => t.pathSegments.join('/'))).toEqual(['vis', 'hid']);
  });

  it('隐藏组默认跳过其内容', () => {
    const tree = g('root', null, [ g('hidgrp', null, [ l('x') ], false) ]);
    expect(walk(tree, { includeHidden: false })).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/traversal.test.js`
Expected: FAIL（未定义）。

- [ ] **Step 3: 实现**

```js
// src/lib/traversal.js

/**
 * 遍历图层树产出导出任务。
 * @param {object} root 根节点（通常是 document 伪根，kind:'group'）
 * @param {{includeHidden:boolean}} opts
 * @returns {Array<{type:'layer'|'merged', node:object, pathSegments:string[]}>}
 */
export function walk(root, opts) {
  const tasks = [];
  const visit = (node, prefix) => {
    // 红色：跳过（含整棵子树）
    if (node.label === 'red') return;
    // 隐藏且不含隐藏：跳过
    if (!node.visible && !opts.includeHidden) return;

    if (node.kind === 'group') {
      // 蓝色组：整体合并，不递归
      if (node.label === 'blue') {
        tasks.push({ type: 'merged', node, pathSegments: [...prefix, node.name] });
        return;
      }
      // 普通组：作前缀递归
      for (const child of node.children) {
        visit(child, [...prefix, node.name]);
      }
      return;
    }
    // 叶子图层
    tasks.push({ type: 'layer', node, pathSegments: [...prefix, node.name] });
  };

  // 根节点自身不进 prefix（它是文档伪根）
  for (const child of root.children) visit(child, []);
  return tasks;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/traversal.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试 + 提交**

```bash
npm test
git add src/lib/traversal.js tests/traversal.test.js
git commit -m "feat: add layer traversal (red/blue/default rules)"
```

---

## Task 4: manifest + UI 面板骨架（UDT 手动验证）

目标：能在 Adobe UXP Developer Tool 里加载出一个带控件的面板（还没接功能）。

**Files:**
- Create: `src/manifest.json`, `src/ui/index.html`, `src/ui/panel.js`, `src/ui/styles.css`

- [ ] **Step 1: 写 `src/manifest.json`**

> 注意：`id` 需与 Adobe 开发者后台一致（打包上架才严格要求）；本地开发用占位即可。API 版本以当前 UXP 为准，如与 UDT 报错不符按提示调整。

```json
{
  "manifestVersion": 5,
  "id": "com.sliceman.plugin",
  "name": "Sliceman",
  "version": "0.0.1",
  "main": "index.html",
  "host": [{ "app": "PS", "minVersion": "22.0.0" }],
  "entrypoints": [
    {
      "type": "panel",
      "id": "sliceman.panel",
      "label": { "default": "Sliceman" },
      "minimumSize": { "width": 230, "height": 300 },
      "preferredDockedSize": { "width": 260, "height": 360 }
    }
  ],
  "requiredPermissions": {
    "localFileSystem": "request",
    "localStorage": true
  }
}
```

- [ ] **Step 2: 写 `src/ui/index.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <section class="block">
      <h3>切图</h3>
      <label>项目名称</label>
      <input id="projectName" type="text" placeholder="可留空" />
      <sp-checkbox id="includeHidden">包含隐藏图层</sp-checkbox>
      <sp-checkbox id="fullBleed" checked>完整切出超出画布部分</sp-checkbox>
      <button id="sliceBtn">开始切图</button>
    </section>
    <section class="block">
      <h3>批量前缀重命名</h3>
      <label>前缀</label>
      <input id="prefix" type="text" placeholder="如 图标" />
      <button id="renameBtn">应用前缀</button>
    </section>
    <p id="status" class="status"></p>
    <script src="panel.js"></script>
  </body>
</html>
```

- [ ] **Step 3: 写 `src/ui/styles.css`**

```css
body { font-family: sans-serif; padding: 8px; }
.block { margin-bottom: 12px; }
label { display: block; margin: 6px 0 2px; font-size: 12px; }
input { width: 100%; box-sizing: border-box; }
button { margin-top: 8px; width: 100%; }
.status { font-size: 12px; color: #4a90d9; min-height: 16px; }
```

- [ ] **Step 4: 写 `src/ui/panel.js`（先只做状态输出，验证脚本能跑）**

```js
const statusEl = document.getElementById('status');
function setStatus(msg) { statusEl.textContent = msg; }

document.getElementById('sliceBtn').addEventListener('click', () => setStatus('切图按钮 OK（待接功能）'));
document.getElementById('renameBtn').addEventListener('click', () => setStatus('重命名按钮 OK（待接功能）'));

setStatus('插件已加载');
```

- [ ] **Step 5: 在 UDT 手动加载验证**

手动步骤（无法脚本化）：
1. 安装并打开 **Adobe UXP Developer Tool**。
2. `Add Plugin` → 选 `src/manifest.json`。
3. `Load` → Photoshop 中出现「Sliceman」面板。
4. 面板显示两块控件与「插件已加载」，点两个按钮状态区有反馈。

Expected: 面板正常显示、按钮有反馈。若 manifest 版本/权限报错，按 UDT 提示修正 `manifestVersion` 或 `requiredPermissions`。

- [ ] **Step 6: 提交**

```bash
git add src/manifest.json src/ui/
git commit -m "feat: add panel manifest and UI skeleton"
```

---

## Task 5: layer-tree —— 读 PS 文档为纯数据树（UDT 手动验证）

职责：把 `app.activeDocument` 的图层树转成 traversal 能吃的纯数据结构，重点是**正确读出颜色标记**。

**Files:**
- Create: `src/ps/layer-tree.js`

- [ ] **Step 1: 实现读取器**

> 颜色标记的读取：UXP DOM 的 `layer.color` 在部分版本返回小写颜色串（如 `"red"`），但**不保证**。稳妥做法用 batchPlay 读图层的 `color` 属性，返回形如 `{_enum:"color", _value:"red"}`。下面实现优先用 DOM 属性、回退 batchPlay，并把结果归一化成 `'red'|'blue'|null`。实现后必须在 UDT 里对着真实 PSD 核对。

```js
// src/ps/layer-tree.js
const { app, action } = require('photoshop');

async function readLabelColor(layerId) {
  // batchPlay 读取图层 color 属性
  const [res] = await action.batchPlay([{
    _obj: 'get',
    _target: [
      { _property: 'color' },
      { _ref: 'layer', _id: layerId },
    ],
  }], {});
  const v = res?.color?._value;   // 例如 'red' / 'blue' / 'none'
  if (v === 'red' || v === 'blue') return v;
  return null;
}

async function nodeFromLayer(layer) {
  const isGroup = layer.kind === 'group' || layer.layers?.length >= 0 && layer.kind === 'group';
  const label = await readLabelColor(layer.id);
  const node = {
    name: layer.name,
    kind: isGroup ? 'group' : 'layer',
    label,
    visible: layer.visible,
    children: [],
  };
  if (isGroup && layer.layers) {
    for (const child of layer.layers) {
      node.children.push(await nodeFromLayer(child));
    }
  }
  return node;
}

/**
 * 读当前活动文档 → 纯数据伪根节点。
 * @returns {Promise<{name,kind,label,visible,children}>}
 */
export async function readDocumentTree() {
  const doc = app.activeDocument;
  if (!doc) throw new Error('没有打开的文档');
  const root = { name: doc.name, kind: 'group', label: null, visible: true, children: [] };
  for (const layer of doc.layers) {
    root.children.push(await nodeFromLayer(layer));
  }
  return root;
}
```

- [ ] **Step 2: 在 panel.js 临时接一个调试调用**

在 `sliceBtn` 里临时替换为：
```js
const { readDocumentTree } = require('../ps/layer-tree.js'); // 打包后为同目录
const tree = await readDocumentTree();
setStatus('顶层图层数: ' + tree.children.length);
console.log(JSON.stringify(tree, null, 2));
```
（注意：需要 esbuild 打包后 `require` 才解析；开发期也可先把 layer-tree 内容并入 panel 调试，Task 7 再拆干净。）

- [ ] **Step 3: UDT 手动验证颜色标记读取**

手动步骤：准备一个测试 PSD，给某图层标红、某组标蓝。Reload 插件，点「开始切图」，在 UDT 控制台看 console 输出的 tree：
- 标红图层 `label === 'red'`
- 标蓝组 `label === 'blue'`
- 其它 `label === null`
- 组的 `children` 结构与 PS 图层面板一致

Expected: 结构与颜色标记正确。若 `res.color._value` 字段名不同，用 UDT 控制台打印 `res` 调整取值路径。

- [ ] **Step 4: 提交**

```bash
git add src/ps/layer-tree.js src/ui/panel.js
git commit -m "feat: read PS document into plain layer tree with label colors"
```

---

## Task 6: exporter —— 临时文档 + trim + PNG（UDT 手动验证）

职责（spec §4）：给定一个任务（单图层或蓝组），复制到临时文档 → 按 fullBleed 开关决定是否先裁到画布 → trim 透明 → 存 PNG 到目标文件夹。完全透明则跳过。

**Files:**
- Create: `src/ps/exporter.js`

- [ ] **Step 1: 实现导出器骨架**

> UXP 的 batchPlay 存 PNG、trim、复制图层的具体描述符较长且随版本略有差异。下面给出结构与关键 batchPlay 步骤；实现时在 UDT 用 `Alchemist`/`ScriptListener` 思路核对描述符。核心流程稳定，descriptor 细节按控制台报错微调。

```js
// src/ps/exporter.js
const { app, action, core } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

/**
 * 导出单个任务到 PNG。
 * @param {object} task {type:'layer'|'merged', node, pathSegments}
 * @param {object} ps   {docId, fileName}  当前文档信息
 * @param {object} folder UXP folder entry（用户选的目标文件夹）
 * @param {string} fileName 已去重的最终文件名（不含扩展名）
 * @param {{fullBleed:boolean, includeHidden:boolean}} opts
 * @returns {Promise<'ok'|'empty'>}
 */
export async function exportTask(task, ps, folder, fileName, opts) {
  return core.executeAsModal(async () => {
    // 1) 复制目标图层/组到新文档（duplicate to new document）
    //    对 merged：整组复制并合并；对 layer：单层复制。
    //    —— 用 batchPlay 'duplicate' 到 new document，或 DOM: layer.duplicate(targetDoc)
    const tempDoc = await duplicateToTempDoc(task, opts);   // 见下方 helper

    // 2) fullBleed 关：先把画布裁到原文档画布范围（撤掉画布外像素）
    if (!opts.fullBleed) {
      await clipToOriginalCanvasBounds(tempDoc, ps);
    }

    // 3) trim 透明边界
    await action.batchPlay([{
      _obj: 'trim', trimBasedOn: { _enum: 'trimBasedOn', _value: 'transparency' },
      top: true, bottom: true, left: true, right: true,
    }], {});

    // 4) 空图层判断：trim 后宽或高为 0 → 跳过
    if (tempDoc.width === 0 || tempDoc.height === 0) {
      await tempDoc.closeWithoutSaving();
      return 'empty';
    }

    // 5) 存 PNG
    const file = await folder.createFile(`${fileName}.png`, { overwrite: true });
    const token = await uxpFs.createSessionToken(file);
    await action.batchPlay([{
      _obj: 'save',
      as: { _obj: 'PNGFormat', method: { _enum: 'PNGMethod', _value: 'quick' } },
      in: { _path: token, _kind: 'local' },
      copy: true,
    }], {});

    await tempDoc.closeWithoutSaving();
    return 'ok';
  }, { commandName: `导出 ${fileName}` });
}
```

> `duplicateToTempDoc` 与 `clipToOriginalCanvasBounds` 作为文件内 helper 实现：
> - `duplicateToTempDoc(layer/merged)`：DOM `layer.duplicate(newDoc)` 或 batchPlay `duplicate`；merged 复制整组后 `mergeGroup`。合并/复制时按 `includeHidden` 决定是否临时开启隐藏子层可见性，并剔除组内红色子层（合并前删除或隐藏 label==='red' 的子层）。
> - `clipToOriginalCanvasBounds`：把临时文档画布设为原文档画布尺寸并对齐原点后 `cropToCanvas`（去掉画布外像素）。

- [ ] **Step 2: UDT 手动验证四种情形**

准备测试 PSD，逐一验证：
1. 普通图层 → 导出紧贴像素的 PNG。
2. 图层内容超出画布：fullBleed 勾选 → 含画布外；取消 → 裁到画布。
3. 蓝组 → 合并成一张，且组内红色子层未出现在结果里。
4. 全透明图层 → 返回 `'empty'`，不产文件。

Expected: 四种情形结果符合 spec §2/§4。descriptor 报错时用控制台逐步定位（先跑 duplicate、再 trim、再 save）。

- [ ] **Step 3: 提交**

```bash
git add src/ps/exporter.js
git commit -m "feat: export task to trimmed PNG with canvas-clip toggle"
```

---

## Task 7: 接通切图主流程（panel.js）

把 layer-tree → traversal → naming → exporter 串起来，接上文件夹选择、状态、项目名持久化。

**Files:**
- Modify: `src/ui/panel.js`

- [ ] **Step 1: 实现切图流程**

```js
// 顶部 require
const { readDocumentTree } = require('../ps/layer-tree.js');
const { walk } = require('../lib/traversal.js');
const { buildBaseName, makeUniqueName } = require('../lib/naming.js');
const { exportTask } = require('../ps/exporter.js');
const uxpFs = require('uxp').storage.localFileSystem;
const { app } = require('photoshop');

// 项目名持久化
const projectInput = document.getElementById('projectName');
projectInput.value = localStorage.getItem('projectName') || '';
projectInput.addEventListener('change', () => localStorage.setItem('projectName', projectInput.value));

async function runSlice() {
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  const folder = await uxpFs.getFolder();          // 弹文件夹选择
  if (!folder) return setStatus('已取消');

  const includeHidden = document.getElementById('includeHidden').checked;
  const fullBleed = document.getElementById('fullBleed').checked;
  const project = projectInput.value;
  const psdName = app.activeDocument.name.replace(/\.[^.]+$/, '');

  const tree = await readDocumentTree();
  const tasks = walk(tree, { includeHidden });

  // 预塞目标文件夹已有 png 名，避免覆盖磁盘旧文件
  const used = new Set();
  for (const e of await folder.getEntries()) {
    if (e.isFile && e.name.toLowerCase().endsWith('.png')) used.add(e.name.replace(/\.png$/i, ''));
  }

  let ok = 0, empty = 0, deduped = 0;
  const ps = { docId: app.activeDocument.id, fileName: psdName };
  for (const task of tasks) {
    const segments = [project, psdName, ...task.pathSegments].filter(s => s !== '' && s != null);
    const base = buildBaseName(segments);
    const unique = makeUniqueName(base, used);
    if (unique !== base) deduped++;          // spec §6：统计去重次数
    const r = await exportTask(task, ps, folder, unique, { fullBleed, includeHidden });
    if (r === 'ok') ok++; else empty++;
    setStatus(`导出中… ${ok} 张`);
  }
  setStatus(`完成：已导出 ${ok} 张，去重 ${deduped} 次，跳过空图层 ${empty} 张`);
}

document.getElementById('sliceBtn').addEventListener('click', () =>
  runSlice().catch(e => setStatus('出错：' + e.message)));
```

> 注意 `project` 为空时被 `filter` 剔除，正好实现「不填项目名则不加前缀」；`buildBaseName` 内部再对每段 normalize，所以项目名也会走拼音规范化。

- [ ] **Step 2: 打包并在 UDT 端到端验证**

Run: `npm run build`
然后 UDT Reload。手动步骤：用一个含多级嵌套 + 红/蓝 + 中英文命名的测试 PSD，点「开始切图」，选文件夹。

Expected（对照 spec §2/§3）：
- 文件名形如 `项目_psd名_组_图层`，中文转拼音首字母、全小写；不填项目名则无前缀。
- 红色不出图、蓝组合成一张、隐藏层随开关、超画布随开关。
- 重名自动 `_2`；不覆盖文件夹里已有同名 png。

- [ ] **Step 3: 提交**

```bash
git add src/ui/panel.js
git commit -m "feat: wire end-to-end slicing flow"
```

---

## Task 8: renamer —— 选中图层批量加前缀（预览部分可单测）

职责（spec §5）：读选中图层/组 → 只规范化**前缀**、原名不变、直接拼接 → 生成 原名/新名 预览 → 确认后在一次可撤销步骤内写回。

**Files:**
- Create: `src/ps/renamer.js`
- Test: `tests/renamer.test.js`（只测纯函数 buildPreview）

- [ ] **Step 1: 写失败测试（纯函数）**

```js
// tests/renamer.test.js
import { describe, it, expect } from 'vitest';
import { buildPreview } from '../src/ps/renamer.js';

describe('buildPreview', () => {
  it('只规范化前缀，原名保持不变，直接拼接', () => {
    const rows = buildPreview(['home', '按钮', 'Group 1'], '图标');
    expect(rows).toEqual([
      { from: 'home', to: 'tbhome', dup: false },
      { from: '按钮', to: 'tb按钮', dup: false },
      { from: 'Group 1', to: 'tbGroup 1', dup: false },
    ]);
  });
  it('新名相同的行标注 dup=true（spec §5 同名提示）', () => {
    const rows = buildPreview(['图', '图'], 'a');   // 两行都变 a图
    expect(rows.every(r => r.dup)).toBe(true);
  });
  it('前缀规范化后为空 → 返回 null（调用方中止）', () => {
    expect(buildPreview(['a'], '！@#')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/renamer.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现（纯函数 + PS 封装）**

```js
// src/ps/renamer.js
import { normalize } from '../lib/normalize.js';

/**
 * 生成重命名预览。只规范化前缀，原名原样拼在其后。
 * @param {string[]} names 选中图层/组的原始名
 * @param {string} rawPrefix 前缀输入
 * @returns {Array<{from:string,to:string}> | null}  前缀规范化为空时返回 null
 */
export function buildPreview(names, rawPrefix) {
  const p = normalize(rawPrefix);
  if (!p) return null;
  const rows = names.map(n => ({ from: n, to: p + n, dup: false }));
  // 标注新名冲突（spec §5：预览中标注同名提示）
  const counts = {};
  for (const r of rows) counts[r.to] = (counts[r.to] || 0) + 1;
  for (const r of rows) r.dup = counts[r.to] > 1;
  return rows;
}
```

PS 封装部分（同文件追加，不参与单测）：

```js
// --- PS 封装（在 UDT 手动验证） ---
export async function getSelectedLayers() {
  const { app } = require('photoshop');
  const doc = app.activeDocument;
  return doc ? doc.activeLayers : [];   // 选中的图层/组
}

export async function applyRename(layers, rawPrefix) {
  const { core } = require('photoshop');
  const p = normalize(rawPrefix);
  if (!p) return 0;
  await core.executeAsModal(async () => {
    for (const layer of layers) layer.name = p + layer.name;   // 只改名字
  }, { commandName: '批量加前缀' });   // executeAsModal 内即一次可撤销历史步骤
  return layers.length;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/renamer.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ps/renamer.js tests/renamer.test.js
git commit -m "feat: add prefix renamer (normalize prefix, keep original name)"
```

---

## Task 9: 接通重命名流程 + 预览弹窗（panel.js）

**Files:**
- Modify: `src/ui/panel.js`, `src/ui/index.html`

- [ ] **Step 1: index.html 加预览 dialog**

```html
<dialog id="previewDialog">
  <h3>重命名预览</h3>
  <div id="previewList" style="max-height:200px;overflow:auto;font-size:12px;"></div>
  <div style="margin-top:8px;text-align:right;">
    <button id="previewCancel">取消</button>
    <button id="previewConfirm">确认</button>
  </div>
</dialog>
```

- [ ] **Step 2: panel.js 接重命名**

```js
const { buildPreview, getSelectedLayers, applyRename } = require('../ps/renamer.js');

async function runRename() {
  const layers = await getSelectedLayers();
  if (!layers.length) return setStatus('请先在图层面板选中图层或组');
  const rawPrefix = document.getElementById('prefix').value;
  const rows = buildPreview(layers.map(l => l.name), rawPrefix);
  if (!rows) return setStatus('前缀无效（规范化后为空）');

  const listEl = document.getElementById('previewList');
  listEl.innerHTML = rows.map(r => `<div>${r.from} &nbsp;→&nbsp; <b>${r.to}</b>${r.dup ? ' <span style="color:#d9534f">⚠同名</span>' : ''}</div>`).join('');
  const dlg = document.getElementById('previewDialog');
  const result = await dlg.uxpShowModal ? dlg.uxpShowModal() : dlg.showModal();

  // 确认/取消由按钮控制
  document.getElementById('previewConfirm').onclick = async () => {
    dlg.close();
    const n = await applyRename(layers, rawPrefix);
    setStatus(`已重命名 ${n} 个图层`);
  };
  document.getElementById('previewCancel').onclick = () => { dlg.close(); setStatus('已取消'); };
}

document.getElementById('renameBtn').addEventListener('click', () =>
  runRename().catch(e => setStatus('出错：' + e.message)));
```

> UXP 的 dialog 交互 API（`uxpShowModal` vs `showModal`）按版本调整；核心是「先预览、确认才写」。

- [ ] **Step 3: 打包 + UDT 手动验证**

Run: `npm run build`，UDT Reload。手动：图层面板多选几个图层（含一个组）→ 填前缀「图标」→ 点应用前缀。

Expected：弹出预览 `原名 → tb原名`；组只改组名本身；确认后图层面板名字更新；Ctrl+Z 一步撤销全部；取消不改动；未选/空前缀有提示。

- [ ] **Step 4: 提交**

```bash
git add src/ui/panel.js src/ui/index.html
git commit -m "feat: wire prefix-rename flow with preview dialog"
```

---

## Task 10: 打包成 .ccx 并验证双击安装

**Files:**
- Modify: `package.json`（加 package 脚本）

- [ ] **Step 1: 确认打包产物结构**

`.ccx` 本质是把「插件运行所需文件」（`manifest.json` + `index.html` + 打包后的 `panel.js` + `styles.css`）打成包。建立一个 `dist/plugin/` 目录，`npm run build` 时把这些文件汇总进去。

更新 `esbuild.config.mjs` 末尾，把 html/css/manifest 拷进 `dist/plugin/` 并把 bundle 输出到该目录（用 node fs 拷贝）。

- [ ] **Step 2: 用 UDT 生成 .ccx**

手动步骤（UDT 提供打包）：
1. UDT 中选中插件 → `⋯` → `Package`。
2. UDT 生成 `.ccx`（内部已按 manifest 校验）。

Expected: 得到 `sliceman.ccx`。

- [ ] **Step 3: 验证双击安装**

手动步骤：
1. 关闭 UDT 里加载的开发版插件（避免冲突）。
2. 双击 `sliceman.ccx` → Creative Cloud 的 UnifiedPluginInstallerAgent 弹安装确认 → 安装。
3. 重启 Photoshop → 插件菜单出现「Sliceman」→ 面板可用。

Expected: 双击即装、面板功能与开发期一致。若双击无反应，确认 CC 桌面端已登录且 UPIA 存在（已确认在 `C:\Program Files\Common Files\Adobe\...\UPI`）。

- [ ] **Step 4: 全量测试 + 最终提交**

```bash
npm test
git add -A
git commit -m "build: package plugin as ccx and verify double-click install"
```

---

## 交付验收清单（对照 spec）

- [ ] 双击 `.ccx` 可安装（Task 10）
- [ ] 零配置一键把所有图层切成独立 PNG（Task 3/6/7）
- [ ] 红色图层/组不切（Task 3）
- [ ] 蓝色组合并导出、排除内部红色（Task 3/6）
- [ ] 命名 = 项目名_PSD名_组名(逐层)_图层名，`_` 分隔（Task 2/7）
- [ ] 中文→拼音首字母、全小写、去空格符号（Task 1）
- [ ] 重名自动加数字后缀、不覆盖磁盘旧文件（Task 2/7）
- [ ] 项目名可选、记住上次输入、也做规范化（Task 7）
- [ ] 超出画布可选完整切出（默认开）（Task 6/7）
- [ ] 隐藏图层可选开关（默认关）（Task 3/6/7）
- [ ] 批量前缀重命名 + 预览 + 只改组名 + 前缀规范化 + 可撤销（Task 8/9）
