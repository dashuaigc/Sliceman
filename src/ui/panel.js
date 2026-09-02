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
import { createGroups } from '../ps/group-maker.js';
import { layoutLayers } from '../ps/layouter.js';
import { moveLayers } from '../ps/mover.js';
import { parseDistance, applySign, toDelta, nudgeValue, formatDist, describeDelta } from '../lib/move-core.js';
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
let currentPage = 'rename';              // 当前功能页：rename | split | batch | layout | slice（初始由 switchPage 定）
let sliceMode = 'all';                   // 切图页内的方式：all=完整切图 | symbols=按定位格导出
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

// ---- 批量新建独立组：给每个选中对象各套一层父级组，绝不合并 ----
// 新组沿用原对象名称（父子同名），无命名选项。
const groupBtn = document.getElementById('groupBtn');
let grouping = false;

async function runCreateGroups() {
  if (grouping) return;
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  const layers = await sortedSelectedLayers(false);
  if (!layers.length) return setStatus('请先选择至少一个图层或图层组');
  // 名称在执行前一次读好：建组过程中图层顺序会变，事后再读会错位
  const pairs = layers.map((l) => ({ id: l.id, name: l.name }));

  grouping = true;
  setTilesDisabled(true);
  const lbl = groupBtn.querySelector('.btn-label');
  const orig = lbl.textContent;
  lbl.textContent = '建组中…';
  groupBtn.style.pointerEvents = 'none';
  groupBtn.style.opacity = '0.6';
  setStatus('正在新建独立组…');
  try {
    const r = await createGroups(pairs, {
      selectAfter: true,                             // 执行后恒选中新建的组，便于接着做下一步批量操作
      onProgress: (done, total) => setStatus(`建组中… ${done}/${total} 个`),
    });
    const parts = [`共选择 ${pairs.length} 个对象，成功创建 ${r.created} 个独立组`];
    if (r.failed) parts.push(`${r.failed} 个对象无法处理（如背景图层）`);
    setStatus(parts.join('，'));
  } catch (e) {
    setStatus('新建组失败：' + errMsg(e));
  } finally {
    grouping = false;
    setTilesDisabled(false);
    lbl.textContent = orig;
    groupBtn.style.pointerEvents = '';
    groupBtn.style.opacity = '';
  }
}

groupBtn.addEventListener('click', () => { runCreateGroups(); });

// ---- 一键排版：按对象在画布中的实际空间位置重排选中的图层/组 ----
// 排序不看图层面板顺序，看 Bounds；锚点（排序后第一个对象）保持原位，其余依次贴过去。
const layoutBtn = document.getElementById('layoutBtn');
const layoutGapInput = document.getElementById('layoutGap');
const layoutMarginInput = document.getElementById('layoutMargin');
const layoutMarginRow = document.getElementById('layoutMarginRow');
const layoutExpandEl = document.getElementById('layoutExpand');
let laying = false;
let layoutDir = 'h';                    // h=横排 | v=竖排

// 排版设置跨会话记忆（localStorage）；项目名称那套用的是 sessionStorage，两者互不相干
function prefGet(k, dflt) {
  try { const v = localStorage.getItem(k); return v == null ? dflt : v; } catch { return dflt; }
}
function prefSet(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* 不支持则不记忆 */ } }

// 数值输入统一口径：非法/越界都夹回 0～9999 的整数
function clampPx(v, dflt) {
  const n = Math.round(parseFloat(v));
  return Number.isFinite(n) ? Math.min(9999, Math.max(0, n)) : dflt;
}

// 把某组 pill 的选中态设成指定值（用于回填记忆的设置）
function setPillActive(containerId, attr, value) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const pills = Array.from(box.querySelectorAll('.pill'));
  const hit = pills.find((p) => p.getAttribute(attr) === value);
  if (!hit) return;
  pills.forEach((p) => p.classList.remove('active'));
  hit.classList.add('active');
}
function activePill(containerId, attr) {
  const a = document.querySelector(`#${containerId} .pill.active`);
  return a ? a.getAttribute(attr) : null;
}

// 方向切换：只显示对应的一组对齐选项（横排 顶/中/底，竖排 左/中/右），两组各自保留选择
function updateLayoutAlignRow() {
  show('layoutAlignH', layoutDir === 'h');
  show('layoutAlignV', layoutDir === 'v');
}
// 未开启「自动扩展画布」时，画布边距整行置灰不可操作。
// 光靠父级 pointer-events:none 挡不住 sp-textfield（UXP 原生控件自成一层），再显式加 disabled
function updateLayoutMarginRow() {
  const off = !layoutExpandEl.checked;
  layoutMarginRow.classList.toggle('row-off', off);
  if (off) layoutMarginInput.setAttribute('disabled', '');
  else layoutMarginInput.removeAttribute('disabled');
}

// UXP 已知问题：具备文字编辑能力的控件恒绘制在所有 DOM 之上，z-index 无效
// （换成普通 <input> 同样如此，是原生编辑层的问题）。官方给的解法就是浮层出现时把它藏起来。
// ⚠️ 必须设在 sp-textfield 元素自身：设在父级容器上不生效，原生编辑层不继承父级可见性。
// 用 visibility 而非 display —— 占位保留，行高不跳、鼠标不会因为布局位移而反复进出。
// 同一时刻只有一个功能页可见，所以不分页、一律全藏，省掉「这个提示压着哪几个框」的判断。
const TIP_MASKED_FIELD_IDS = [
  'layoutGap', 'layoutMargin', 'moveX', 'moveY',      // 一键排版 / 批量快速平移
  'findText', 'templateText', 'startNum', 'stepNum',  // 批量重命名
];
function setTipMaskedFields(on) {
  const v = on ? 'hidden' : '';
  for (const id of TIP_MASKED_FIELD_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.visibility = v;
  }
}

function readLayoutCfg() {
  return {
    direction: layoutDir,
    align: activePill(layoutDir === 'h' ? 'layoutAlignH' : 'layoutAlignV', 'data-align'),
    gap: clampPx(layoutGapInput.value, 10),
    expandCanvas: !!layoutExpandEl.checked,
    margin: clampPx(layoutMarginInput.value, 10),
  };
}

// 少于 2 个对象时主按钮置灰；停在排版页时把原因直接写进状态栏。
// @param {boolean} [force] 切到本页时强制刷一次状态栏
let lastLayoutCount = -1;   // 上次写进状态栏时的选中数
function refreshLayoutBtn(force) {
  if (laying) return;
  const count = app.activeDocument ? selectedLayers().length : 0;
  layoutBtn.classList.toggle('btn-off', count < 2);
  // 选中数没变就不碰状态栏：排版恢复选择会再触发一次 select 通知，
  // 否则刚写好的结果提示会被"已选择 N 个对象"冲掉
  const changed = count !== lastLayoutCount;
  lastLayoutCount = count;
  if (currentPage !== 'layout' || !(changed || force)) return;
  if (!app.activeDocument) setStatus('请先打开一个 PSD 文档');
  else if (count < 2) setStatus('请选择至少 2 个图层。');
  else setStatus(`已选择 ${count} 个对象，可以排版`);
}

async function runLayout() {
  if (laying) return;
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  const sel = selectedLayers();                    // 选中组时自动排除其子图层，组作为整体参与排版
  if (sel.length < 2) return setStatus('请选择至少 2 个图层。');
  const cfg = readLayoutCfg();
  layoutGapInput.value = String(cfg.gap);          // 夹过的值写回输入框，所见即所用
  layoutMarginInput.value = String(cfg.margin);

  laying = true;
  setTilesDisabled(true);
  const lbl = layoutBtn.querySelector('.btn-label');
  const orig = lbl.textContent;
  lbl.textContent = '排版中…';
  layoutBtn.style.pointerEvents = 'none';
  layoutBtn.style.opacity = '0.6';
  setStatus('正在排版…');
  try {
    const r = await layoutLayers(sel.map((l) => l.id), {
      ...cfg,
      onProgress: (done, total) => setStatus(`排版中… ${done}/${total} 个`),
    });
    if (r.locked.length) {
      // 有锁定图层时插件一层都不动（不擅自解锁），把名字报出来让用户自己解
      const names = r.locked.slice(0, 3).join('、') + (r.locked.length > 3 ? '…' : '');
      setStatus(`发现 ${r.locked.length} 个锁定图层，请解锁后重新排版：${names}`);
    } else if (r.total < 2) {
      setStatus('可参与排版的对象不足 2 个（无有效边界的空图层已跳过）');
    } else {
      const parts = [`已按${cfg.direction === 'h' ? '横向' : '竖向'}排列 ${r.total} 个对象，间距 ${cfg.gap}px`];
      if (r.skipped) parts.push(`跳过 ${r.skipped} 个无边界对象`);
      if (r.failed) parts.push(`${r.failed} 个对象移动失败`);
      if (r.expanded) {
        const grown = [['右', r.expanded.right], ['下', r.expanded.bottom], ['左', r.expanded.left], ['上', r.expanded.top]]
          .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}px`);
        if (grown.length) parts.push(`画布已扩展：${grown.join('、')}`);
      }
      setStatus(parts.join('，'));
    }
  } catch (e) {
    setStatus('排版失败：' + errMsg(e));
  } finally {
    laying = false;
    setTilesDisabled(false);
    lbl.textContent = orig;
    layoutBtn.style.pointerEvents = '';
    layoutBtn.style.opacity = '';
    refreshLayoutBtn();
  }
}

layoutBtn.addEventListener('click', () => { runLayout(); });

// ---- 快速平移：所有选中对象按同一个 X/Y 偏移量整体平移（相对位移，不是绝对坐标）----
const moveBtn = document.getElementById('moveBtn');
const moveXInput = document.getElementById('moveX');
const moveYInput = document.getElementById('moveY');
let moving = false;

// 读一个距离输入框：空 → 0（该轴不动）；非数字 → 标红并返回 null（不执行）；
// 负数 → 取绝对值并翻转方向 pill，于是界面上永远是「方向 + 正数」，
// 不会出现「← 配 -20」这种双重反向。
function readMoveField(input, pillsId) {
  const box = input.parentNode;                    // 外层 .num-box；UXP 的 closest 不一定有，用 parentNode
  const raw = parseDistance(input.value);
  if (raw === null) { if (box) box.classList.add('field-err'); return null; }
  if (box) box.classList.remove('field-err');
  const cur = activePill(pillsId, 'data-dir');
  const r = applySign(raw, cur);
  if (r.dir !== cur) setPillActive(pillsId, 'data-dir', r.dir);
  prefSet(pillsId === 'moveXDirPills' ? 'move.xDir' : 'move.yDir', r.dir);
  // 输入框留空就保持空（空 = 0，不要写成 "0" 平添噪音）；有值则回填归一后的正数
  if (String(input.value).trim() !== '') input.value = formatDist(r.dist);
  return r.dist;
}

function readMoveCfg() {
  const xDist = readMoveField(moveXInput, 'moveXDirPills');
  const yDist = readMoveField(moveYInput, 'moveYDirPills');
  if (xDist === null || yDist === null) return null;
  return {
    xDir: activePill('moveXDirPills', 'data-dir'),
    xDist,
    yDir: activePill('moveYDirPills', 'data-dir'),
    yDist,
  };
}

// 未选中对象时禁用「移动」
function refreshMoveBtns() {
  if (moving) return;
  moveBtn.classList.toggle('btn-off', !app.activeDocument || selectedLayers().length === 0);
}

// 平移执行器：「移动」按钮与距离框里的 Enter 共用
async function runMove(dx, dy) {
  if (moving) return;
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  const sel = selectedLayers();                    // 已剔除被选中组的后代 → 父子不会各吃一次位移
  if (!sel.length) return setStatus('请先选择需要移动的图层或组');
  if (!dx && !dy) return setStatus('X、Y 距离都是 0，没有可执行的移动');

  moving = true;
  setTilesDisabled(true);
  try {
    const r = await moveLayers(sel.map((l) => l.id), dx, dy);
    if (!r.moved) setStatus('当前选择的对象无法移动（已锁定或为背景图层）');
    else if (r.skipped) setStatus(`已移动 ${r.moved} 个对象（${describeDelta(dx, dy)}），跳过 ${r.skipped} 个锁定对象`);
    else setStatus(`已移动 ${r.moved} 个对象：${describeDelta(dx, dy)}`);
  } catch (e) {
    setStatus('移动失败：' + errMsg(e));
  } finally {
    moving = false;
    setTilesDisabled(false);
  }
}

function doMove() {
  const cfg = readMoveCfg();
  if (!cfg) return setStatus('移动距离只能填数字');
  const { dx, dy } = toDelta(cfg);
  runMove(dx, dy);
}

moveBtn.addEventListener('click', () => doMove());

// X/Y 距离框：placeholder 显示灰色的 0（= 该轴不动）。
// 聚焦时把值为 0 的内容清掉，直接开始输入，不用先删掉那个 0；
// 非 0 的值保留——聚焦常常只是为了用 ↑/↓ 微调，清掉反而碍事。
// focus 不冒泡，而 sp-textfield 是包着原生 input 的自定义元素，事件未必落在外壳上，
// 所以连会冒泡的 focusin 一起听；重复触发也幂等。
[moveXInput, moveYInput].forEach((input) => {
  const clearZero = () => { if (parseDistance(input.value) === 0) input.value = ''; };
  input.addEventListener('focus', clearZero);
  input.addEventListener('focusin', clearZero);
});

// X/Y 距离框的键盘操作：Enter 直接执行一次移动；↑/↓ 加减 1，Shift 时加减 10
[moveXInput, moveYInput].forEach((input) => {
  const pillsId = input === moveXInput ? 'moveXDirPills' : 'moveYDirPills';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doMove(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = parseDistance(input.value);
    if (cur === null) return;
    // 减到负数不是错：交给 readMoveField 里的 applySign 翻方向，5 再往下减就成了「反方向 5」
    input.value = formatDist(nudgeValue(cur, e.key === 'ArrowUp', e.shiftKey));
    readMoveField(input, pillsId);
  });
});

// 方向记忆：只记方向，距离不记 —— 每次打开面板两个距离框都是空的（空 = 该轴不动）。
// 面板打开期间输入的值会留在框里，所以连点「移动」可以按同一距离累加。
setPillActive('moveXDirPills', 'data-dir', prefGet('move.xDir', 'right'));
setPillActive('moveYDirPills', 'data-dir', prefGet('move.yDir', 'down'));
bindPillGroup('moveXDirPills', 'data-dir', (d) => prefSet('move.xDir', d));
bindPillGroup('moveYDirPills', 'data-dir', (d) => prefSet('move.yDir', d));

// 回填上次的设置（首次使用即为默认：横排 / 底部对齐 / 竖排左侧对齐 / 间距 10 / 不扩画布 / 边距 10）
layoutDir = prefGet('layout.dir', 'h') === 'v' ? 'v' : 'h';
setPillActive('layoutDirPills', 'data-dir', layoutDir);
setPillActive('layoutAlignH', 'data-align', prefGet('layout.alignH', 'bottom'));
setPillActive('layoutAlignV', 'data-align', prefGet('layout.alignV', 'left'));
layoutGapInput.value = String(clampPx(prefGet('layout.gap', '10'), 10));
layoutMarginInput.value = String(clampPx(prefGet('layout.margin', '10'), 10));
updateLayoutAlignRow();

bindPillGroup('layoutDirPills', 'data-dir', (d) => {
  layoutDir = d === 'v' ? 'v' : 'h';
  prefSet('layout.dir', layoutDir);
  updateLayoutAlignRow();
});
bindPillGroup('layoutAlignH', 'data-align', (a) => prefSet('layout.alignH', a));
bindPillGroup('layoutAlignV', 'data-align', (a) => prefSet('layout.alignV', a));
layoutGapInput.addEventListener('input', () => prefSet('layout.gap', layoutGapInput.value));
layoutMarginInput.addEventListener('input', () => prefSet('layout.margin', layoutMarginInput.value));
setupSwitch('layoutExpand', prefGet('layout.expand', '0') === '1', () => {
  prefSet('layout.expand', layoutExpandEl.checked ? '1' : '0');
  updateLayoutMarginRow();
});
updateLayoutMarginRow();

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
    digits: toInt(active('digitsPills', 'data-digits'), 1),   // 位数固定可选，默认 1 位（不补零）
  };
}

// 选中层按图层面板顺序排序（编号与预览都按此序）：
// 主路：一次 batchPlay 读回 itemIndex（自面板底部向上递增 → 从上到下 = 降序）；
// 兜底：itemIndex 读不到时按 doc.layers 遍历序（UXP 面板序，首个=最上）。
// @param {boolean} [forceUp] 显式指定方向（批量建组恒用 false=从上到下）；省略则读重命名页的方向 pill
async function sortedSelectedLayers(forceUp) {
  const sel = selectedLayers();
  if (sel.length <= 1) return sel;
  const up = forceUp !== undefined
    ? forceUp
    : document.querySelector('#dirPills .pill.active')?.getAttribute('data-dir') === 'up';
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
    await action.addNotificationListener(['select'], () => {
      renderRenamePreview(); refreshLayoutBtn(); refreshMoveBtns();
    });
  } catch { /* 某些版本不触发 select 通知，靠输入/聚焦刷新 */ }
})();

// ---- 事件绑定 ----
// 同一按钮：进行中点击=停止（完成当前这张后中断）；
// 空闲点击=按勾选框决定：勾选→仅导出选中，未勾选→全部导出
sliceBtn.addEventListener('click', () => {
  if (slicing) { requestStop(); return; }
  // Symbols 方式 → 按定位格导出；完整切图 → 按「只对选中切图」决定全量/仅选中
  const run = sliceMode === 'symbols'
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
setupSwitch('splitMerge', false);

// ---- 功能页切换：四张磁贴各对应一个功能页 ----
const tiles = Array.from(document.querySelectorAll('.tile'));
function setTilesDisabled(on) {
  tiles.forEach(t => { t.style.pointerEvents = on ? 'none' : ''; t.style.opacity = on ? '0.5' : ''; });
}
function show(id, on) { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; }
function switchPage(name) {
  currentPage = name;
  tiles.forEach(t => t.classList.toggle('active', t.getAttribute('data-page') === name));
  show('sliceModeCard', name === 'slice');
  show('projectCard', name === 'slice');       // 项目名称只有切图页用得上（导出名前缀）
  show('splitIntro', name === 'split');
  show('batchPage', name === 'batch');           // 转智能对象 + 新建独立组同页并列
  show('exportConfig', name === 'slice');
  show('renamePage', name === 'rename');
  show('layoutPage', name === 'layout');
  show('sliceBtn', name === 'slice');
  show('renameBtn', name === 'rename');
  show('splitBtn', name === 'split');
  show('layoutBtn', name === 'layout');
  hideAllTips();                                 // 切页时收起可能还开着的说明气泡
  refreshLayoutBtn(true);                        // 进排版页时按当前选中数决定按钮可用性与提示
  refreshMoveBtns();
}
bindPillGroup('sliceModePills', 'data-slicemode', (m) => { sliceMode = m; });

// ---- 悬停说明：功能说明不再占版面，鼠标移到对应控件上才浮出 ----
// 提示框都设了 pointer-events:none，移出锚点即消失，不会自我遮挡。
const allTips = [];
function hideAllTips() {
  allTips.forEach((t) => { t.style.display = 'none'; });
  setTipMaskedFields(false);         // 浮层收起 / 切页：恢复被藏起来的输入框
}
/** 把一段说明挂到某个锚点元素的悬停上 */
function bindTip(anchor, tipEl, html) {
  if (!anchor || !tipEl) return;
  allTips.push(tipEl);
  // UXP 对 mouseenter/mouseleave 支持不一致，用会冒泡的 mouseover/mouseout（重复触发也幂等）
  anchor.addEventListener('mouseover', () => {
    hideAllTips();
    tipEl.innerHTML = html;
    tipEl.style.display = 'block';
    setTipMaskedFields(true);        // 必须在 hideAllTips 之后：那一步会把输入框放回来
  });
  anchor.addEventListener('mouseout', hideAllTips);
}

// 切图方式：两个 pill 各自的说明（原来的两张说明卡片已移除）
const modeTip = document.getElementById('modeTip');
const MODE_TIP = {
  all: '<b class="tip-title">完整切图</b>图层 / 组标记为<b class="tag-red">红色</b>：不切图；<br>图层 / 组标记为<b class="tag-blue">蓝色</b>：合并切图；<br>导出名称格式：「项目名称_组名_[组名…]_图层名称」；<br>名称含中文时，自动取每个字的拼音首字母组合成名称。',
  symbols: '<b class="tip-title">Symbols 切图</b>每个图标组需添加一个名为「定位格」的参考图层，并按定位格摆放图标。导出时以定位格为基准：未超出则按定位格尺寸导出；超出则自动补足空白像素，确保图标居中。「定位格」不参与切图，隐藏后仍可识别。',
};
Array.from(document.querySelectorAll('#sliceModePills .pill')).forEach((p) => {
  bindTip(p, modeTip, MODE_TIP[p.getAttribute('data-slicemode')]);
});

// 智能分割 / 批量处理：说明挂在各自标题后的问号图标上
bindTip(document.getElementById('splitInfo'), document.getElementById('splitTip'),
  '在图层面板<b>选中一个像素图层</b>（如拼合的素材图 / 多元素图层），插件自动识别其中<b>互不相连的内容块</b>，把每一块复制成<b>独立图层</b>（按从上到下、每行从左到右的顺序，依次命名为 0、1、2…）。<br>开启<b>保持元素完整</b>：同一元素内部断开的笔画 / 描边会并回同一图层（合并距离按本图自适应推导），规则排列的字符表 / 雪碧图则自动识别为网格、按格拆分不做合并。<br>关闭时严格按像素是否相连拆分——字母 i 的点会单独成一层。<br>原图层保持不变，可放心撤销。');
bindTip(document.getElementById('smartObjInfo'), document.getElementById('smartObjTip'),
  '选中一个或多个图层，点击后<b>逐个</b>转换为<b>独立智能对象</b>——绝不把多个图层合并进同一个智能对象。<br>已是智能对象的图层自动跳过；图层名称、顺序、位置、所在图层组与视觉效果保持不变；整个批量操作在历史记录中为一步，可一次撤销。');
bindTip(document.getElementById('groupInfo'), document.getElementById('groupTip'),
  '选中一个或多个图层 / 组，点击后为<b>每一个</b>对象分别新建一层父级组并把它嵌套进去——选中几个就建几个组，<b>绝不合并</b>。<br>新组<b>沿用原对象的名称</b>，建在对象原来的父级、原来的位置上：图层顺序、所在组、组内结构、名称、样式、混合模式、不透明度、蒙版与智能对象属性全部不变；整个批量操作在历史记录中为一步，可一次撤销。<br>无法处理的对象（如背景图层）会被跳过并在结果里报出，不影响其余对象。');
bindTip(document.getElementById('layoutInfo'), document.getElementById('layoutTip'),
  '在图层面板<b>选中 2 个以上</b>的图层 / 组 / 文字 / 形状 / 智能对象，点击后按<b>横向</b>或<b>竖向</b>自动排成一排：<br>顺序<b>不看图层面板</b>，而是按对象当前在画布中的实际位置——横排先从上到下识别「行」、行内从左到右；竖排先从左到右识别「列」、列内从上到下。<br><b>间距是相邻两个对象真实边缘之间的距离</b>（不是中心距），带投影/外发光的图层按主体边界算。<br>排序后的第一个对象作为<b>锚点保持原位</b>，其余依次贴过去，整批版面不会漂走。<br>只改位置：不栅格化、不合并、不改图层类型 / 尺寸 / 层级 / 组内结构，图层组整体移动。隐藏图层若被选中也参与排版并保持隐藏；<b>锁定图层会中止排版</b>并提示解锁（插件不擅自解锁）。<br>开启「自动扩展画布」后，只向真正超出的方向扩出透明画布并留出「画布边距」；整个操作在历史记录中为一步，可一次撤销。');
bindTip(document.getElementById('moveInfo'), document.getElementById('moveTip'),
  '在图层面板<b>选中一个或多个</b>图层 / 组，填好 X、Y 的方向与距离后点「移动」，所有选中对象<b>按同一个偏移量整体平移</b>——对象之间的相对位置、排列关系完全不变。<br>是<b>相对位移</b>不是绝对坐标：不需要指定左上角 / 中心点之类的基点，每个对象都从自己当前的位置起算，移动距离完全一致。<br>距离框<b>留空即为 0</b>，该轴不动；填<b>负数</b>会自动转成正数并翻转方向。框内按 <b>Enter</b> 直接执行，按 <b>↑/↓</b> 加减 1px、<b>Shift+↑/↓</b> 加减 10px。<br>数值执行后不清零，连点「移动」即可按同一距离<b>累加</b>；走过头就点一下反方向箭头再移一次。<br>选中父组和它的子图层时自动去重，只移动父组，子图层不会走出双倍距离；锁定图层与背景图层自动跳过、不影响其余对象；允许移动到画布外，<b>不会自动改变画布尺寸</b>。每次点击在历史记录中为一步，可一次撤销。');

bindTip(document.getElementById('renameInfo'), document.getElementById('renameTip'),
  '在图层面板<b>选中若干图层 / 组</b>，四种方式改名，改动<b>只作用于选中项本身</b>（选中组时改的是组名，不会进组里动子图层）：<br><b>替换</b>——把原名里的「查找内容」换成新文字，没匹配到的原样不动；<b>重新命名</b>——整个名称直接换掉；<b>加前缀 / 加后缀</b>——在原名前后拼接。<br>打开<b>启用编号 n</b> 后，模板里<b>单独的字母 n</b> 会被替换成连续数字（Button、Icon 里的 n 不算）；可设起始值、递增量、数字位数（不足补 0），以及沿图层面板<b>从上到下</b>还是<b>从下到上</b>编号。<br>下方<b>预览</b>实时显示「原名称 → 新名称」，重名会标出<b class="tag-red">⚠同名</b>；新旧名相同、替换后为空、未匹配到的行都不会写回 PS。');

tiles.forEach((t) => t.addEventListener('click', () => {
  if (slicing || splitting || converting || grouping || laying || moving) return;  // 任务进行中不切页
  const page = t.getAttribute('data-page');
  if (page) switchPage(page);
}));
switchPage('rename');                            // 初始进入重命名页（磁贴行的第一个）

// ---- 导出设置：格式 / 倍率 自绘下拉 + 位置（真实生效的可操作控件）----
// 点框体展开菜单，点选项收起并写回显示值；同一时刻只开一个。
// 不用 e.target.closest（UXP DOM 未必提供），改用「冒泡顺序 + 标志位」判断点击来源：
// 选项 handler → 下拉框 handler → document handler，前者置位后者据此让路。
let ddItemClicked = false;      // 本次点击命中了某个选项
let ddBoxClicked = false;       // 本次点击落在某个下拉框内
function bindDropdown(ddId, valueId) {
  const dd = document.getElementById(ddId);
  const valueEl = document.getElementById(valueId);
  if (!dd || !valueEl) return;
  const items = Array.from(dd.querySelectorAll('.dd-item'));
  items.forEach((item) => item.addEventListener('click', () => {
    items.forEach((q) => q.classList.remove('active'));
    item.classList.add('active');
    valueEl.textContent = item.textContent;
    dd.classList.remove('open');
    ddItemClicked = true;
  }));
  dd.addEventListener('click', () => {
    ddBoxClicked = true;
    if (ddItemClicked) { ddItemClicked = false; return; }   // 选项已处理，别再切换开合
    const wasOpen = dd.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) dd.classList.add('open');
  });
}
function closeAllDropdowns() {
  Array.from(document.querySelectorAll('.dropdown')).forEach((d) => d.classList.remove('open'));
}
bindDropdown('formatDd', 'formatValue');
bindDropdown('scaleDd', 'scaleValue');
// 点面板其它地方收起下拉
document.addEventListener('click', () => {
  if (ddBoxClicked) { ddBoxClicked = false; return; }
  closeAllDropdowns();
});
function currentFormat() {
  const a = document.querySelector('#formatDd .dd-item.active');
  return a ? a.getAttribute('data-format') : 'png';
}
function currentScale() {
  const a = document.querySelector('#scaleDd .dd-item.active');
  return a ? (parseFloat(a.getAttribute('data-scale')) || 1) : 1;   // 支持 0.25/0.5 小数倍率
}
// 导出位置：点文件夹图标预选并记住，导出时直接使用（不再每次弹窗）
const pickFolderBtn = document.getElementById('pickFolderBtn');
const exportPathText = document.getElementById('exportPathText');
const folderIco = document.getElementById('folderIco');
const pathTip = document.getElementById('pathTip');
let selectedFolderPath = '';                      // 完整路径，只用于悬停提示

// 记住导出位置：仅本次会话记住（重开插件回到未设置状态，导出位置为空）
// 框内空间只够放缩略名，所以用文件夹名顶掉图标，完整路径靠悬停提示。
function rememberFolder(folder) {
  selectedFolder = folder;
  selectedFolderPath = folder.nativePath || '';
  exportPathText.textContent = folder.name || '已选择';
  exportPathText.style.display = '';
  folderIco.style.display = 'none';
}

pickFolderBtn.addEventListener('click', async () => {
  try { const f = await uxpFs.getFolder(); if (f) rememberFolder(f); } catch { /* 用户取消：保持原状 */ }
});

// 悬停「位置」框：浮出完整路径；未设置时提示去点它
pickFolderBtn.addEventListener('mouseover', () => {
  if (!pathTip) return;
  pathTip.textContent = selectedFolderPath || '尚未设置导出位置，点击选择文件夹';
  pathTip.style.display = 'block';
});
pickFolderBtn.addEventListener('mouseout', () => {
  if (pathTip) pathTip.style.display = 'none';
});

// 顶栏版本号：始终显示 manifest 中的真实版本
const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = 'v' + manifest.version;

renderRenamePreview();                                // 初始渲染一次
updateSliceLabel();                                    // 初始化主按钮文字
refreshLayoutBtn();                                    // 初始化排版按钮可用性
refreshMoveBtns();                                     // 初始化平移按钮可用性
setStatus('插件已加载');
