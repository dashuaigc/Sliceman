// 面板入口：把纯逻辑（traversal/naming）与 PS 封装（layer-tree/exporter/renamer）接到 UI。
// 由 esbuild 打包（本地模块内联，photoshop/uxp 作为宿主注入保持 external）。
import { walk } from '../lib/traversal.js';
import { buildBaseName, makeUniqueName } from '../lib/naming.js';
import { normalize } from '../lib/normalize.js';
import { readDocumentTree } from '../ps/layer-tree.js';
import { exportTask } from '../ps/exporter.js';
import { buildPreview, getSelectedLayers, applyRename } from '../ps/renamer.js';

const { app } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

const statusEl = document.getElementById('status');
function setStatus(msg) { statusEl.textContent = msg; }

// ---- 项目名称持久化（记住上次输入） ----
const projectInput = document.getElementById('projectName');
projectInput.value = localStorage.getItem('projectName') || '';
projectInput.addEventListener('change', () => localStorage.setItem('projectName', projectInput.value));

// ---- 切图主流程 ----
async function runSlice() {
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  const folder = await uxpFs.getFolder();            // 弹文件夹选择
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

  let ok = 0, empty = 0, deduped = 0;
  const ps = { docId: app.activeDocument.id, fileName: psdName };
  for (const task of tasks) {
    const segments = [project, psdName, ...task.pathSegments].filter(s => s !== '' && s != null);
    const base = buildBaseName(segments);
    const unique = makeUniqueName(base, used);
    if (unique !== base) deduped++;                  // 统计去重次数
    const r = await exportTask(task, ps, folder, unique, { fullBleed, includeHidden });
    if (r === 'ok') ok++; else empty++;
    setStatus(`导出中… ${ok} 张`);
  }
  setStatus(`完成：已导出 ${ok} 张，去重 ${deduped} 次，跳过空图层 ${empty} 张`);
}

// ---- 批量前缀重命名流程 ----
async function runRename() {
  const layers = await getSelectedLayers();
  if (!layers.length) return setStatus('请先在图层面板选中图层或组');
  const rawPrefix = document.getElementById('prefix').value;
  const rows = buildPreview(layers.map(l => l.name), rawPrefix);
  if (!rows) return setStatus('前缀无效（规范化后为空）');

  const listEl = document.getElementById('previewList');
  listEl.innerHTML = rows.map(r =>
    `<div>${r.from} &nbsp;→&nbsp; <b>${r.to}</b>${r.dup ? ' <span style="color:#d9534f">⚠同名</span>' : ''}</div>`
  ).join('');

  const dlg = document.getElementById('previewDialog');
  document.getElementById('previewConfirm').onclick = async () => {
    dlg.close();
    const n = await applyRename(layers, rawPrefix);
    setStatus(`已重命名 ${n} 个图层`);
  };
  document.getElementById('previewCancel').onclick = () => { dlg.close(); setStatus('已取消'); };

  // UXP 版本差异：优先 uxpShowModal，回退 showModal
  if (dlg.uxpShowModal) await dlg.uxpShowModal();
  else dlg.showModal();
}

document.getElementById('sliceBtn').addEventListener('click', () =>
  runSlice().catch(e => setStatus('出错：' + e.message)));
document.getElementById('renameBtn').addEventListener('click', () =>
  runRename().catch(e => setStatus('出错：' + e.message)));

setStatus('插件已加载');
