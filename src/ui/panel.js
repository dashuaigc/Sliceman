// 面板入口：把纯逻辑（traversal/naming）与 PS 封装（layer-tree/exporter/renamer）接到 UI。
// 由 esbuild 打包（本地模块内联，photoshop/uxp 作为宿主注入保持 external）。
import { walk } from '../lib/traversal.js';
import { buildBaseName, makeUniqueName } from '../lib/naming.js';
import { normalize } from '../lib/normalize.js';
import { readDocumentTree } from '../ps/layer-tree.js';
import { exportTask } from '../ps/exporter.js';
import { buildPreview, applyRename } from '../ps/renamer.js';

const { app, action } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

const statusEl = document.getElementById('status');
function setStatus(msg) { statusEl.textContent = msg; }

// 让出事件循环一拍：使切图循环中排队的点击/按键（停止、ESC）得以处理
function tick() { return new Promise((r) => setTimeout(r, 0)); }

// 当前文档中选中的图层/组（同步读取）
function selectedLayers() {
  const doc = app.activeDocument;
  return doc ? doc.activeLayers : [];
}

// ---- 项目名称持久化（记住上次输入），localStorage 不可用时降级为不持久化 ----
const projectInput = document.getElementById('projectName');
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略：不支持持久化 */ } }
projectInput.value = safeGet('projectName') || '';
projectInput.addEventListener('change', () => safeSet('projectName', projectInput.value));

// ---- 切图状态与停止控制 ----
const sliceBtn = document.getElementById('sliceBtn');
const stopBtn = document.getElementById('stopBtn');
const stopConfirm = document.getElementById('stopConfirm');
let slicing = false;
let cancelRequested = false;

function setSlicing(on) {
  slicing = on;
  sliceBtn.disabled = on;
  stopBtn.disabled = !on;
  if (!on) stopConfirm.style.display = 'none';   // 结束时收起 ESC 确认块
}

function requestStop(reason) {
  if (!slicing) return;
  cancelRequested = true;
  setStatus(reason || '正在停止…（当前这张完成后中断）');
}

// ---- 切图主流程 ----
async function runSlice() {
  if (slicing) return;                                 // 防重复触发
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  const folder = await uxpFs.getFolder();              // 弹文件夹选择
  if (!folder) return setStatus('已取消');

  const includeHidden = document.getElementById('includeHidden').checked;
  const fullBleed = document.getElementById('fullBleed').checked;
  // 项目名规范化后为空（如纯符号）视为未填，避免污染出 seg1_ 前缀
  const project = normalize(projectInput.value) ? projectInput.value : '';
  const psdName = app.activeDocument.name.replace(/\.[^.]+$/, '');

  const tree = await readDocumentTree();
  const tasks = walk(tree, { includeHidden });

  // 预塞目标文件夹已有 png 名，避免覆盖磁盘旧文件
  const used = new Set();
  for (const e of await folder.getEntries()) {
    if (e.isFile && e.name.toLowerCase().endsWith('.png')) used.add(e.name.replace(/\.png$/i, '').toLowerCase());
  }

  cancelRequested = false;
  setSlicing(true);
  let ok = 0, empty = 0, deduped = 0;
  const ps = { docId: app.activeDocument.id, fileName: psdName };
  try {
    for (const task of tasks) {
      await tick();                                    // 让排队的停止/ESC 事件先执行
      if (cancelRequested) {
        setStatus(`已停止：导出 ${ok} 张后中断（剩余 ${tasks.length - ok - empty} 个未处理）`);
        return;
      }
      const segments = [project, psdName, ...task.pathSegments].filter(s => s !== '' && s != null);
      const base = buildBaseName(segments);
      const unique = makeUniqueName(base, used);
      if (unique !== base) deduped++;                  // 统计去重次数
      const r = await exportTask(task, ps, folder, unique, { fullBleed, includeHidden });
      if (r === 'ok') ok++; else empty++;
      setStatus(`导出中… ${ok} 张`);
    }
    setStatus(`完成：已导出 ${ok} 张，去重 ${deduped} 次，跳过空图层 ${empty} 张`);
  } finally {
    setSlicing(false);
  }
}

// ---- 批量前缀重命名：输入即预览 ----
const prefixInput = document.getElementById('prefix');
const previewList = document.getElementById('previewList');

function renderPreview() {
  const layers = selectedLayers();
  if (!layers.length) { previewList.innerHTML = '<i>未选中图层或组</i>'; return; }
  const rawPrefix = prefixInput.value;
  if (!normalize(rawPrefix)) {
    // 前缀为空/无效：预览就是原名（不变）
    previewList.innerHTML = layers.map(l => `<div>${l.name}</div>`).join('');
    return;
  }
  const rows = buildPreview(layers.map(l => l.name), rawPrefix);
  previewList.innerHTML = rows.map(r =>
    `<div>${r.from} &nbsp;→&nbsp; <b>${r.to}</b>${r.dup ? ' <span class="dup">⚠同名</span>' : ''}</div>`
  ).join('');
}

async function runRename() {
  const layers = selectedLayers();
  if (!layers.length) return setStatus('请先在图层面板选中图层或组');
  const rawPrefix = prefixInput.value;
  if (!normalize(rawPrefix)) return setStatus('前缀无效（规范化后为空）');
  const n = await applyRename(layers, rawPrefix);
  setStatus(`已重命名 ${n} 个图层/组`);
  renderPreview();                                     // 刷新为新名
}

// 输入前缀即时预览；聚焦时也刷新一次
prefixInput.addEventListener('input', renderPreview);
prefixInput.addEventListener('focus', renderPreview);

// 图层选择变化时，实时刷新预览（best-effort，不支持则忽略）
(async () => {
  try {
    await action.addNotificationListener(['select'], () => renderPreview());
  } catch { /* 某些版本不触发 select 通知，靠输入/聚焦刷新 */ }
})();

// ---- 事件绑定 ----
sliceBtn.addEventListener('click', () =>
  runSlice().catch(e => { setSlicing(false); setStatus('出错：' + e.message); }));

// 停止按钮：直接停止，无需确认
stopBtn.addEventListener('click', () => requestStop());

// ESC 快捷键：切图中按下 → 弹内联确认块
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && slicing) {
    e.preventDefault();
    stopConfirm.style.display = 'block';
    setStatus('按 ESC：确认是否终止切图？');
  }
});
document.getElementById('stopConfirmYes').onclick = () => {
  stopConfirm.style.display = 'none';
  requestStop();
};
document.getElementById('stopConfirmNo').onclick = () => {
  stopConfirm.style.display = 'none';
  setStatus('继续切图…');
};

document.getElementById('renameBtn').addEventListener('click', () =>
  runRename().catch(e => setStatus('出错：' + e.message)));

renderPreview();                                       // 初始渲染一次
setStatus('插件已加载');
