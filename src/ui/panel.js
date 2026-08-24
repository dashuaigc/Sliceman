// 面板入口：把纯逻辑（traversal/naming）与 PS 封装（layer-tree/exporter/renamer）接到 UI。
// 由 esbuild 打包（本地模块内联，photoshop/uxp 作为宿主注入保持 external）。
import { walk, filterTasksBySelection } from '../lib/traversal.js';
import { findSymbols } from '../lib/symbols.js';
import { buildBaseName, makeUniqueName } from '../lib/naming.js';
import { normalize } from '../lib/normalize.js';
import { readDocumentTree } from '../ps/layer-tree.js';
import { exportTask, exportSymbol, beginExport, endExport } from '../ps/exporter.js';
import { hasCounter, buildRenameRows } from '../lib/rename-core.js';
import { readItemIndexes, applyRename } from '../ps/renamer.js';
import { smartSplitLayer } from '../ps/smart-split.js';
import { convertToSmartObjects } from '../ps/smart-object.js';
import manifest from '../manifest.json';

const { app, action, core } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

const statusEl = document.getElementById('status');
function setStatus(msg) { statusEl.textContent = msg; }

// 让出事件循环一拍：使切图循环中排队的点击/按键（停止、ESC）得以处理
function tick() { return new Promise((r) => setTimeout(r, 0)); }

// 判断错误是否为"用户取消 modal"：PS 会用 ESC 取消正在运行的 executeAsModal。
// 把它识别出来，转成我们自己的暂停/询问流程，而不是当成真错误直接停。
function isUserCancel(err) {
  if (!err) return false;
  const msg = String(err.message ?? err).toLowerCase();
  return err.number === 9 || err.code === 9 || /cancel/.test(msg);
}

// 收集一个组的所有后代 id（递归，用 .layers 子集合）
function collectDescendantIds(group, out) {
  for (const child of group.layers || []) {
    out.add(child.id);
    collectDescendantIds(child, out);
  }
}

// 当前文档中选中的图层/组（同步读取）。
// 只保留"最外层被选中"的项：选中组时排除其组内子图层，
// 使预览/改名只作用于选中的组名或图层名本身。
function selectedLayers() {
  const doc = app.activeDocument;
  if (!doc) return [];
  const sel = Array.from(doc.activeLayers || []);
  if (sel.length <= 1) return sel;
  // 汇总所有"被选中的组"的后代 id
  const descendantIds = new Set();
  for (const l of sel) {
    if (l.kind === 'group') collectDescendantIds(l, descendantIds);
  }
  // 剔除掉"是某个选中组的后代"的项，只留最外层选中项
  return sel.filter((l) => !descendantIds.has(l.id));
}

// ---- 项目名称：会话级记忆（PS 开着期间/reload 保持，PS 关闭后清空）----
// 用 sessionStorage（进程会话内有效）而非 localStorage（跨进程持久）；并清掉旧版残留的 localStorage 值
const projectInput = document.getElementById('projectName');
function sesGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sesSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 不支持则不记忆 */ } }
try { localStorage.removeItem('projectName'); } catch { /* 忽略 */ }
projectInput.value = sesGet('projectName') || '';
projectInput.addEventListener('input', () => sesSet('projectName', projectInput.value));

// ---- 切图状态与停止控制 ----
const sliceBtn = document.getElementById('sliceBtn');
const btnLabel = sliceBtn.querySelector('.btn-label');   // 主按钮内的文字节点（按钮含图标+文字，不能整体设 textContent）
const stopConfirm = document.getElementById('stopConfirm');
const overwriteConfirm = document.getElementById('overwriteConfirm');
let currentPage = 'slice';               // 当前功能页：slice | symbols | rename | split | smartobj
let slicing = false;
let cancelRequested = false;   // 停止按钮：完成当前张后直接中止
let escPause = false;          // ESC：完成当前张后暂停并询问
let pauseDecider = null;       // 暂停时等待用户决定的 Promise resolver
let overwriteDecider = null;   // 同名覆盖询问的 Promise resolver
let overwriteAll = null;       // 记忆"全部覆盖/全部跳过"：null | 'overwrite' | 'skip'
let selectedFolder = null;     // 预选的导出位置（点「…」选择）；未选则导出时弹窗

// 勾选「只对选中的图层/组切图」时，空闲按钮显示"导出选中"，否则"开始完整切图"
function selectedOnly() { return document.getElementById('selectedOnly').checked; }
// 主按钮文字：空闲统一显示「开始导出」，进行中显示停止提示（见 setSlicing）
function updateSliceLabel() {
  if (!slicing) btnLabel.textContent = '开始导出';
}

function setSlicing(on) {
  slicing = on;
  // 切图进行中禁用功能磁贴，避免切页把正在用的主按钮隐藏
  setTilesDisabled(on);
  // 同一按钮：空闲显示青色"开始导出"，进行中变红色"停止切图"
  if (on) {
    btnLabel.textContent = '点击或按 ESC 停止切图';
    sliceBtn.classList.add('slicing');
  } else {
    sliceBtn.classList.remove('slicing');
    sliceBtn.style.display = '';               // 确保结束后按钮恢复显示
    updateSliceLabel();
    stopConfirm.style.display = 'none';       // 结束时收起确认块
    overwriteConfirm.style.display = 'none';
    escPause = false;
    pauseDecider = null;
    overwriteDecider = null;
    overwriteAll = null;
  }
}

// 弹出"同名文件"确认，返回 'overwrite' | 'skip' | 'overwriteAll' | 'skipAll'
function askOverwrite(name, ext) {
  document.getElementById('overwriteName').textContent = `${name}.${ext}`;
  overwriteConfirm.style.display = 'flex';
  setStatus(`发现同名文件：${name}.${ext}`);
  return new Promise((res) => { overwriteDecider = res; });
}

function requestStop(reason) {
  if (!slicing) return;
  cancelRequested = true;
  setStatus(reason || '正在停止…（当前这张完成后中断）');
}

// 弹出"是否终止"确认，返回 'terminate' | 'continue'
function askTerminate() {
  stopConfirm.style.display = 'flex';
  sliceBtn.style.display = 'none';   // 已暂停：隐藏"停止切图"，它只在任务进行中显示
  setStatus('已暂停：是否终止任务？');
  return new Promise((res) => { pauseDecider = res; });
}

// 终止时清理并恢复：关闭 ESC 取消导出后可能遗留的临时文档，
// 再按 id 切回原文档并恢复其切图前的历史状态。
async function cleanupAndRestore(originalDocId, historyState) {
  try {
    await core.executeAsModal(async () => {
      // 关闭遗留的 __sliceman_ 临时文档（ESC 中断导出时可能没走到 finally 的关闭）
      for (const d of Array.from(app.documents)) {
        if (d.name && d.name.startsWith('__sliceman_')) {
          try { await d.closeWithoutSaving(); } catch { /* 忽略单个关闭失败 */ }
        }
      }
      // 切回原文档并恢复历史（原文档本未被切图改动，这里是双保险）
      const orig = Array.from(app.documents).find(d => d.id === originalDocId);
      if (orig) {
        app.activeDocument = orig;
        if (historyState) {
          try { orig.activeHistoryState = historyState; } catch { /* 历史不可用则忽略 */ }
        }
      }
    }, { commandName: '恢复到切图前' });
  } catch { /* 整体失败也忽略：原文档本未被切图改动 */ }
}

// ---- 切图主流程 ----
// 「开始切图」：导出全部图层
function runSliceAll() {
  return runExport(
    (tree, includeHidden) => walk(tree, { includeHidden }),
    '没有可导出的图层',
  );
}

// 「导出选中」：只导出选中的组/图层，各自一张，沿用颜色规则与命名
function runExportSelected() {
  const ids = selectedLayers().map((l) => l.id);
  if (!ids.length) { setStatus('请先在图层面板选中图层或组'); return Promise.resolve(); }
  return runExport(
    (tree, includeHidden) => filterTasksBySelection(walk(tree, { includeHidden }), tree, ids),
    '选中项无可导出内容（可能均为红色或隐藏）',
  );
}

// 「Symbols 切图」：自动检测含「定位格」的组，各导一张（以定位格为基准框）
function runExportSymbols() {
  return runExport(
    (tree) => findSymbols(tree),
    '未找到含「定位格」的图层，无法识别 Symbol',
  );
}

// 关闭上次遗留的 __sliceman_ 临时文档，避免它成为活动文档、被误当作原文档来源
async function closeLeftoverTempDocs() {
  try {
    await core.executeAsModal(async () => {
      for (const d of Array.from(app.documents)) {
        if (d.name && d.name.startsWith('__sliceman_')) {
          try { await d.closeWithoutSaving(); } catch { /* 忽略单个关闭失败 */ }
        }
      }
    }, { commandName: '清理临时文档' });
  } catch { /* 忽略 */ }
}

// 通用导出引擎：给定"如何生成任务列表"，跑完整流水线。
// 去重 / 同名覆盖询问 / 停止 / ESC 暂停恢复 全部在此统一继承。
// @param makeTasks (tree, includeHidden) => Array<task>
// @param emptyMsg  任务为空时的提示
async function runExport(makeTasks, emptyMsg) {
  if (slicing) return;                                 // 防重复触发
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  await closeLeftoverTempDocs();                        // 先清理遗留临时文档，确保源文档正确
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');

  const includeHidden = document.getElementById('includeHidden').checked;
  const fullBleed = document.getElementById('fullBleed').checked;
  // 项目名规范化后为空（如纯符号）视为未填，避免污染出 seg1_ 前缀
  const project = normalize(projectInput.value) ? projectInput.value : '';
  const psdName = app.activeDocument.name.replace(/\.[^.]+$/, '');

  // 导出设置：格式与倍率（可操作控件），扩展名随格式变化
  const format = currentFormat();                      // png|jpg|webp|gif|bmp
  const scale = currentScale();                        // 0.25|0.5|1|2|3|5|10
  const ext = ({ jpg: 'jpg', webp: 'webp', gif: 'gif', bmp: 'bmp' })[format] || 'png';

  const tree = await readDocumentTree();
  const tasks = makeTasks(tree, includeHidden);
  if (!tasks.length) return setStatus(emptyMsg);       // 空任务：不弹文件夹，直接提示

  // 已设导出位置则直接用；未设则弹窗选择并记录到配置（之后不再询问）
  let folder = selectedFolder;
  if (!folder) {
    folder = await uxpFs.getFolder();
    if (!folder) return setStatus('已取消');
    await rememberFolder(folder);
  }

  const used = new Set();            // 仅本次运行内部去重（同名自动加 _2/_3）
  const existingFiles = new Set();   // 目标文件夹已存在的同格式基名（小写），命中则询问覆盖/跳过
  const extLc = '.' + ext;
  for (const e of await folder.getEntries()) {
    const nm = e.name.toLowerCase();
    if (e.isFile && nm.endsWith(extLc)) existingFiles.add(nm.slice(0, -extLc.length));
  }

  // 记录切图前的历史快照，供"终止并恢复"回退
  let originalHistory = null;
  try { originalHistory = app.activeDocument.activeHistoryState; } catch { /* 读不到就跳过恢复 */ }

  cancelRequested = false;
  escPause = false;
  const t0 = Date.now();                 // 记录开始时间，完成后算耗时
  setSlicing(true);
  let ok = 0, empty = 0, deduped = 0, skipped = 0;
  const ps = { docId: app.activeDocument.id, fileName: psdName };
  // 用 index 遍历：被 ESC 取消的那张要能重做，故文件名算一次后缓存复用（避免重试误加 _2）
  let i = 0;
  let currentName = null, currentDeduped = false;
  try {
    setStatus(`共 ${tasks.length} 张，准备中…`);   // 切图前先告知总数
    const base = await beginExport(ps);   // 整批只复制一次原文档并建快照（每张导出后回退复用，提速关键）
    ps.workId = base.workId;
    while (i < tasks.length) {
      const task = tasks[i];
      await tick();                                    // 让排队的停止/ESC 事件先执行
      if (cancelRequested) {                           // 停止按钮：完成上一张后在此中止
        setStatus(`已停止：导出 ${ok} 张后中断（剩余 ${tasks.length - i} 个未处理）`);
        return;
      }

      // 文件名：仅在没有"上一次被取消而保留的名字"时才重新计算并登记去重
      if (currentName == null) {
        const segments = [project, psdName, ...task.pathSegments].filter(s => s !== '' && s != null);
        const base = buildBaseName(segments);
        currentName = makeUniqueName(base, used);
        currentDeduped = currentName !== base;
      }

      // 目标文件夹已存在同名文件 → 询问覆盖/跳过（"全部"决定记忆到本次运行结束）
      if (existingFiles.has(currentName.toLowerCase())) {
        let action = overwriteAll;
        if (!action) {
          const d = await askOverwrite(currentName, ext);
          overwriteConfirm.style.display = 'none';
          if (d === 'overwriteAll') { overwriteAll = 'overwrite'; action = 'overwrite'; }
          else if (d === 'skipAll') { overwriteAll = 'skip'; action = 'skip'; }
          else action = d;
        }
        if (action === 'skip') {
          skipped++;
          setStatus(`跳过同名：${currentName}`);
          currentName = null;
          i++;
          continue;
        }
        // action === 'overwrite'：照常导出（exportTask 用 overwrite:true 覆盖）
      }

      let userCancelled = false;
      try {
        const r = task.type === 'symbol'
          ? await exportSymbol(task, ps, folder, currentName, { includeHidden, format, scale })
          : await exportTask(task, ps, folder, currentName, { fullBleed, includeHidden, format, scale });
        if (r === 'ok') ok++; else empty++;
        if (currentDeduped) deduped++;                 // 成功后再计入去重
        setStatus(`导出中… ${ok}/${tasks.length} 张`);
      } catch (err) {
        if (isUserCancel(err)) userCancelled = true;   // ESC 取消了导出 modal → 转入暂停询问
        else throw err;                                // 真错误交给外层 catch
      }

      // ESC / 取消：完成或中断当前这张后暂停并询问
      await tick();                                    // 让 ESC keydown 先登记
      if (escPause || userCancelled) {
        escPause = false;
        const decision = await askTerminate();
        stopConfirm.style.display = 'none';
        sliceBtn.style.display = '';        // 恢复显示（继续则重新进入进行中状态）
        if (decision === 'terminate') {
          await cleanupAndRestore(ps.docId, originalHistory);
          setStatus(`已终止并恢复 PSD：导出 ${ok} 张后中止`);
          return;
        }
        setStatus('继续切图…');
        if (userCancelled) continue;                   // 继续：重做被取消的这张（currentName 保留，i 不变）
      }

      currentName = null;                              // 这张已完成，进入下一张
      i++;
    }
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    setStatus(`完成：已导出 ${ok}/${tasks.length} 张，耗时 ${secs} 秒\n去重 ${deduped} 次，跳过空图层 ${empty} 张，跳过同名 ${skipped} 张`);
  } finally {
    await endExport(ps);   // 关闭共享工作文档
    setSlicing(false);
  }
}

// 把任意异常转成可读字符串：batchPlay 常抛 undefined 或只有 number/_overallError
function errMsg(e) {
  if (e == null) return '未知错误(undefined)';
  if (typeof e === 'string') return e;
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.number != null) parts.push('number=' + e.number);
  if (e._overallError) parts.push(String(e._overallError));
  if (!parts.length) { try { parts.push(JSON.stringify(e)); } catch { parts.push(String(e)); } }
  return parts.filter(Boolean).join(' | ') || '未知错误';
}

// ---- 智能分割：选中一个像素图层 → 识别连通块 → 各复制为独立图层 ----
const splitBtn = document.getElementById('splitBtn');
let splitting = false;

async function runSmartSplit() {
  if (splitting) return;
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  // 取最外层选中项；要求恰好选中一个像素图层（组/多选/未选都给明确提示）
  const sel = selectedLayers();
  if (!sel.length) return setStatus('请先在图层面板选中一个要分割的像素图层');
  if (sel.length > 1) return setStatus('一次只分割一个图层，请只选中一个像素图层');
  const layer = sel[0];
  if (layer.kind === 'group') return setStatus('选中的是组，请改选组内的单个像素图层');

  splitting = true;
  setTilesDisabled(true);
  const lbl = splitBtn.querySelector('.btn-label');
  const orig = lbl.textContent;
  lbl.textContent = '分割中…';
  splitBtn.style.pointerEvents = 'none';
  splitBtn.style.opacity = '0.6';
  let lastStep = '尚未开始';
  setStatus('正在识别连通元素…');
  try {
    const { created, blocks, mergeInfo } = await smartSplitLayer(layer.id, {
      merge: document.getElementById('splitMerge').checked,
      onStep: (msg) => { lastStep = msg; },
      onProgress: (done, total) => setStatus(`分割中… ${done}/${total} 块`),
    });
    // 诊断信息：连通块数与自适应阈值（新代码标识；老版本不会显示这行）
    const diag = mergeInfo && mergeInfo.components != null
      ? `\n连通 ${mergeInfo.components} 块 → ${mergeInfo.grid ? '网格布局，按格分割' : `自适应阈值 ${mergeInfo.thresholdPx ?? '—'}px`}`
      : '';
    if (blocks <= 1) setStatus(`只识别到 ${blocks} 个元素，无需分割${diag}\n（最后一步：${lastStep}）`);
    else setStatus(`完成：识别 ${blocks} 个元素，已新建 ${created} 个独立图层（原图层未改动）${diag}`);
  } catch (e) {
    setStatus(`分割失败：${errMsg(e)}\n（最后成功的一步：${lastStep}）`);
  } finally {
    splitting = false;
    setTilesDisabled(false);
    lbl.textContent = orig;
    splitBtn.style.pointerEvents = '';
    splitBtn.style.opacity = '';
  }
}

splitBtn.addEventListener('click', () => { runSmartSplit(); });

// ---- 批量转智能对象：选中图层逐个转独立 SO，绝不合并 ----
const smartObjBtn = document.getElementById('smartObjBtn');
let converting = false;

async function runSmartObjects() {
  if (converting) return;
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  const sel = selectedLayers();
  if (!sel.length) return setStatus('请先选择需要转换的图层');

  converting = true;
  setTilesDisabled(true);
  const lbl = smartObjBtn.querySelector('.btn-label');
  const orig = lbl.textContent;
  lbl.textContent = '转换中…';
  smartObjBtn.style.pointerEvents = 'none';
  smartObjBtn.style.opacity = '0.6';
  setStatus('正在转换为智能对象…');
  try {
    const r = await convertToSmartObjects(sel.map((l) => l.id), {
      onProgress: (done, total) => setStatus(`转换中… ${done}/${total} 个`),
    });
    // 按需求组织提示：全部已转换 / 混合跳过 / 有失败，各自成句
    if (!r.converted && !r.failed) return setStatus('所选图层已经是智能对象');
    const parts = [`已转换 ${r.converted} 个图层为独立智能对象`];
    if (r.skippedSO) parts.push(`跳过 ${r.skippedSO} 个智能对象`);
    if (r.failed) parts.push(`${r.failed} 个图层无法转换`);
    setStatus(parts.join('，'));
  } catch (e) {
    setStatus('转换失败：' + errMsg(e));
  } finally {
    converting = false;
    setTilesDisabled(false);
    lbl.textContent = orig;
    smartObjBtn.style.pointerEvents = '';
    smartObjBtn.style.opacity = '';
  }
}

smartObjBtn.addEventListener('click', () => { runSmartObjects(); });

// ---- 批量重命名：替换 / 重新命名 / 加前缀 / 加后缀 + n 连续编号，输入即预览 ----
const previewList = document.getElementById('previewList');
const findInput = document.getElementById('findText');
const templateInput = document.getElementById('templateText');
const startInput = document.getElementById('startNum');
const stepInput = document.getElementById('stepNum');
const counterSwitchEl = document.getElementById('counterSwitch');
const MODE_LABEL = { replace: '替换为', new: '新名称', prefix: '前缀', suffix: '后缀' };
const MODE_PLACEHOLDER = { replace: '如 Icon_n', new: '如 Button_n', prefix: '如 UI_', suffix: '如 _n' };
let renameMode = 'replace';               // replace | new | prefix | suffix

// 图层名进 innerHTML 前转义，防名字里的 <>& 被当标签
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function readRenameCfg() {
  const active = (boxId, attr) => {
    const a = document.querySelector(`#${boxId} .pill.active`);
    return a ? a.getAttribute(attr) : null;
  };
  const toInt = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };
  return {
    mode: renameMode,
    find: findInput.value,
    template: templateInput.value,
    counter: !!counterSwitchEl.checked,                      // 显式开关，不从模板猜
    start: toInt(startInput.value, 1),
    step: toInt(stepInput.value, 1),
    digits: parseInt(active('digitsPills', 'data-digits'), 10) || 0,   // 自动=0 不补零
  };
}

// 选中层按图层面板顺序排序（编号与预览都按此序）：
// 主路：一次 batchPlay 读回 itemIndex（自面板底部向上递增 → 从上到下 = 降序）；
// 兜底：itemIndex 读不到时按 doc.layers 遍历序（UXP 面板序，首个=最上）。
async function sortedSelectedLayers() {
  const sel = selectedLayers();
  if (sel.length <= 1) return sel;
  const up = document.querySelector('#dirPills .pill.active')?.getAttribute('data-dir') === 'up';
  const idx = await readItemIndexes(sel.map((l) => l.id));
  if (idx.size === sel.length) {
    return sel.slice().sort((a, b) => (idx.get(a.id) - idx.get(b.id)) * (up ? 1 : -1));
  }
  try {
    const order = [];
    (function walkIds(cont) {
      for (const l of cont.layers || []) { order.push(l.id); walkIds(l); }
    })(app.activeDocument);
    const pos = new Map(order.map((id, i) => [id, i]));
    const sorted = sel.slice().sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    return up ? sorted.reverse() : sorted;
  } catch { return sel; }
}

// 模式相关字段显隐 + 标签/占位文案（编号设置区由「启用编号 n」开关控制）
function updateRenameFields() {
  show('findBlock', renameMode === 'replace');
  document.getElementById('templateLabel').textContent = MODE_LABEL[renameMode];
  templateInput.setAttribute('placeholder', MODE_PLACEHOLDER[renameMode]);
  document.getElementById('counterBlock').style.display = counterSwitchEl.checked ? '' : 'none';
}

let renderSeq = 0;   // 连续输入时只保留最后一次异步渲染的结果
async function renderRenamePreview() {
  const seq = ++renderSeq;
  updateRenameFields();
  const layers = await sortedSelectedLayers();
  if (seq !== renderSeq) return;                     // 已被更新的渲染取代
  if (!layers.length) { previewList.innerHTML = '<i>未选中图层或组</i>'; return; }
  const cfg = readRenameCfg();
  // 必填输入为空：预览退化为原名（替换模式要填查找，其它模式要填模板）
  const inputReady = cfg.mode === 'replace' ? !!cfg.find : !!cfg.template;
  if (!inputReady) {
    previewList.innerHTML = layers.map((l) => `<div>${esc(l.name)}</div>`).join('');
    return;
  }
  const rows = buildRenameRows(layers.map((l) => l.name), cfg);
  // 开着编号但模板里没有独立的 n：提示一句，避免"怎么没编号"的困惑（不阻止执行）
  const hint = cfg.counter && cfg.template && !hasCounter(cfg.template)
    ? '<i>已启用编号，但模板里没有独立的 n（Button/Icon 里的 n 不算），编号不会出现</i>'
    : '';
  previewList.innerHTML = hint + rows.map((r) => r.unmatched
    ? `<div>${esc(r.from)} <span class="dup">未找到「${esc(cfg.find)}」</span></div>`
    : `<div>${esc(r.from)} &nbsp;→&nbsp; <b>${esc(r.to)}</b>${r.dup ? ' <span class="dup">⚠同名</span>' : ''}</div>`
  ).join('');
}

async function runRename() {
  const layers = await sortedSelectedLayers();
  if (!layers.length) return setStatus('请先选择需要重命名的图层');
  const cfg = readRenameCfg();
  if (cfg.mode === 'replace' && !cfg.find) return setStatus('请输入查找内容');
  if (cfg.mode !== 'replace' && !cfg.template) return setStatus(`请输入${MODE_LABEL[cfg.mode]}`);
  const rows = buildRenameRows(layers.map((l) => l.name), cfg);
  const unmatched = rows.filter((r) => r.unmatched).length;
  if (unmatched === rows.length) {
    return setStatus(`选中的 ${rows.length} 个图层名称中都没有「${cfg.find}」，未做修改`);
  }
  // 只写回真正会变化的行（未匹配/同名不变/替换后为空 都不动）
  const pairs = [];
  rows.forEach((r, i) => {
    if (!r.unmatched && r.to && r.to !== r.from) pairs.push({ id: layers[i].id, name: r.to });
  });
  if (!pairs.length) return setStatus('没有需要修改的图层（新名称与原名称相同）');
  const { renamed, failed } = await applyRename(pairs);
  const parts = [`已重命名 ${renamed} 个图层/组`];
  if (unmatched) parts.push(`${rows.length} 个中有 ${unmatched} 个未找到匹配内容`);
  if (failed) parts.push(`${failed} 个无法重命名`);
  setStatus(parts.join('，'));
  renderRenamePreview();                             // 刷新为新名
}

// 一组 pill 单选：点选切换 .active 并回调
function bindPillGroup(containerId, attr, onChange) {
  const box = document.getElementById(containerId);
  if (!box) return;
  Array.from(box.querySelectorAll('.pill')).forEach((p) => {
    p.addEventListener('click', () => {
      Array.from(box.querySelectorAll('.pill')).forEach((q) => q.classList.remove('active'));
      p.classList.add('active');
      onChange(p.getAttribute(attr));
    });
  });
}
bindPillGroup('renameModePills', 'data-mode', (m) => { renameMode = m; renderRenamePreview(); });
bindPillGroup('digitsPills', 'data-digits', () => renderRenamePreview());
bindPillGroup('dirPills', 'data-dir', () => renderRenamePreview());
setupSwitch('counterSwitch', false, () => renderRenamePreview());   // 编号开关：默认关

// 输入即时预览；聚焦时也刷新一次
findInput.addEventListener('input', renderRenamePreview);
findInput.addEventListener('focus', renderRenamePreview);
templateInput.addEventListener('input', renderRenamePreview);
templateInput.addEventListener('focus', renderRenamePreview);
startInput.addEventListener('input', renderRenamePreview);
stepInput.addEventListener('input', renderRenamePreview);
startInput.value = '1';                               // sp-textfield 的 value 属性不可靠，用 JS 赋初值
stepInput.value = '1';

// 图层选择变化时，实时刷新预览（best-effort，不支持则忽略）
(async () => {
  try {
    await action.addNotificationListener(['select'], () => renderRenamePreview());
  } catch { /* 某些版本不触发 select 通知，靠输入/聚焦刷新 */ }
})();

// ---- 事件绑定 ----
// 同一按钮：进行中点击=停止（完成当前这张后中断）；
// 空闲点击=按勾选框决定：勾选→仅导出选中，未勾选→全部导出
sliceBtn.addEventListener('click', () => {
  if (slicing) { requestStop(); return; }
  // Symbols 页 → Symbols 导出；切图页 → 按「只对选中切图」决定全量/仅选中
  const run = currentPage === 'symbols'
    ? runExportSymbols
    : (selectedOnly() ? runExportSelected : runSliceAll);
  run().catch(e => { setSlicing(false); setStatus('出错：' + e.message); });
});

// ESC 快捷键：切图中按下 → 标记暂停（当前这张切完后在循环里弹确认）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && slicing && !escPause && !pauseDecider) {
    e.preventDefault();
    escPause = true;
    setStatus('已按 ESC：完成当前图层后暂停…');
  }
});
// 确认块两个按钮：解决暂停 Promise
document.getElementById('stopConfirmYes').onclick = () => {
  if (pauseDecider) { const d = pauseDecider; pauseDecider = null; d('terminate'); }
};
document.getElementById('stopConfirmNo').onclick = () => {
  if (pauseDecider) { const d = pauseDecider; pauseDecider = null; d('continue'); }
};

// 同名覆盖确认：四个按钮解决 askOverwrite 的 Promise
function resolveOverwrite(v) {
  if (overwriteDecider) { const d = overwriteDecider; overwriteDecider = null; d(v); }
}
document.getElementById('ovwYes').onclick    = () => resolveOverwrite('overwrite');
document.getElementById('ovwNo').onclick     = () => resolveOverwrite('skip');
document.getElementById('ovwYesAll').onclick = () => resolveOverwrite('overwriteAll');
document.getElementById('ovwNoAll').onclick  = () => resolveOverwrite('skipAll');

document.getElementById('renameBtn').addEventListener('click', () =>
  runRename().catch(e => setStatus('出错：' + e.message)));

// ---- 手写滑动开关：仍暴露原生 .checked，供切图逻辑无感读取 ----
// （UXP 下自绘开关比 sp-switch 稳；子元素 knob 已设 pointer-events:none）
function setupSwitch(id, initial, onChange) {
  const el = document.getElementById(id);
  el.checked = initial;                          // 供 runExport 读取 .checked
  el.classList.toggle('on', initial);
  el.addEventListener('click', () => {
    el.checked = !el.checked;
    el.classList.toggle('on', el.checked);
    if (onChange) onChange();
  });
}
setupSwitch('includeHidden', true);
setupSwitch('fullBleed', true);
setupSwitch('selectedOnly', false);
setupSwitch('splitMerge', true);

// ---- 功能页切换：前三张磁贴切换 UI，「更多功能」不绑定操作 ----
const tiles = Array.from(document.querySelectorAll('.tile'));
function setTilesDisabled(on) {
  tiles.forEach(t => { t.style.pointerEvents = on ? 'none' : ''; t.style.opacity = on ? '0.5' : ''; });
}
function show(id, on) { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; }
function switchPage(name) {
  currentPage = name;
  tiles.forEach(t => t.classList.toggle('active', t.getAttribute('data-page') === name));
  show('symbolsIntro', name === 'symbols');
  show('sliceIntro', name === 'slice');
  show('splitIntro', name === 'split');
  show('smartObjIntro', name === 'smartobj');
  show('exportConfig', name === 'slice' || name === 'symbols');
  show('renamePage', name === 'rename');
  show('sliceBtn', name === 'slice' || name === 'symbols');   // 切图/Symbols 共用主按钮
  show('renameBtn', name === 'rename');
  show('splitBtn', name === 'split');
  show('smartObjBtn', name === 'smartobj');
}
tiles.forEach((t) => t.addEventListener('click', () => {
  if (slicing || splitting || converting) return;  // 任务进行中不切页
  const page = t.getAttribute('data-page');
  if (page === 'slice' || page === 'symbols' || page === 'rename' || page === 'split' || page === 'smartobj') switchPage(page);
}));
switchPage('slice');                             // 初始进入完整切图页

// ---- 导出设置：格式 / 倍率 / 位置（真实生效的可操作控件）----
function bindPills(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  Array.from(box.querySelectorAll('.pill')).forEach((p) => {
    p.addEventListener('click', () => {
      Array.from(box.querySelectorAll('.pill')).forEach((q) => q.classList.remove('active'));
      p.classList.add('active');
    });
  });
}
bindPills('formatPills');
bindPills('scalePills');
function currentFormat() {
  const a = document.querySelector('#formatPills .pill.active');
  return a ? a.getAttribute('data-format') : 'png';
}
function currentScale() {
  const a = document.querySelector('#scalePills .pill.active');
  return a ? (parseFloat(a.getAttribute('data-scale')) || 1) : 1;   // 支持 0.25/0.5 小数倍率
}
// 下拉箭头：展开/收起该行的「更多」选项
document.querySelectorAll('.chev').forEach((c) => c.addEventListener('click', () => {
  c.parentElement.classList.toggle('expanded');
}));
// 导出位置：点「…」预选文件夹并记住，导出时直接使用（不再每次弹窗）
const pickFolderBtn = document.getElementById('pickFolderBtn');
const exportPathText = document.getElementById('exportPathText');

// 记住导出位置：仅本次会话记住（重开插件回到未设置状态，导出位置为空）
function rememberFolder(folder) {
  selectedFolder = folder;
  exportPathText.textContent = folder.nativePath || '已选择文件夹';
}

pickFolderBtn.addEventListener('click', async () => {
  try { const f = await uxpFs.getFolder(); if (f) rememberFolder(f); } catch { /* 用户取消：保持原状 */ }
});

// 顶栏版本号：始终显示 manifest 中的真实版本
const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = 'v' + manifest.version;

renderRenamePreview();                                // 初始渲染一次
updateSliceLabel();                                    // 初始化主按钮文字
setStatus('插件已加载');
