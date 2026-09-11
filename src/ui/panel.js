// 面板入口：把纯逻辑（traversal/naming）与 PS 封装（layer-tree/exporter/renamer）接到 UI。
// 由 esbuild 打包（本地模块内联，photoshop/uxp 作为宿主注入保持 external）。
import { walk, filterTasksBySelection } from '../lib/traversal.js';
import { findSymbols } from '../lib/symbols.js';
import { buildBaseName, makeUniqueName } from '../lib/naming.js';
import { normalize } from '../lib/normalize.js';
import { readDocumentTree } from '../ps/layer-tree.js';
import { exportTask, exportSymbol, beginExport, endExport } from '../ps/exporter.js';
import { hasCounter, buildRenameRows } from '../lib/rename-core.js';
import { matchLayers, describePath } from '../lib/search-core.js';
import { readItemIndexes, applyRename } from '../ps/renamer.js';
import { readAllLayers, selectLayersById } from '../ps/layer-finder.js';
import { smartSplitLayer, splitByGuides } from '../ps/smart-split.js';
import {
  planResize, normalizeResizeCfg, fieldsOfMode, buildOutName, formatScale,
  sanitizeFileName, ellipsizeName, splitName, isSupportedImage, parseScaleList, FITS,
  sizeCfg, sizeLabel, normalizeSizeList,
} from '../lib/resize-core.js';
import {
  collectImageFiles, parentFolderOf, closeStrayResizeDocs, processOne, revealFolder,
} from '../ps/resizer.js';
import { extOf } from '../ps/save-image.js';
import { cellsFromGuides, ERR_NO_GUIDES } from '../lib/guide-split.js';
import { convertToSmartObjects } from '../ps/smart-object.js';
import { createGroups } from '../ps/group-maker.js';
import { layoutLayers } from '../ps/layouter.js';
import { moveLayers } from '../ps/mover.js';
import { validateParams, buildTable, computeLayout } from '../lib/table-core.js';
import { originAtCenter, isPlausibleCenter } from '../lib/view-core.js';
import { drawTable, readForegroundHex, pickColor, readViewCenter } from '../ps/table-maker.js';
import { parseDistance, dirAxes, planMove, nudgeValue, formatDist, describeDelta } from '../lib/move-core.js';
import {
  normalizeCfg, computeGuides, quickGuides, cfgFromGuideLayout,
  guideLayoutKeys, unknownGuideLayoutKeys, formatGuideLayoutParams,
  signatureOf, pushRecent, describeCfg, describeRecord, formatCanvas,
  inferCfgFromGuides, sameGuides,
} from '../lib/guide-core.js';
import {
  hasDoc, readCanvas, applyGuides, clearGuides, readResolution, readExistingGuides,
  openGuideLayoutDialog, applyGuideLayout, onGuideLayoutCreated,
  readGuidesVisible, readGuidesLocked, toggleGuidesVisible, toggleGuidesLock,
} from '../ps/guides.js';
import manifest from '../manifest.json';

const { app, action, core } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

const statusEl = document.getElementById('status');
function setStatus(msg) { statusEl.textContent = msg; }

// ---- 输入框的通用行为（面板里每个 input[type=text] 都走这一套）----
// 1) 聚焦时给【外层那个画边框的 div】加 .focused：边框高亮，退出即还原。
//    UXP 下 :focus-within 靠不住（文字编辑是原生层，焦点不一定传到 DOM 上），
//    样式表里那条留着当降级，真正生效的是这个类。
// 2) 点进去就把框清空，不用先删旧值；原值挪到 placeholder 当灰字，全程看得见。
//    退出时框里还是空的 → 把原值放回去；输了新值 → 就按新值。
// ⚠️ 清空只改 DOM，【不派发 input 事件】—— 派了就等于告诉各处「用户把值删空了」，
//    预览会退化、记忆会被写空。代价是「正在编辑、还没输东西」这段时间里框里是空的，
//    所以读值一律走 fieldValue()，别直接读 .value（万一 blur 没来也不会读成空）。
const fieldPrev = new Map();        // 输入框 → 聚焦那一刻的原值（退出即删）
const fieldHolder = new Map();      // 输入框 → 聚焦前的 placeholder（退出时还回去）

/** 读输入框的值：正在编辑且还没输东西时，返回它聚焦前的原值 */
function fieldValue(el) {
  const v = String((el && el.value) ?? '');
  if (v !== '') return v;
  return fieldPrev.has(el) ? fieldPrev.get(el) : v;
}

/** 代码主动给输入框写值（预填弹窗、编辑已有查找项）：连暂存的原值一起换掉，
 *  否则退出输入框时会被旧值盖回去 */
function fieldSet(el, v) { fieldClear(el); el.value = String(v ?? ''); }

/** 代码主动清空一个输入框（如「清空关键词」）：连暂存的原值一起丢掉，
 *  否则退出输入框时那个原值又被放回来了 */
function fieldClear(el) {
  if (!el) return;
  restoreHolder(el);
  fieldPrev.delete(el);
  el.value = '';
}

/** 把聚焦时借用的 placeholder 还回去（没借过就什么都不做） */
function restoreHolder(el) {
  if (!fieldHolder.has(el)) return;
  const hold = fieldHolder.get(el);
  fieldHolder.delete(el);
  el.placeholder = hold;
  el.setAttribute('placeholder', hold);
}

function bindTextField(el) {
  if (!el) return;
  const box = el.parentNode;                       // 画边框的是外层 div，不是 input
  const enter = () => {
    if (box && box.classList) box.classList.add('focused');
    if (fieldPrev.has(el)) return;                 // focus 与 focusin 都会来，只认第一次
    const cur = String(el.value ?? '');
    fieldPrev.set(el, cur);
    if (cur === '') return;                        // 本来就是空的：placeholder 不用借
    fieldHolder.set(el, el.getAttribute('placeholder') || '');
    el.value = '';
    el.placeholder = cur;                          // 原值改用灰字显示，退出前一直看得见
    el.setAttribute('placeholder', cur);
  };
  const leave = () => {
    if (box && box.classList) box.classList.remove('focused');
    if (!fieldPrev.has(el)) return;
    const prev = fieldPrev.get(el);
    fieldPrev.delete(el);
    restoreHolder(el);
    if (String(el.value ?? '') !== '') return;     // 输了新值：就按新值，别覆盖
    el.value = prev;                               // 没改动：把原值放回去
  };
  // focus/blur 不冒泡，为保险连会冒泡的 focusin/focusout 一起听；重复触发也幂等
  el.addEventListener('focus', enter);
  el.addEventListener('focusin', enter);
  el.addEventListener('blur', leave);
  el.addEventListener('focusout', leave);
}

// 面板里所有的文字输入框。新加输入框必须往这里补一个 id ——
// ui-ids.test.js 会拿 index.html 里的 <input type="text"> 逐个比对，漏了就红。
const TEXT_FIELDS = [
  'projectName', 'moveX', 'moveY', 'layoutGap', 'layoutMargin',
  'tblW', 'tblH', 'tblRows', 'tblCols', 'tblRowGap', 'tblColGap',
  'tblLineW', 'tblRadius', 'tblLineColor', 'tblFillColor',
  'rzW', 'rzH', 'rzEdge', 'rzPercent', 'rzTimes', 'rzMaxW', 'rzMaxH',
  'rzAddW', 'rzAddH', 'rzScales', 'rzQuality', 'rzSuffix', 'rzTpl',
  'findText', 'templateText', 'startNum', 'stepNum',
  'gdNameInput', 'rzNameInput', 'slFindText',
];

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

// 图层面板里【真正点亮】的那些图层/组（异步：要读文档描述符）。
// ⚠️ doc.activeLayers 在这件事上靠不住：选中一个【组】时它把组内所有后代一起返回，
//    于是「只选了组」和「组与组内某层都点亮了」长得一模一样。文档描述符上的
//    targetLayersIDs 没这个毛病 —— 真机实测（PS 27.7.0）只选组 G 报 1 项、
//    「G + G 内部的层」报 2 项、「G + 嵌套组里的孙子层」也是 2 项，从不把没点亮的
//    子层算进来。重命名要的正是这份「用户到底点了谁」。
// 旧版 PS 没有这个属性时退回 selectedLayers()，也就是「选中组只改组名」。
async function trueSelectedLayers() {
  const doc = app.activeDocument;
  if (!doc) return [];
  let list;
  try {
    const [res] = await action.batchPlay([{
      _obj: 'get',
      _target: [{ _property: 'targetLayersIDs' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
      _options: { dialogOptions: 'dontDisplay' },
    }], {});
    list = res?.targetLayersIDs;
  } catch { /* 读不到，按下面的兜底走 */ }
  if (!Array.isArray(list)) return selectedLayers();
  // 列表项是图层引用，序列化形态各版本不一（{_ref,_id} / {_id} / 裸数字），三种都收
  const byId = new Map();
  (function walk(cont) {
    for (const l of cont.layers || []) { byId.set(l.id, l); walk(l); }
  })(doc);
  const out = [];
  for (const item of list) {
    const id = typeof item === 'number' ? item : (item?._id ?? item?._value);
    const l = byId.get(id);
    if (l) out.push(l);
  }
  return out;
}

// 当前文档中选中的图层/组（同步读取）。
// 只保留"最外层被选中"的项：选中组时排除其组内子图层。
// 用于把组当成一个整体处理的功能（切图 / 排版 / 平移 / 建组）——父子各算一次会重复作用。
// 重命名不走这条（它要区分「点没点亮组内的层」），见 trueSelectedLayers。
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
let currentPage = 'rename';              // 当前功能页：与功能栏 .tile 的 data-page 一一对应（初始由 switchPage 定）
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
    showOverlay(stopConfirm, false);       // 结束时收起确认块
    showOverlay(overwriteConfirm, false);
    escPause = false;
    pauseDecider = null;
    overwriteDecider = null;
    overwriteAll = null;
  }
}

// 弹出"同名文件"确认，返回 'overwrite' | 'skip' | 'overwriteAll' | 'skipAll'
function askOverwrite(name, ext) {
  document.getElementById('overwriteName').textContent = `${name}.${ext}`;
  showOverlay(overwriteConfirm, true);
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
  showOverlay(stopConfirm, true);
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
  const projectRaw = fieldValue(projectInput);
  const project = normalize(projectRaw) ? projectRaw : '';

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
  const ps = { docId: app.activeDocument.id };
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
        // 不拼 PSD 名：文件名只由「项目名（可选）+ 各级组名 + 图层名」组成，
        // 完整切图与 Symbols 切图同一套规则、没有例外。
        // 唯一会一段都不剩的情况是「定位格直接放在画布根」的 Symbols 导出（路径为空），
        // 此时既没有组名也没有图层名 —— 用固定的 symbol 收口，仍然不掺 PSD 名。
        const segments = [project, ...task.pathSegments].filter(s => s !== '' && s != null);
        const base = buildBaseName(segments.length ? segments : ['symbol']);
        currentName = makeUniqueName(base, used);
        currentDeduped = currentName !== base;
      }

      // 目标文件夹已存在同名文件 → 询问覆盖/跳过（"全部"决定记忆到本次运行结束）
      if (existingFiles.has(currentName.toLowerCase())) {
        let action = overwriteAll;
        if (!action) {
          const d = await askOverwrite(currentName, ext);
          showOverlay(overwriteConfirm, false);
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
        showOverlay(stopConfirm, false);
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

// ---- 参考线分割：用画布上已有的参考线把内容切成网格，每格复制成一个独立图层 ----
const gsBtn = document.getElementById('gsBtn');
// 超过这么多块先问一句：每块都要走一轮「选区 → copy → paste → 跨文档 duplicate」，块多了很慢
const GS_WARN_CELLS = 40;
let gsDecider = null;

/** 现读当前文档的参考线并算出网格（参考线是随手拖的，没有通知可听，所以每次都现读） */
function readGuideGrid() {
  const canvas = hasDoc() ? readCanvas() : null;
  if (!canvas) {
    return { canvas: null, guides: null, cells: [], cols: 0, rows: 0, error: '请先打开一个 Photoshop 文档。' };
  }
  const guides = readExistingGuides();
  return { canvas, guides, ...cellsFromGuides(guides, canvas) };
}

/** 标题行右侧的小字（切出几块）+ 按钮可用性 */
function refreshGuideSplitInfo() {
  const g = readGuideGrid();
  const el = document.getElementById('gsGrid');
  if (el) {
    el.textContent = !g.canvas ? '未打开文档'
      : g.error === ERR_NO_GUIDES ? '没有参考线'
        : g.error ? '参考线未切开画布'
          : `${g.cols} 列 × ${g.rows} 行 → ${g.cells.length} 块`;
  }
  gsBtn.classList.toggle('btn-off', !!g.error);
  return g;
}

function askGuideSplitConfirm(count) {
  document.getElementById('gsCellCount').textContent = String(count);
  showOverlay('gsConfirm', true);
  return new Promise((res) => { gsDecider = res; });
}
function resolveGuideSplitConfirm(v) {
  showOverlay('gsConfirm', false);
  if (gsDecider) { const d = gsDecider; gsDecider = null; d(v); }
}
document.getElementById('gsConfirmYes').onclick = () => resolveGuideSplitConfirm(true);
document.getElementById('gsConfirmNo').onclick = () => resolveGuideSplitConfirm(false);

async function runGuideSplit() {
  if (splitting) return;                         // 两个分割功能共用忙碌标志，不能同时跑
  const g = refreshGuideSplitInfo();             // 点的这一刻的参考线才算数
  if (g.error) return setStatus(g.error);

  const merged = document.getElementById('gsMerged').checked;
  let layer = null;
  if (!merged) {
    // 取最外层选中项：选中组时组内子层不重复参与（拍平的是整组）
    const sel = selectedLayers();
    if (!sel.length) return setStatus('请先在图层面板选中要分割的图层 / 组，或打开「合并可见内容」');
    if (sel.length > 1) return setStatus('一次只分割一个对象，请只选中一个图层 / 组');
    layer = sel[0];
  }
  if (g.cells.length > GS_WARN_CELLS) {
    const ok = await askGuideSplitConfirm(g.cells.length);
    if (!ok) return setStatus('已取消，文档没有任何改动。');
  }

  splitting = true;
  setTilesDisabled(true);
  const lbl = gsBtn.querySelector('.btn-label');
  const orig = lbl.textContent;
  lbl.textContent = '分割中…';
  gsBtn.style.pointerEvents = 'none';
  gsBtn.style.opacity = '0.6';
  let lastStep = '尚未开始';
  setStatus(`正在按参考线分割：${g.cols} 列 × ${g.rows} 行…`);
  try {
    const r = await splitByGuides({
      layerId: layer ? layer.id : null,
      merged,
      guides: g.guides,
      canvas: g.canvas,
      groupName: merged ? '参考线切片' : `${layer.name} 切片`,
      onStep: (msg) => { lastStep = msg; },
      onProgress: (done, total) => setStatus(`分割中… ${done}/${total} 块`),
    });
    if (!r.created) {
      setStatus(`没有切出图层：${r.cells} 块里没有一块有内容\n（最后一步：${lastStep}）`);
    } else {
      setStatus(`完成：${r.cols} 列 × ${r.rows} 行 = ${r.cells} 块`
        + (r.skipped ? `，跳过 ${r.skipped} 块空白` : '')
        + `，已新建 ${r.created} 个图层${r.grouped ? '并放进新组' : ''}`
        + (r.fixed ? `（校正落位 ${r.fixed} 层）` : '')
        + '\n原对象未改动');
    }
  } catch (e) {
    setStatus(`分割失败：${errMsg(e)}\n（最后成功的一步：${lastStep}）`);
  } finally {
    splitting = false;
    setTilesDisabled(false);
    lbl.textContent = orig;
    gsBtn.style.pointerEvents = '';
    gsBtn.style.opacity = '';
    refreshGuideSplitInfo();
  }
}

gsBtn.addEventListener('click', () => { runGuideSplit(); });

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
  const layers = await sortedByPanelOrder(selectedLayers(), false);
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
// 光靠父级 pointer-events:none 挡不住输入框（UXP 下文字控件自成一层），再显式加 disabled
function updateLayoutMarginRow() {
  const off = !layoutExpandEl.checked;
  layoutMarginRow.classList.toggle('row-off', off);
  if (off) layoutMarginInput.setAttribute('disabled', '');
  else layoutMarginInput.removeAttribute('disabled');
}

// UXP 已知问题：具备文字编辑能力的控件恒绘制在所有 DOM 之上，z-index 无效
// （换成普通 <input> 同样如此，是原生编辑层的问题）。官方给的解法就是浮层出现时把它藏起来。
// ⚠️ 必须设在输入框元素自身：设在父级容器上不生效，原生编辑层不继承父级可见性。
// 用 visibility 而非 display —— 占位保留，行高不跳、鼠标不会因为布局位移而反复进出。
// 同一时刻只有一个功能页可见，所以不分页、一律全藏，省掉「这个提示压着哪几个框」的判断。
const TIP_MASKED_FIELD_IDS = [
  'layoutGap', 'layoutMargin', 'moveX', 'moveY',      // 一键排版 / 快速平移
  'findText', 'templateText', 'startNum', 'stepNum',  // 批量重命名
  'tblRows', 'tblCols', 'tblW', 'tblH', 'tblRowGap', 'tblColGap',   // 快速绘制表格
  'tblLineW', 'tblLineColor', 'tblFillColor', 'tblRadius',
  'rzW', 'rzH', 'rzEdge', 'rzPercent', 'rzTimes', 'rzMaxW', 'rzMaxH',   // 批量改尺寸
  'rzQuality', 'rzSuffix', 'rzTpl', 'rzAddW', 'rzAddH', 'rzScales',
];
// 「按名称查找图层」弹窗是否开着：它自己带输入框，开着期间页面上的输入框必须一直藏着
let slOpen = false;
let tipMaskOn = false;      // 悬停说明浮层开着
let ddMaskOn = false;       // 自绘下拉的菜单开着
let ovMaskOn = false;       // 任何一个弹窗开着（由 showOverlay 现算，见下）
function setTipMaskedFields(on) {
  tipMaskOn = on;
  applyMaskedFields();
}
// 下拉菜单也得藏：改尺寸页的菜单向下展开，正压在宽度 / 高度那几个输入框上
//（真机截图确认：菜单被输入框切掉一半）。原生编辑层的老毛病，只能躲。
function setDdMaskedFields(on) {
  ddMaskOn = on;
  applyMaskedFields();
}
function applyMaskedFields() {
  const v = tipMaskOn || ddMaskOn || slOpen || ovMaskOn ? 'hidden' : '';
  for (const id of TIP_MASKED_FIELD_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.visibility = v;
  }
}

// ---- 浮层的显隐都走这里 ----
// ⚠️ UXP 的原生滚动条和文字编辑控件是一个毛病：恒画在所有 DOM 之上，z-index 管不着。
// 页面里任何一个能滚的盒子，它的滚动条都会【横穿弹窗】（真机截图确认）。所以浮层期间
// 把它们的 overflow 一律关掉 —— 滚动条随之消失，而弹窗后面本来也不该滚。
// 要关的是【页面侧】的滚动盒：内容列、功能栏，以及重命名页那个限高 240px 的预览框。
// 弹窗自己内部的滚动盒（.gd-list / .sl-list / .sl-groups）不能关，它们是弹窗的一部分。
// 锁定状态从「有没有浮层还开着」现算，不用计数器：改名弹窗是压在版面记录弹窗上面开的，
// 关掉上面那个时下面那个还在，布尔开关会提前解锁。
const OVERLAY_IDS = [
  'stopConfirm', 'tableConfirm', 'overwriteConfirm', 'gsConfirm',
  'gdListOverlay', 'gdNameOverlay', 'gdHistConfirm', 'slOverlay',
  'rzPresetOverlay', 'rzNameOverlay', 'rzFailOverlay',
];
const SCROLL_LOCK_IDS = ['pages', 'rail', 'previewList', 'rzLog'];
/** @param {string|object} idOrEl 浮层的 id 或元素 */
function showOverlay(idOrEl, on) {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  if (el) el.style.display = on ? 'flex' : 'none';
  // 只认 'flex'：显示浮层只走这一个值，比反过来排除 'none' / 空串更不容易看错
  const anyOpen = OVERLAY_IDS.some((id) => {
    const o = document.getElementById(id);
    return !!o && o.style.display === 'flex';
  });
  for (const id of SCROLL_LOCK_IDS) {
    const box = document.getElementById(id);
    // 锁用 overflow 简写（连横向一起关，长图层名不至于甩出一条横滚动条）；
    // 解锁写空串还给样式表，别硬写 'auto' —— 各家的原值不一样（有的只 overflow-y）
    if (box) box.style.overflow = anyOpen ? 'hidden' : '';
  }
  // 页面上的输入框也得躲开：文字控件与滚动条是同一个毛病，弹窗一开就压在弹窗上面
  //（真机截图确认：「我的预设」弹窗被下面那页的宽度 / 高度输入框戳穿）。
  // 弹窗自带的输入框不在 TIP_MASKED_FIELD_IDS 里，不受影响。
  ovMaskOn = anyOpen;
  applyMaskedFields();
}

function readLayoutCfg() {
  return {
    direction: layoutDir,
    align: activePill(layoutDir === 'h' ? 'layoutAlignH' : 'layoutAlignV', 'data-align'),
    gap: clampPx(fieldValue(layoutGapInput), 10),
    expandCanvas: !!layoutExpandEl.checked,
    margin: clampPx(fieldValue(layoutMarginInput), 10),
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

// ---- 快速平移：所有选中对象朝同一个方向整体平移（相对位移，不是绝对坐标）----
// 方向从九宫格里挑一个（八方向），距离框按方向显隐：正向一个值，斜向水平 + 垂直两个值。
// 换算全在 lib/move-core.js（有单测），这里只做「读界面 → 调换算 → 交给 PS」。
const moveBtn = document.getElementById('moveBtn');
const moveBtnLabel = document.getElementById('moveBtnLabel');
const moveXInput = document.getElementById('moveX');
const moveYInput = document.getElementById('moveY');
const moveCopyEl = document.getElementById('moveCopy');
let moving = false;

const moveDir = () => activePill('moveDirPills', 'data-dir') || 'right';

// 读一个距离输入框：空 → 0（该轴不动）；非数字 → 标红并返回 null（不执行）
function readMoveField(input) {
  const box = input.parentNode;                    // 外层 .num-box；UXP 的 closest 不一定有，用 parentNode
  const raw = parseDistance(fieldValue(input));
  if (raw === null) { if (box) box.classList.add('field-err'); return null; }
  if (box) box.classList.remove('field-err');
  return raw;
}

/**
 * 读界面 → 位移量。顺手把负数归一回界面上：
 * 负值会把对应那一个轴翻向（→ 填 -20 变成 ← 20），九宫格跟着点亮对面那一格，
 * 框里回填正数 —— 用户看到的永远是「方向 + 正数」。
 * @returns {{dx:number, dy:number}|null} null = 有框填了非数字
 */
function readMoveDelta() {
  const x = readMoveField(moveXInput);
  const y = readMoveField(moveYInput);
  if (x === null || y === null) return null;
  const r = planMove(moveDir(), x, y);
  if (r.dir !== moveDir()) { setPillActive('moveDirPills', 'data-dir', r.dir); prefSet('move.dir', r.dir); }
  // 留空的框保持空（空 = 0，不要写成 "0" 平添噪音）；有值则回填归一后的正数
  if (String(moveXInput.value).trim() !== '') moveXInput.value = formatDist(r.xDist);
  if (String(moveYInput.value).trim() !== '') moveYInput.value = formatDist(r.yDist);
  return { dx: r.dx, dy: r.dy };   // 翻向只翻符号不改「要填几个值」，两行的显隐不用跟着动
}

// 方向决定要填几个值：← → 只要水平，↑ ↓ 只要垂直，四个斜向两个都要。
// 用不到的那一行直接收起来 —— 它的值在 planMove 里也会被置 0，界面和结果对得上。
function refreshMoveRows() {
  const axes = dirAxes(moveDir());
  show('moveXRow', axes.x);
  show('moveYRow', axes.y);
}

// 未选中对象时禁用按钮；按钮文案跟着「复制移动」开关走
function refreshMoveBtns() {
  if (moving) return;
  moveBtn.classList.toggle('btn-off', !app.activeDocument || selectedLayers().length === 0);
  if (moveBtnLabel) moveBtnLabel.textContent = moveCopyEl && moveCopyEl.checked ? '复制并平移' : '快速平移';
}

// 平移执行器：按钮与距离框里的 Enter 共用
async function runMove(dx, dy) {
  if (moving) return;
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  const sel = selectedLayers();                    // 已剔除被选中组的后代 → 父子不会各吃一次位移
  if (!sel.length) return setStatus('请先选择需要移动的图层或组');
  if (!dx && !dy) return setStatus('还没填移动距离');
  const copy = !!(moveCopyEl && moveCopyEl.checked);

  moving = true;
  setTilesDisabled(true);
  try {
    const r = await moveLayers(sel.map((l) => l.id), dx, dy, { copy });
    const verb = copy ? '复制并移动' : '移动';
    if (!r.moved) setStatus(`当前选择的对象无法${verb}（已锁定或为背景图层）`);
    else if (r.skipped) setStatus(`已${verb} ${r.moved} 个对象（${describeDelta(dx, dy)}），跳过 ${r.skipped} 个锁定对象`);
    else setStatus(`已${verb} ${r.moved} 个对象：${describeDelta(dx, dy)}`);
  } catch (e) {
    setStatus(`${copy ? '复制移动' : '移动'}失败：` + errMsg(e));
  } finally {
    moving = false;
    setTilesDisabled(false);
    refreshMoveBtns();
  }
}

function doMove() {
  const d = readMoveDelta();
  if (!d) return setStatus('移动距离只能填数字');
  runMove(d.dx, d.dy);
}

moveBtn.addEventListener('click', () => doMove());

// 距离框的键盘操作：Enter 直接执行一次平移；↑/↓ 加减 1，Shift 时加减 10。
// ↑/↓ 读的是 fieldValue：点进框时值被清空挪进了灰字（见 bindTextField），
// 直接读 .value 会从 0 开始跳，读原值才是接着刚才那个数微调
[moveXInput, moveYInput].forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doMove(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = parseDistance(fieldValue(input));
    if (cur === null) return;
    // 减到负数不是错：交给 readMoveDelta 里的 planMove 翻那一轴，5 再往下减就成了「反方向 5」
    input.value = formatDist(nudgeValue(cur, e.key === 'ArrowUp', e.shiftKey));
    readMoveDelta();
  });
});

// 方向记忆：只记方向，距离不记 —— 每次打开面板两个距离框都是空的（空 = 不动）。
// 面板打开期间输入的值会留在框里，所以连点按钮可以按同一距离累加。
// 「复制移动」故意不记忆：它会凭空多出图层，每次打开都从关着开始更稳妥。
setPillActive('moveDirPills', 'data-dir', prefGet('move.dir', 'right'));
bindPillGroup('moveDirPills', 'data-dir', (d) => { prefSet('move.dir', d); refreshMoveRows(); });
setupSwitch('moveCopy', false, refreshMoveBtns);
refreshMoveRows();
// 平移从「批量处理」页拆出来独立成页后，旧版按轴分开记的方向没有对应控件了，清掉
try { localStorage.removeItem('move.xDir'); localStorage.removeItem('move.yDir'); } catch { /* 不支持则算了 */ }

// ---- 快速绘制表格：按行列与尺寸生成可继续编辑的矢量形状网格 ----
// 全部几何在 lib/table-core.js（有单测），这里只做「读界面 → 调几何 → 交给 PS」。
const tableBtn = document.getElementById('tableBtn');
const TBL_FIELDS = ['tblRows', 'tblCols', 'tblW', 'tblH', 'tblRowGap', 'tblColGap',
  'tblLineW', 'tblLineColor', 'tblFillColor', 'tblRadius'];
const tbl = {};
for (const id of TBL_FIELDS) tbl[id] = document.getElementById(id);
let drawing = false;
let tableDecider = null;                          // 性能提醒的 Promise resolver

// 多选 pill 组：每个 pill 独立开关，不互斥（结构那三个开关用）
function bindTogglePills(containerId, onChange) {
  const box = document.getElementById(containerId);
  if (!box) return;
  Array.from(box.querySelectorAll('.pill')).forEach((p) => {
    p.addEventListener('click', () => { p.classList.toggle('active'); if (onChange) onChange(); });
  });
}
const pillOn = (containerId, attr, value) => {
  const el = document.querySelector(`#${containerId} .pill[${attr}="${value}"]`);
  return !!(el && el.classList.contains('active'));
};
const setPillOn = (containerId, attr, value, on) => {
  const el = document.querySelector(`#${containerId} .pill[${attr}="${value}"]`);
  if (el) el.classList.toggle('active', !!on);
};

const numOr = (v, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? n : dflt; };
const intOr = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };

// 本页输入框的取值模型：【真值存在 tblState 里，输入框本身常态是空的，当前值以
// placeholder（灰色提示）显示】。点进去直接敲数字，不用先删；没敲就走开，真值原样保留。
//
// 这么设计的关键理由：不依赖 blur 事件。把「提交」放在 input 上（每敲一下就写进
// tblState），blur 就只剩「把框清空、恢复灰字」这点纯装饰工作，漏了也不丢数据。
//
// 一律走 tblVal 取值，别直接读 .value —— 正在输入时值在框里，其余时候值在 tblState 里。
const tblState = {};

const tblVal = (id) => {
  const v = String(tbl[id].value ?? '').trim();
  return v !== '' ? v : (tblState[id] ?? '');
};

/** 写入一个值：存进 tblState，用灰字显示，输入框清空等着接收输入 */
function setTblValue(id, v) {
  const s = String(v);
  tblState[id] = s;
  const el = tbl[id];
  el.value = '';
  el.placeholder = s;
  el.setAttribute('placeholder', s);              // 属性/特性两头都设，稳一点
}

function readTableCfg() {
  return {
    rows: intOr(tblVal('tblRows'), 0),
    cols: intOr(tblVal('tblCols'), 0),
    sizeMode: activePill('tblSizeModePills', 'data-mode') || 'cell',
    // 「宽/高」两个框在两种尺寸方式下复用，含义随方式变化
    cellW: numOr(tblVal('tblW'), 0), cellH: numOr(tblVal('tblH'), 0),
    totalW: numOr(tblVal('tblW'), 0), totalH: numOr(tblVal('tblH'), 0),
    rowGap: numOr(tblVal('tblRowGap'), 0), colGap: numOr(tblVal('tblColGap'), 0),
    lineWidth: numOr(tblVal('tblLineW'), 0),
    lineColor: tblVal('tblLineColor'),
    radius: numOr(tblVal('tblRadius'), 0),
    border: pillOn('tblStructPills', 'data-flag', 'border'),
    hLines: pillOn('tblStructPills', 'data-flag', 'hLines'),
    vLines: pillOn('tblStructPills', 'data-flag', 'vLines'),
    fillCells: !!document.getElementById('tblFill').checked,
    fillColor: tblVal('tblFillColor'),
    output: activePill('tblOutputPills', 'data-out') || 'single',
  };
}

function writeTableCfg(c) {
  setTblValue('tblRows', c.rows ?? 3);
  setTblValue('tblCols', c.cols ?? 3);
  setTblValue('tblW', c.cellW ?? 100);
  setTblValue('tblH', c.cellH ?? 100);
  setTblValue('tblRowGap', c.rowGap ?? 0);
  setTblValue('tblColGap', c.colGap ?? 0);
  setTblValue('tblLineW', c.lineWidth ?? 1);
  setTblValue('tblLineColor', c.lineColor || '#000000');
  setTblValue('tblFillColor', c.fillColor || '#cccccc');
  setTblValue('tblRadius', c.radius ?? 0);
  setPillActive('tblSizeModePills', 'data-mode', c.sizeMode || 'cell');
  setPillActive('tblOutputPills', 'data-out', c.output || 'single');
  setPillOn('tblStructPills', 'data-flag', 'border', c.border !== false);
  setPillOn('tblStructPills', 'data-flag', 'hLines', c.hLines !== false);
  setPillOn('tblStructPills', 'data-flag', 'vLines', c.vLines !== false);
  const fillEl = document.getElementById('tblFill');
  fillEl.checked = !!c.fillCells;
  fillEl.classList.toggle('on', !!c.fillCells);
}

// 整份配置存成一个 JSON —— 项目多达二十来个，逐个建 key 不值当
function saveTableCfg() {
  try { prefSet('table.cfg', JSON.stringify(readTableCfg())); } catch { /* 不支持则不记忆 */ }
}
function loadTableCfg() {
  let c = {};
  try { c = JSON.parse(prefGet('table.cfg', '{}')) || {}; } catch { c = {}; }
  writeTableCfg(c);
  if (!c.lineColor) setTblValue('tblLineColor', readForegroundHex() || '#000000');
}

// 色块跟着 hex 输入实时变色；填错就显示成透明并标红
function refreshSwatch(inputId, swatchId) {
  const v = String(tblVal(inputId) || '').trim();
  const ok = /^#?[0-9a-f]{6}$/i.test(v);
  const sw = document.getElementById(swatchId);
  sw.style.background = ok ? (v.startsWith('#') ? v : '#' + v) : 'transparent';
  document.getElementById(inputId).parentNode?.classList.toggle('field-err', !ok);
}
function refreshSwatches() {
  refreshSwatch('tblLineColor', 'tblLineSwatch');
  refreshSwatch('tblFillColor', 'tblFillSwatch');
}

// 点色块弹 PS 原生拾色器。拾色器是模态的，期间禁止再点第二次。
let picking = false;
function bindSwatchPicker(swatchId, inputId) {
  document.getElementById(swatchId).addEventListener('click', async () => {
    if (picking || drawing) return;
    picking = true;
    try {
      const hex = await pickColor(tblVal(inputId));
      if (!hex) return;                            // 用户取消，保持原值
      setTblValue(inputId, hex);
      refreshSwatches();
      saveTableCfg();
    } catch (e) {
      setStatus('打不开拾色器：' + errMsg(e) + '（可直接在输入框填 #rrggbb）');
    } finally {
      picking = false;
    }
  });
}

// 参数联动（需求 §24）：结构开关在独立单元格模式下无意义
function refreshTableUi() {
  document.getElementById('tblStructRow').classList.toggle(
    'row-off', activePill('tblOutputPills', 'data-out') === 'cells',
  );
  show('tblFillColorRow', !!document.getElementById('tblFill').checked);
  refreshSwatches();
}

function askTableConfirm(count) {
  document.getElementById('tblCellCount').textContent = String(count);
  showOverlay('tableConfirm', true);
  return new Promise((res) => { tableDecider = res; });
}
function resolveTableConfirm(v) {
  showOverlay('tableConfirm', false);
  if (tableDecider) { const d = tableDecider; tableDecider = null; d(v); }
}
document.getElementById('tblConfirmYes').onclick = () => resolveTableConfirm(true);
document.getElementById('tblConfirmNo').onclick = () => resolveTableConfirm(false);

async function runDrawTable() {
  if (drawing) return;
  const doc = app.activeDocument;
  const cfg = readTableCfg();

  const err = validateParams(cfg, { hasDoc: !!doc });
  if (err) return setStatus(err);

  // 画在【当前视图】正中间：放大到局部工作时，表格就出现在眼前而不是跑到画布中心。
  // 取不到视图信息（老版本 PS / 描述符键名对不上）就退回画布中心，行为与之前一致。
  const canvas = { width: doc.width, height: doc.height };
  const geo = computeLayout(cfg);                  // 独立单元格模式的总尺寸算法不同，走这个口
  const raw = await readViewCenter();
  // 描述符解析出来的东西未必真是我以为的那个语义，算出画布外的中心点一律不信，
  // 否则表格会被画到画布外几千像素处——看起来就是「什么都没画出来」
  const center = isPlausibleCenter(raw, canvas) ? raw : null;
  const rectOrigin = originAtCenter({ w: geo.totalW, h: geo.totalH }, canvas, center);

  const plan = buildTable(cfg, canvas, rectOrigin);
  if (!plan.layers.length) return setStatus('当前设置不会画出任何内容：请至少开启一项结构或单元格填充。');

  // 性能保护（需求 §27）：形状图层过多先问一句
  if (plan.layers.length > 500) {
    const go = await askTableConfirm(plan.layers.length);
    if (!go) return setStatus('已取消');
  }

  drawing = true;
  setTilesDisabled(true);
  const lbl = tableBtn.querySelector('.btn-label');
  const orig = lbl.textContent;
  lbl.textContent = '绘制中…';
  tableBtn.style.pointerEvents = 'none';
  tableBtn.style.opacity = '0.6';
  setStatus('正在绘制表格…');
  try {
    const r = await drawTable(plan, { lineColor: cfg.lineColor, fillColor: cfg.fillColor }, {
      onProgress: (done, total) => { if (total > 4) setStatus(`绘制中… ${done}/${total} 个形状`); },
    });
    if (r.created === 0) {
      // 一个都没建成：把真实错误摆到面板上，别让用户对着空画布猜
      setStatus('绘制失败：' + (r.error ? errMsg(r.error) : '未知原因') + '（详情见 UDT 控制台）');
    } else {
      const parts = [`已绘制 ${cfg.rows}×${cfg.cols} 表格（${Math.round(plan.size.w)}×${Math.round(plan.size.h)} px）`];
      parts.push(`${r.created} 个形状图层`);
      if (r.failed) parts.push(`${r.failed} 个失败：${errMsg(r.error)}`);
      // 独立单元格模式下明确回报是不是实时形状——决定属性面板里能不能改圆角
      if (cfg.output === 'cells') {
        parts.push(r.liveShape ? '实时形状 ✓（属性面板可改圆角）' : '非实时形状 ✗（属性面板改不了）');
      }
      parts.push(`[${r.strategy || '?'}] 位置 ${rectOrigin.left},${rectOrigin.top}`);
      setStatus(parts.join('，'));
    }
  } catch (e) {
    setStatus('绘制失败：' + errMsg(e));
  } finally {
    drawing = false;
    setTilesDisabled(false);
    lbl.textContent = orig;
    tableBtn.style.pointerEvents = '';
    tableBtn.style.opacity = '';
  }
}

tableBtn.addEventListener('click', () => { runDrawTable(); });

// 「宽/高」两个框在两种尺寸方式下复用。切换方式时把值按新含义换算过去，
// 否则「单元格 100」会被原样当成「总宽 100」，画出来的东西和用户预期差一个数量级。
bindPillGroup('tblSizeModePills', 'data-mode', (mode) => {
  // 借几何层来换算：独立单元格模式有共边重叠，公式和单一形状不一样，别在这儿重写一遍
  const cfg = readTableCfg();
  const geo = computeLayout({ ...cfg, sizeMode: mode === 'total' ? 'cell' : 'total' });
  const round1 = (v) => String(Math.round(Math.max(0, v) * 10) / 10);
  if (mode === 'total') {
    setTblValue('tblW', round1(geo.totalW));
    setTblValue('tblH', round1(geo.totalH));
  } else {
    setTblValue('tblW', round1(geo.cellW));
    setTblValue('tblH', round1(geo.cellH));
  }
  refreshTableUi(); saveTableCfg();
});
bindPillGroup('tblOutputPills', 'data-out', () => { refreshTableUi(); saveTableCfg(); });
bindTogglePills('tblStructPills', saveTableCfg);
// 初值先给 false，紧接着的 loadTableCfg 会用记忆的值覆盖掉
setupSwitch('tblFill', false, () => { refreshTableUi(); saveTableCfg(); });
// 四个事件各司其职，谁漏了都不丢数据：
//   input   —— 每敲一下就把真值提交进 tblState（唯一的「提交」时机）
//   focus   —— 把框清空，直接开始输入，不用先删旧值
//   Enter   —— 确认当前输入并退出输入框
//   blur    —— 纯装饰：清空框、把当前真值恢复成灰字提示
// focus/blur 不冒泡，为保险连会冒泡的 focusin/focusout 一起听；
// 所以连会冒泡的 focusin/focusout 一起听；重复触发也幂等。
for (const id of TBL_FIELDS) {
  const el = tbl[id];

  el.addEventListener('input', () => {
    const v = String(el.value ?? '').trim();
    if (v !== '') tblState[id] = v;                // 空串不提交：那是「清空了还没输」的中间态
    refreshSwatches();
    saveTableCfg();
  });

  const clear = () => { el.value = ''; };
  el.addEventListener('focus', clear);
  el.addEventListener('focusin', clear);

  const restore = () => {
    el.value = '';
    el.placeholder = tblState[id] ?? '';
    el.setAttribute('placeholder', tblState[id] ?? '');
    refreshSwatches();
  };
  el.addEventListener('blur', restore);
  el.addEventListener('focusout', restore);

  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.preventDefault) e.preventDefault();      // 别让回车顺带触发别的默认行为
    const v = String(el.value ?? '').trim();
    if (v !== '') tblState[id] = v;                // input 一般已经提交过，这里兜底
    restore();
    saveTableCfg();
    try { el.blur(); } catch { /* 不支持就算了 */ }
  });
}
bindSwatchPicker('tblLineSwatch', 'tblLineColor');
bindSwatchPicker('tblFillSwatch', 'tblFillColor');
loadTableCfg();
refreshTableUi();

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

// ---- 批量重命名：替换 / 重新命名 / 前缀 / 后缀 + n 连续编号，输入即预览 ----
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

// 预览行首的类型图标：组=文件夹，图层=图片框。一律内联净化 svg，不用位图
// （位图多了会让 Photoshop 卡死闪退，真机踩过）；描边色写死在标记里，同面板里其它拼接 svg。
const PV_ICO_GROUP = '<svg class="pv-ico" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
  + '<g fill="none" stroke="#e8b45a" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M18 102 V30 H52 L66 46 H110 V102 Z"/></g></svg>';
const PV_ICO_LAYER = '<svg class="pv-ico" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
  + '<g fill="none" stroke="#7fb2d8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="20" y="28" width="88" height="72" rx="8"/>'
  + '<path d="M20 80 L46 56 L70 80"/><circle cx="86" cy="52" r="8"/></g></svg>';
// 预览最多画这么多行：每行带图标后节点数翻几倍，UXP 下 DOM 一大就卡（同 SL_LIST_MAX 的道理）。
// ⚠️ 只限制「画」，不限制「改」——runRename 自己重算一遍全量，超出的行照样会被改名。
const PV_MAX = 300;
/** 超出上限时补在末尾的说明；没超就是空串 */
function pvMore(total) {
  return total > PV_MAX
    ? `<div class="pv-more">还有 ${total - PV_MAX} 项没画出来（只是预览省略，应用时同样生效）</div>`
    : '';
}

/** 预览的一行：行首类型图标 + 文字。data-kind 给测试和样式用 */
function pvRow(layer, inner) {
  const isGroup = !!layer && layer.kind === 'group';
  return `<div class="pv-row" data-kind="${isGroup ? 'group' : 'layer'}">`
    + `${isGroup ? PV_ICO_GROUP : PV_ICO_LAYER}<span class="pv-txt">${inner}</span></div>`;
}

function readRenameCfg() {
  const active = (boxId, attr) => {
    const a = document.querySelector(`#${boxId} .pill.active`);
    return a ? a.getAttribute(attr) : null;
  };
  const toInt = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };
  return {
    mode: renameMode,
    find: fieldValue(findInput),
    template: fieldValue(templateInput),
    counter: !!counterSwitchEl.checked,                      // 显式开关，不从模板猜
    start: toInt(fieldValue(startInput), 1),
    step: toInt(fieldValue(stepInput), 1),
    digits: toInt(active('digitsPills', 'data-digits'), 1),   // 位数固定可选，默认 1 位（不补零）
  };
}

// 把一批选中层按图层面板顺序排序（编号与预览都按此序）：
// 主路：一次 batchPlay 读回 itemIndex（自面板底部向上递增 → 从上到下 = 降序）；
// 兜底：itemIndex 读不到时按 doc.layers 遍历序（UXP 面板序，首个=最上）。
// 组与它的子层同时在列时，组的 itemIndex 大于组内所有子层 → 降序排下来正好是
// 「组名在前、组内的层紧随其后」，和面板上从上往下读的顺序一致。
// @param {Array<object>} sel 作用对象（重命名传真正点亮的那些，建组传最外层项）
// @param {boolean} [forceUp] 显式指定方向（批量建组恒用 false=从上到下）；省略则读重命名页的方向 pill
async function sortedByPanelOrder(sel, forceUp) {
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

// 模式相关字段显隐 + 标签/占位文案（编号设置区由「数字编号 n」开关控制）
function updateRenameFields() {
  show('findBlock', renameMode === 'replace');
  document.getElementById('templateLabel').textContent = MODE_LABEL[renameMode];
  templateInput.setAttribute('placeholder', MODE_PLACEHOLDER[renameMode]);
  document.getElementById('counterBlock').style.display = counterSwitchEl.checked ? '' : 'none';
}

// 选中数写在底部状态栏（顶部那一行已经撤掉）。数没变就不写：
// 否则「完成：已重命名 N 个」这类结果提示会被紧随其后的一次预览刷新冲掉。
// @param {number} count 这一次真会被改名的层数
// @param {boolean} [force] 切到本页时强制写一次
let lastRenameCount = -1;    // -1 = 还没记过；启动时的首次渲染只记数，把「插件已加载」留在状态栏
function refreshRenameStatus(count, force) {
  const first = lastRenameCount < 0;
  const changed = count !== lastRenameCount;
  lastRenameCount = count;
  if (first && !force) return;
  if (currentPage !== 'rename' || !(changed || force)) return;
  if (!app.activeDocument) setStatus('请先打开一个 PSD 文档');
  else if (!count) setStatus('未选中图层或组');
  else setStatus(`已选中 ${count} 个图层/组`);
}

let renderSeq = 0;   // 连续输入时只保留最后一次异步渲染的结果
// @param {boolean} [force] 进页时用：选中数没变也照样写一次状态栏
async function renderRenamePreview(force) {
  const seq = ++renderSeq;
  updateRenameFields();
  const layers = await sortedByPanelOrder(await trueSelectedLayers());
  if (seq !== renderSeq) return;                     // 已被更新的渲染取代
  refreshRenameStatus(layers.length, force);
  if (!layers.length) { previewList.innerHTML = '<i>未选中图层或组</i>'; return; }
  const cfg = readRenameCfg();
  // 必填输入为空：预览退化为原名（替换模式要填查找，其它模式要填模板）
  const inputReady = cfg.mode === 'replace' ? !!cfg.find : !!cfg.template;
  if (!inputReady) {
    previewList.innerHTML = layers.slice(0, PV_MAX).map((l) => pvRow(l, esc(l.name))).join('')
      + pvMore(layers.length);
    return;
  }
  const rows = buildRenameRows(layers.map((l) => l.name), cfg);
  // 开着编号但模板里没有独立的 n：提示一句，避免"怎么没编号"的困惑（不阻止执行）
  const hint = cfg.counter && cfg.template && !hasCounter(cfg.template)
    ? '<i>已开启数字编号，但模板里没有独立的 n（Button/Icon 里的 n 不算），编号不会出现</i>'
    : '';
  // rows 由 layers.map(名字) 得来，下标与 layers 一一对应 → 图标取 layers[i] 的类型
  previewList.innerHTML = hint + rows.slice(0, PV_MAX).map((r, i) => pvRow(layers[i], r.unmatched
    ? `${esc(r.from)} <span class="dup">未找到「${esc(cfg.find)}」</span>`
    : `${esc(r.from)} &nbsp;→&nbsp; <b>${esc(r.to)}</b>${r.dup ? ' <span class="dup">⚠同名</span>' : ''}`
  )).join('') + pvMore(rows.length);
}

async function runRename() {
  const layers = await sortedByPanelOrder(await trueSelectedLayers());
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
// 「连组内图层一起改」开关已删（改名只认真正点亮的项），清掉旧版留下的记忆
try { localStorage.removeItem('rename.deep'); } catch { /* 不支持则忽略 */ }

// 输入即时预览；聚焦时也刷新一次
findInput.addEventListener('input', renderRenamePreview);
findInput.addEventListener('focus', renderRenamePreview);
templateInput.addEventListener('input', renderRenamePreview);
templateInput.addEventListener('focus', renderRenamePreview);
startInput.addEventListener('input', renderRenamePreview);
stepInput.addEventListener('input', renderRenamePreview);
startInput.value = '1';                               // HTML 上的 value 特性不可靠，用 JS 赋初值
stepInput.value = '1';

// ---- 「按名称查找图层」弹窗：两步一窗 ----
// ① 查找视图：填关键词与条件 → 搜索 → 勾选 → 「添加到查找列表」
// ② 查找项视图：每次添加折成一张小卡（可停用 / 编辑 / 删除），卡片下方是全部结果预览；
//    「继续添加」回到 ①，多个关键词就形成多张卡；确认把预览里勾选的层设为图层面板
//    选中（重命名本身永远只认「图层面板里选中的那些」），取消则整次查找作废。
const slOverlay = document.getElementById('slOverlay');
const slFindInput = document.getElementById('slFindText');
const slListEl = document.getElementById('slList');
const slCountEl = document.getElementById('slCount');
const slGroupEl = document.getElementById('slGroupList');
const slPrevEl = document.getElementById('slPrevList');
let slResults = [];               // 本次搜索命中的结果行（面板顺序：首个=最上）
let slChecked = new Set();        // 本次结果里勾选的图层 id
let slGroups = [];                // 已添加的查找项：{id,cfg,rows,checked:Set,on,open}
let slSeq = 0;                    // 卡片自增 id
let slEditing = null;             // 正在编辑的卡片 id（点卡片上的「编辑」进来）
let slView = 'search';            // 当前在哪个视图
const SL_LIST_MAX = 300;          // 列表最多画这么多行：UXP 下 DOM 一大就卡
const SL_CHIP_MAX = 4;            // 卡片里的名字只占一行，最多列这么几个，其余折成 +N

// 卡片上的四个图标都拼在 innerHTML 里，所以描边色写死在标记里（面板里的内联 svg 都这么写）。
// 一律内联净化 svg，不用位图——位图多了会让 Photoshop 卡死闪退（真机踩过）
const SL_ICO_FIND = '<svg class="sl-grp-ico" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
  + '<g fill="none" stroke="#3ce0ef" stroke-width="14" stroke-linecap="round">'
  + '<circle cx="54" cy="54" r="34"/><path d="M79 79 L110 110"/></g></svg>';
const SL_ICO_EDIT = '<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
  + '<g fill="none" stroke="#8ba0b3" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M28 100 L34 76 L86 24 L104 42 L52 94 Z"/><path d="M20 116 H108"/></g></svg>';
const SL_ICO_DEL = '<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
  + '<g fill="none" stroke="#e0555c" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M22 34 H106"/><path d="M50 34 V20 H78 V34"/><path d="M34 34 L40 108 H88 L94 34"/></g></svg>';
// 启用/停用的开关：形状与面板里的 .switch 完全一致（轨道 + 两个位置的滑块，靠 .on 切显隐）
const SL_SWITCH = '<svg class="sw" viewBox="0 0 44 24" xmlns="http://www.w3.org/2000/svg">'
  + '<rect class="sw-track" x="12" y="0" width="20" height="24"/>'
  + '<circle class="sw-track" cx="12" cy="12" r="12"/><circle class="sw-track" cx="32" cy="12" r="12"/>'
  + '<circle class="sw-knob sw-off" cx="12" cy="12" r="9"/>'
  + '<circle class="sw-knob sw-on" cx="32" cy="12" r="9"/></svg>';

const MATCH_LABEL = { contains: '包含', exact: '完全匹配', prefix: '前缀', suffix: '后缀' };
const KIND_LABEL = { all: '全部', layer: '仅图层', group: '仅图层组' };
const SCOPE_LABEL = { doc: '整个文档', sel: '已选中的组内' };

function readSearchCfg() {
  const scope = activePill('slScopePills', 'data-scope') === 'sel' ? 'sel' : 'doc';
  return {
    text: fieldValue(slFindInput),
    mode: activePill('slMatchPills', 'data-match') || 'contains',
    caseSensitive: pillOn('slFlagPills', 'data-flag', 'case'),
    includeHidden: pillOn('slFlagPills', 'data-flag', 'hidden'),
    // 背景图层一律参与查找（没有开关）。注意给它改名会被 PS 转成普通图层——
    // 那是 PS 的行为，不是插件在偷偷改结构，列表里会标出「背景」提醒一下
    includeBackground: true,
    kind: activePill('slKindPills', 'data-kind') || 'all',
    scope,
    // 「已选中的组内」：以图层面板当前的选中项为范围（组算它的后代，图层算它自己）
    scopeIds: scope === 'sel' ? selectedLayers().map((l) => l.id) : null,
  };
}

/** 卡片上那行条件摘要 */
function describeSearchCfg(cfg) {
  return [MATCH_LABEL[cfg.mode] || cfg.mode, SCOPE_LABEL[cfg.scope] || '整个文档', KIND_LABEL[cfg.kind] || '全部']
    .concat(cfg.caseSensitive ? ['区分大小写'] : [], cfg.includeHidden ? [] : ['不含隐藏'])
    .join(' · ');
}

/** 图层名 + 命中片段高亮 */
function slNameHtml(r) {
  return r.hit && r.hit.end > r.hit.start
    ? esc(r.name.slice(0, r.hit.start))
      + `<span class="sl-hit">${esc(r.name.slice(r.hit.start, r.hit.end))}</span>`
      + esc(r.name.slice(r.hit.end))
    : esc(r.name);
}

/** 行尾小字：组 / 背景 / 隐藏 / 锁定 */
function slTagText(r) {
  const tags = [];
  if (r.kind === 'group') tags.push('图层组');
  else tags.push('图层');
  if (r.isBackground) tags.push('背景');     // 改名会被 PS 转成普通图层，值得标一下
  if (!r.visible) tags.push('隐藏');
  if (r.locked) tags.push('锁定');
  return tags.join(' · ');
}

/**
 * 一行结果：整行可点＝切换勾选。子元素一律 pointer-events:none —— 这样事件目标稳定
 * 落在行本身，整个列表只挂一个委托监听（同 .switch > * 的既有处理）。
 * @param {boolean} on 是否勾选
 * @param {string} [tail] 行尾小字（默认是类型/状态；预览里换成「来自: 关键词」）
 */
function slRowHtml(r, on, tail) {
  const path = describePath(r.path);
  return `<div class="sl-item${on ? ' on' : ''}" data-sl="${r.id}">`
    + `<span class="sl-box">${on ? '✓' : ''}</span>`
    + `<span class="sl-name">${path ? `<span class="sl-path">${esc(path)} / </span>` : ''}${slNameHtml(r)}</span>`
    + `<span class="sl-kind">${esc(tail === undefined ? slTagText(r) : tail)}</span></div>`;
}

// ---- ① 查找视图 ----

/** 排序下拉当前选的值（'doc' | 'name'） */
function slSortMode() {
  const a = document.querySelector('#slSortDd .dd-item.active');
  return a && a.getAttribute('data-sort') === 'name' ? 'name' : 'doc';
}

/** 结果排序只影响列表怎么看：改名的编号顺序照旧由图层面板顺序（itemIndex）决定 */
function slSortedResults() {
  if (slSortMode() !== 'name') return slResults;
  return slResults.slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** 重画查找视图的统计、列表与主按钮（勾选变动时用，不重新查找） */
function renderSearchList(hint) {
  const n = slResults.length;
  const picked = slResults.filter((r) => slChecked.has(r.id));
  // 找到多少、勾了多少写在同一行（原来另起一行拆图层/组/隐藏，信息密度不值那一行高度）
  slCountEl.textContent = n
    ? `搜索结果（找到 ${n} 项，已勾选 ${picked.length} 项）`
    : (fieldValue(slFindInput) ? '没有名称匹配的图层' : '输入查找内容后显示结果');

  const addBtn = document.getElementById('slAddBtn');
  addBtn.textContent = slEditing === null
    ? `＋ 添加到查找列表（${picked.length} 项）`
    : `保存修改（${picked.length} 项）`;
  addBtn.classList.toggle('btn-off', !picked.length);
  for (const id of ['slAllBtn', 'slInvBtn']) {
    document.getElementById(id).classList.toggle('btn-off', !n);
  }
  show('slBackBtn', !!slGroups.length);

  if (!n) {
    slListEl.innerHTML = `<div class="sl-note">${esc(hint || '输入查找内容后显示结果')}</div>`;
    return;
  }
  const rows = slSortedResults();
  const shown = rows.slice(0, SL_LIST_MAX);
  let html = shown.map((r) => slRowHtml(r, slChecked.has(r.id))).join('');
  if (rows.length > shown.length) {
    html += `<div class="sl-note">…另有 ${rows.length - shown.length} 项未列出</div>`;
  }
  slListEl.innerHTML = html;
}

/**
 * 按当前条件重查。本次结果默认全勾；正在编辑某张卡片时，卡片里原本没勾的保持没勾
 * （新命中的行仍默认勾上）。
 */
function runSearch() {
  let hint = '输入查找内容后显示结果';
  slResults = [];
  if (!app.activeDocument) hint = '请先打开一个 PSD 文档';
  else {
    const cfg = readSearchCfg();
    if (cfg.scopeIds && !cfg.scopeIds.length) {
      hint = '查找范围是「已选中的组内」，请先在图层面板选中图层组';
    } else if (cfg.text) {
      slResults = matchLayers(readAllLayers(), cfg);
      hint = '没有名称匹配的图层（可换匹配方式，或关掉区分大小写 / 打开含隐藏图层）';
    }
  }
  const g = slEditing === null ? null : slGroups.find((x) => x.id === slEditing);
  slChecked = new Set(slResults
    .filter((r) => !g || !g.rows.some((x) => x.id === r.id) || g.checked.has(r.id))
    .map((r) => r.id));
  renderSearchList(hint);
}

// 结果行的点击（列表整体一个委托监听，innerHTML 重画也不用重新挂）
slListEl.addEventListener('click', (e) => {
  const attr = e.target && e.target.getAttribute ? e.target.getAttribute('data-sl') : null;
  const id = attr ? parseInt(attr, 10) : NaN;
  if (!Number.isFinite(id)) return;                     // 点在列表空白处
  if (slChecked.has(id)) slChecked.delete(id); else slChecked.add(id);
  renderSearchList();
});

/** 把本次勾选的结果收成一张卡片（编辑模式下替换原卡片），然后回到查找项视图 */
function addSearchToList() {
  const picked = slResults.filter((r) => slChecked.has(r.id));
  if (!picked.length) return;
  const cfg = readSearchCfg();
  const group = {
    id: slEditing === null ? ++slSeq : slEditing,
    cfg: { ...cfg, scopeIds: null },      // 只留用于展示的条件，id 快照没意义
    rows: slResults.slice(),
    checked: new Set(picked.map((r) => r.id)),
    on: true,
    open: false,          // 默认折起来：卡片多了才好一眼看全，点头上的 ▶ 再展开
  };
  const at = slGroups.findIndex((x) => x.id === group.id);
  if (at >= 0) group.on = slGroups[at].on;
  if (at >= 0) slGroups[at] = group; else slGroups.push(group);
  slEditing = null;
  slResults = [];
  slChecked = new Set();
  fieldClear(slFindInput);
  setSearchView('list');
}

// ---- ② 查找项视图 ----

/** 全部匹配结果预览：启用的卡片里勾选的行，按 id 去重（重复命中只算一次） */
function slPreviewRows() {
  const seen = new Set();
  const out = [];
  for (const g of slGroups) {
    if (!g.on) continue;
    for (const r of g.rows) {
      if (!g.checked.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, from: g.cfg.text });
    }
  }
  return out;
}

function renderGroupList() {
  const total = slGroups.reduce((n, g) => n + g.rows.length, 0);
  document.getElementById('slGroupsHead').textContent = slGroups.length
    ? `已添加的查找项（${slGroups.length} 组，共 ${total} 项）`
    : '已添加的查找项';
  document.getElementById('slClearBtn').classList.toggle('btn-off', !slGroups.length);
  if (!slGroups.length) {
    slGroupEl.innerHTML = '<div class="sl-note">还没有查找项，点下面的「继续添加」查一批图层</div>';
    return;
  }
  slGroupEl.innerHTML = slGroups.map((g) => {
    // 卡片里只列【勾选中的】那些名字，不画勾选框（既然列出来的都是勾上的，那个 ☑ 是废笔墨）。
    // 点某个名字＝在这张卡里取消它，它随即从这一行消失，头上的 x/y 项跟着变；
    // 要把取消掉的勾回来走「编辑」重开查找页
    const picked = g.rows.filter((r) => g.checked.has(r.id));
    const chips = picked.slice(0, SL_CHIP_MAX).map((r) =>
      `<span class="sl-chip on" data-act="chip:${g.id}:${r.id}">${esc(r.name)}</span>`).join('');
    const more = picked.length > SL_CHIP_MAX
      ? `<span class="sl-chip more">+${picked.length - SL_CHIP_MAX}</span>` : '';
    const none = picked.length ? '' : '<span class="sl-note">这一项没有勾选任何图层</span>';
    return `<div class="sl-grp${g.on ? '' : ' off'}">`
      + '<div class="sl-grp-head">'
      + `<span class="sl-grp-fold" data-act="fold:${g.id}">${g.open ? '▼' : '▶'}</span>`
      + SL_ICO_FIND
      + `<span class="sl-grp-key">${esc(g.cfg.text)}</span>`
      + `<span class="sl-grp-n">${g.checked.size}/${g.rows.length} 项</span>`
      + `<span class="sl-sw switch${g.on ? ' on' : ''}" data-act="on:${g.id}">${SL_SWITCH}</span>`
      + `<span class="sl-ico-btn" data-act="edit:${g.id}">${SL_ICO_EDIT}</span>`
      + `<span class="sl-ico-btn" data-act="del:${g.id}">${SL_ICO_DEL}</span>`
      + '</div>'
      + (g.open
        ? `<div class="sl-grp-cfg">${esc(describeSearchCfg(g.cfg))}</div>`
          + `<div class="sl-grp-chips">${chips}${more}${none}</div>`
        : '')
      + '</div>';
  }).join('');
}

function renderPreview() {
  const rows = slPreviewRows();
  document.getElementById('slPrevHead').textContent = `全部匹配结果预览（共 ${rows.length} 项）`;
  const ok = document.getElementById('slOkBtn');
  // 按钮上只写「确认」：选中数已经写在上面那行「全部匹配结果预览（共 N 项）」里，
  // 再塞进按钮会把它撑长、在窄面板里被截成「确认（选中 160…」
  ok.textContent = '确认';
  ok.classList.toggle('btn-off', !rows.length);
  document.getElementById('slPrevAllBtn').classList.toggle('btn-off', !slGroups.length);
  if (!rows.length) {
    slPrevEl.innerHTML = '<div class="sl-note">还没有勾选任何图层</div>';
    return;
  }
  const shown = rows.slice(0, SL_LIST_MAX);
  let html = shown.map((r) => slRowHtml(r, true, `来自: ${r.from}`)).join('');
  if (rows.length > shown.length) {
    html += `<div class="sl-note">…另有 ${rows.length - shown.length} 项未列出（会一并选中）</div>`;
  }
  slPrevEl.innerHTML = html;
}

function renderSearchGroups() {
  renderGroupList();
  renderPreview();
}

/** 预览里点某一行 = 在它所属的（每一张）卡片里取消勾选 */
slPrevEl.addEventListener('click', (e) => {
  const attr = e.target && e.target.getAttribute ? e.target.getAttribute('data-sl') : null;
  const id = attr ? parseInt(attr, 10) : NaN;
  if (!Number.isFinite(id)) return;
  for (const g of slGroups) g.checked.delete(id);
  renderSearchGroups();
});

/**
 * 从事件目标往上找 data-act。卡片上的编辑/删除/开关是「span 包一个 svg」，CSS 已给子元素
 * pointer-events:none，但 UXP 对 svg 子元素吃不吃这条没验证过——点在描边上时目标可能是
 * <path>，所以再往上找几层兜底。
 */
function slActOf(target) {
  let el = target;
  for (let i = 0; el && i < 4; i++) {
    if (el.getAttribute) {
      const a = el.getAttribute('data-act');
      if (a) return a;
    }
    el = el.parentNode;
  }
  return null;
}

/** 卡片上的各种操作：折叠 / 启用 / 编辑 / 删除 / 单个名字的勾选 */
slGroupEl.addEventListener('click', (e) => {
  const act = e.target ? slActOf(e.target) : null;
  if (!act) return;
  const [kind, gid, rid] = act.split(':');
  const g = slGroups.find((x) => x.id === parseInt(gid, 10));
  if (!g) return;
  if (kind === 'fold') g.open = !g.open;
  else if (kind === 'on') g.on = !g.on;
  else if (kind === 'del') slGroups = slGroups.filter((x) => x !== g);
  else if (kind === 'chip') {
    const id = parseInt(rid, 10);
    if (g.checked.has(id)) g.checked.delete(id); else g.checked.add(id);
  } else if (kind === 'edit') {
    slEditing = g.id;
    fieldSet(slFindInput, g.cfg.text);
    setPillActive('slMatchPills', 'data-match', g.cfg.mode);
    setPillActive('slScopePills', 'data-scope', g.cfg.scope);
    setPillActive('slKindPills', 'data-kind', g.cfg.kind);
    setPillOn('slFlagPills', 'data-flag', 'case', g.cfg.caseSensitive);
    setPillOn('slFlagPills', 'data-flag', 'hidden', g.cfg.includeHidden);
    setSearchView('search');
    return;
  }
  renderSearchGroups();
});

// ---- 开 / 关 / 视图切换 / 确认 ----

/** @param {'search'|'list'} v */
function setSearchView(v) {
  slView = v;
  show('slSearchView', v === 'search');
  show('slListView', v === 'list');
  if (v === 'search') {
    runSearch();
    try { slFindInput.focus(); } catch { /* 某些版本 focus 不可用，忽略 */ }
  } else renderSearchGroups();
}

function openSearchDialog() {
  if (!app.activeDocument) return setStatus('请先打开一个 PSD 文档');
  slOpen = true;
  // 每次打开都从零开始：查找项只在一次弹窗里有效，否则第二次确认会把上一批又提交一遍
  slGroups = [];
  slResults = [];
  slChecked = new Set();
  slEditing = null;
  fieldClear(slFindInput);
  setPillOn('slFlagPills', 'data-flag', 'hidden', true);   // 含隐藏图层：每次打开都回到默认勾选
  // UXP 已知问题：文字编辑控件恒绘制在所有 DOM 之上，浮层出现时必须把页面上的
  // 输入框藏起来，否则「查找内容 / 替换为」那几个框会压在弹窗上面
  setTipMaskedFields(true);
  showOverlay(slOverlay, true);
  setSearchView('search');
}

function closeSearchDialog() {
  slOpen = false;
  showOverlay(slOverlay, false);
  setTipMaskedFields(false);
}

/**
 * 确认：把预览里的层设为图层面板的当前选中，弹窗退场。
 *
 * 用「设为」而不是「追加」：查到的这些就是这次要改的对象，原来点亮着的（比如查找
 * 范围用的那个父组）不该跟着一起被改名。确认后照旧能用鼠标继续增减。
 */
async function applySearchSelection() {
  const rows = slPreviewRows();
  if (!rows.length) return;
  // 攒的过程中可能有图层被删掉（弹窗不阻塞 PS 操作），执行前剔掉已不存在的
  const alive = new Set(readAllLayers().map((node) => node.id));
  const ids = rows.map((r) => r.id).filter((id) => alive.has(id));
  const gone = rows.length - ids.length;
  if (!ids.length) return setStatus('选中的图层都已不存在，请重新查找');
  const n = await selectLayersById(ids);
  closeSearchDialog();
  // 先等预览刷完（它会把新的选中数写进状态栏），再写这条更详细的，免得被它盖掉
  await renderRenamePreview();
  const parts = [`已选中 ${n} 个图层/组（可继续用鼠标增减）`];
  if (gone) parts.push(`${gone} 个已不存在，已跳过`);
  setStatus(parts.join('，'));
}

document.getElementById('slOpenBtn').addEventListener('click', () => openSearchDialog());
document.getElementById('slCloseBtn').addEventListener('click', () => closeSearchDialog());
document.getElementById('slCancelBtn').addEventListener('click', () => closeSearchDialog());
const applySl = () => applySearchSelection().catch((e) => {
  closeSearchDialog();
  setStatus('选中失败：' + errMsg(e));
});
document.getElementById('slOkBtn').addEventListener('click', () => applySl());

// 查找视图：搜索 / 全选 / 反选 / 加入列表 / 返回列表
// 边打字边出结果；「搜索」按钮与框内回车都是「照现在的条件重新查一遍」——
// 在 PS 里增删过图层后用得上（回车不等于确认，确认在查找项视图上）
slFindInput.addEventListener('input', () => runSearch());
document.getElementById('slSearchBtn').addEventListener('click', () => runSearch());
slFindInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
});
document.getElementById('slFindClear').addEventListener('click', () => {
  fieldClear(slFindInput);
  runSearch();
  try { slFindInput.focus(); } catch { /* 忽略 */ }
});
document.getElementById('slAllBtn').addEventListener('click', () => {
  slChecked = new Set(slResults.map((r) => r.id));
  renderSearchList();
});
document.getElementById('slInvBtn').addEventListener('click', () => {
  slChecked = new Set(slResults.filter((r) => !slChecked.has(r.id)).map((r) => r.id));
  renderSearchList();
});
document.getElementById('slAddBtn').addEventListener('click', () => addSearchToList());
document.getElementById('slBackBtn').addEventListener('click', () => {
  slEditing = null;                    // 放弃这次编辑 / 查找，原卡片保持不动
  setSearchView('list');
});

// 查找项视图：继续添加 / 清空全部 / 预览全选
document.getElementById('slMoreBtn').addEventListener('click', () => {
  slEditing = null;
  fieldClear(slFindInput);
  setSearchView('search');
});
document.getElementById('slClearBtn').addEventListener('click', () => {
  slGroups = [];
  renderSearchGroups();
});
document.getElementById('slPrevAllBtn').addEventListener('click', () => {
  // 预览「全选」＝把每张启用卡片里的行全勾回来（用于误取消后恢复）
  for (const g of slGroups) if (g.on) g.checked = new Set(g.rows.map((r) => r.id));
  renderSearchGroups();
});

// 查找条件：pill 选择跨会话记忆
bindPillGroup('slMatchPills', 'data-match', (v) => { prefSet('rename.match', v); runSearch(); });
bindPillGroup('slScopePills', 'data-scope', (v) => { prefSet('rename.scope', v); runSearch(); });
bindPillGroup('slKindPills', 'data-kind', (v) => { prefSet('rename.kind', v); runSearch(); });
// 排序是折叠下拉（不是 pill）：走面板里那套自绘下拉，选项点完回调重画列表。
// bindDropdown 是函数声明，提升过；它内部用到的两个标志位只在点击时才读，不会撞死区
bindDropdown('slSortDd', 'slSortValue', () => { prefSet('rename.sort', slSortMode()); renderSearchList(); });
setDropdownValue('slSortDd', 'slSortValue', 'data-sort', prefGet('rename.sort', 'doc'));
bindTogglePills('slFlagPills', () => {
  prefSet('rename.f.case', pillOn('slFlagPills', 'data-flag', 'case') ? '1' : '0');
  runSearch();
});
setPillActive('slMatchPills', 'data-match', prefGet('rename.match', 'contains'));
setPillActive('slScopePills', 'data-scope', prefGet('rename.scope', 'doc'));
setPillActive('slKindPills', 'data-kind', prefGet('rename.kind', 'all'));
setPillOn('slFlagPills', 'data-flag', 'case', prefGet('rename.f.case', '0') === '1');
// 「含隐藏图层」恒默认勾选（不跨会话记忆）：查找的默认口径就是「全都找出来」，
// 关掉只在本次弹窗内有效；下一次打开又是勾上的
for (const k of ['rename.f.bg', 'rename.f.hidden']) {
  try { localStorage.removeItem(k); } catch { /* 旧版「含背景图层」/「含隐藏」的残留，清掉 */ }
}

// 图层选择变化时，实时刷新预览（best-effort，不支持则忽略）
(async () => {
  try {
    await action.addNotificationListener(['select'], () => {
      renderRenamePreview(); refreshLayoutBtn(); refreshMoveBtns();
      // 参考线没有自己的通知（用户随手拖一条不会通知插件），借这一下顺手重读；
      // 真正为准的那次读取在点「按参考线分割」的当口
      if (currentPage === 'split') refreshGuideSplitInfo();
      // 正停在查找视图、且范围是「已选中的组内」：范围变了才重查（否则白白把勾选打回全勾）
      if (slOpen && slView === 'search' && activePill('slScopePills', 'data-scope') === 'sel') {
        runSearch();
      }
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
setupSwitch('gsMerged', false);                  // 参考线分割：默认只切选中的那一个对象

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
  show('splitPage', name === 'split');           // 智能分割 + 参考线分割同页并列
  show('batchPage', name === 'batch');           // 转智能对象 + 新建独立组同页并列
  show('exportConfig', name === 'slice');
  show('renamePage', name === 'rename');
  show('movePage', name === 'move');             // 快速平移：八方向九宫格 + 复制移动
  show('layoutPage', name === 'layout');
  show('tablePage', name === 'table');
  show('guidePage', name === 'guide');
  show('resizePage', name === 'resize');   // 批量改尺寸：四步向导
  show('sliceBtn', name === 'slice');
  show('renameBtn', name === 'rename');
  show('layoutBtn', name === 'layout');
  // 分割页的两个主按钮在 #splitPage 内部，随页一起显隐，不在这里单独控制
  hideAllTips();                                 // 切页时收起可能还开着的说明气泡
  refreshLayoutBtn(true);                        // 进排版页时按当前选中数决定按钮可用性与提示
  refreshMoveBtns();
  // 进重命名页：把当前选中数写进状态栏（初始化时这一次会被文件末尾的初始渲染顶掉，
  // renderSeq 会让它在写状态栏之前就退出，「插件已加载」因此留得住）
  if (name === 'rename') renderRenamePreview(true);
  // 参考线页的状态（画布尺寸、显隐/锁定）进页时现读一次。
  // 只在 name==='guide' 时调用：初始化时的 switchPage('rename') 早于参考线那一块的
  // 定义，提前进去会撞上 const 的暂时性死区
  if (name === 'guide') { refreshGuideDocState(); refreshGuideMenuState(); }
  if (name === 'split') refreshGuideSplitInfo();   // 参考线分割：进页现读一次「切出几块」
  if (name === 'resize') rzShowStep();             // 改尺寸：回到上次停留的那一步
}
bindPillGroup('sliceModePills', 'data-slicemode', (m) => { sliceMode = m; });

// ---- 悬停说明：功能说明不再占版面，鼠标移到对应控件上才浮出 ----
// 提示框都设了 pointer-events:none，移出锚点即消失，不会自我遮挡。
const allTips = [];
function hideAllTips() {
  allTips.forEach((t) => { t.style.display = 'none'; });
  setTipMaskedFields(false);         // 浮层收起 / 切页：恢复被藏起来的输入框
}
/**
 * 把一段说明挂到某个锚点元素的悬停上。
 * html 也可以传函数 —— 悬停那一刻才算内容（「输出位置」要报当前是哪种状态）。
 */
function bindTip(anchor, tipEl, html) {
  if (!anchor || !tipEl) return;
  allTips.push(tipEl);
  // UXP 对 mouseenter/mouseleave 支持不一致，用会冒泡的 mouseover/mouseout（重复触发也幂等）
  anchor.addEventListener('mouseover', () => {
    hideAllTips();
    tipEl.innerHTML = typeof html === 'function' ? html() : html;
    tipEl.style.display = 'block';
    setTipMaskedFields(true);        // 必须在 hideAllTips 之后：那一步会把输入框放回来
  });
  anchor.addEventListener('mouseout', hideAllTips);
}

// 切图方式：两个 pill 各自的说明（原来的两张说明卡片已移除）
const modeTip = document.getElementById('modeTip');
const MODE_TIP = {
  all: '<b class="tip-title">完整切图</b>图层 / 组标记为<b class="tag-red">红色</b>：不切图；<br>图层 / 组标记为<b class="tag-blue">蓝色</b>：合并切图；<br>导出名称格式：「项目名称_组名_[组名…]_图层名称」；<br>图层名里的<b>英文 / 数字 / 下划线原样保留</b>（大小写不动）；<br>中文自动取每个字的拼音首字母，空格与其它符号删除。',
  symbols: '<b class="tip-title">Symbols 切图</b>每个图标组需添加一个名为「定位格」的参考图层，并按定位格摆放图标。导出时以定位格为基准：未超出则按定位格尺寸导出；超出则自动补足空白像素，确保图标居中。「定位格」不参与切图，隐藏后仍可识别。',
};
Array.from(document.querySelectorAll('#sliceModePills .pill')).forEach((p) => {
  bindTip(p, modeTip, MODE_TIP[p.getAttribute('data-slicemode')]);
});

// 智能分割 / 批量处理：说明挂在各自标题后的问号图标上
bindTip(document.getElementById('splitInfo'), document.getElementById('splitTip'),
  '在图层面板<b>选中一个像素图层</b>（如拼合的素材图 / 多元素图层），插件自动识别其中<b>互不相连的内容块</b>，把每一块复制成<b>独立图层</b>（按从上到下、每行从左到右的顺序，依次命名为 0、1、2…）。<br>开启<b>保持元素完整</b>：同一元素内部断开的笔画 / 描边会并回同一图层（合并距离按本图自适应推导），规则排列的字符表 / 雪碧图则自动识别为网格、按格拆分不做合并。<br>关闭时严格按像素是否相连拆分——字母 i 的点会单独成一层。<br>原图层保持不变，可放心撤销。');
bindTip(document.getElementById('rzInfo'), document.getElementById('rzTip'),
  '把一批图片统一改成同一套尺寸：<b>选图片 → 设尺寸 → 设输出 → 开始处理</b>四步走完即可。<br>'
  + '来源可以是<b>当前文档、多选的图片文件、整个文件夹</b>（可含子文件夹）。<br>'
  + '<b>默认不改原文件</b>：一律另存到新位置；来源是当前文档时先复制一份再动手，原文档一个像素都不碰。<br>'
  + '<b>小图会放大到目标尺寸</b>，但默认不让图变形（要变形得自己选「拉伸」）。<br>'
  + '单张失败不会中断整批 —— 跑完在「失败记录」里看原因。')
bindTip(document.getElementById('gsInfo'), document.getElementById('gsTip'),
  '用<b>当前文档里已有的参考线</b>把内容切成网格，每一格复制成一个<b>独立图层</b>（参考线是手拖的还是版面生成的都行）。<br>'
  + '<b>画布边缘算作边界</b>：3 条竖线 = 4 列；只拖竖线就切成整条的列。<br>'
  + '整格没有内容的<b>自动跳过</b>，切出来的图层按 0、1、2… 依次编号（从上到下、每行从左到右），并统一放进一个新组。<br>'
  + '默认切<b>选中的那一个图层 / 组</b>（文字 / 形状 / 智能对象也可以，切片是像素）；开启<b>合并可见内容</b>则不看选中，把整张可见画面拍平后切。<br>'
  + '原对象保持不变，可以撤销（块数多时可能要多按几次 Ctrl+Z）。');
bindTip(document.getElementById('smartObjInfo'), document.getElementById('smartObjTip'),
  '选中一个或多个图层，点击后<b>逐个</b>转换为<b>独立智能对象</b>——绝不把多个图层合并进同一个智能对象。<br>已是智能对象的图层自动跳过；图层名称、顺序、位置、所在图层组与视觉效果保持不变；整个批量操作在历史记录中为一步，可一次撤销。');
bindTip(document.getElementById('groupInfo'), document.getElementById('groupTip'),
  '选中一个或多个图层 / 组，点击后为<b>每一个</b>对象分别新建一层父级组并把它嵌套进去——选中几个就建几个组，<b>绝不合并</b>。<br>新组<b>沿用原对象的名称</b>，建在对象原来的父级、原来的位置上：图层顺序、所在组、组内结构、名称、样式、混合模式、不透明度、蒙版与智能对象属性全部不变；整个批量操作在历史记录中为一步，可一次撤销。<br>无法处理的对象（如背景图层）会被跳过并在结果里报出，不影响其余对象。');
bindTip(document.getElementById('layoutInfo'), document.getElementById('layoutTip'),
  '在图层面板<b>选中 2 个以上</b>的图层 / 组 / 文字 / 形状 / 智能对象，点击后按<b>横向</b>或<b>竖向</b>自动排成一排：<br>顺序<b>不看图层面板</b>，而是按对象当前在画布中的实际位置——横排先从上到下识别「行」、行内从左到右；竖排先从左到右识别「列」、列内从上到下。<br><b>间距是相邻两个对象真实边缘之间的距离</b>（不是中心距），带投影/外发光的图层按主体边界算。<br>排序后的第一个对象作为<b>锚点保持原位</b>，其余依次贴过去，整批版面不会漂走。<br>只改位置：不栅格化、不合并、不改图层类型 / 尺寸 / 层级 / 组内结构，图层组整体移动。隐藏图层若被选中也参与排版并保持隐藏；<b>锁定图层会中止排版</b>并提示解锁（插件不擅自解锁）。<br>开启「自动扩展画布」后，只向真正超出的方向扩出透明画布并留出「画布边距」；整个操作在历史记录中为一步，可一次撤销。');
bindTip(document.getElementById('moveInfo'), document.getElementById('moveTip'),
  '选中一个或多个图层 / 组，在九宫格里点一个方向、填上距离 → 所有对象<b>按同一偏移整体平移</b>，相对位置不变（相对位移，不是坐标）。<br>'
  + '<b>上下左右</b>只要填一个距离；<b>四个斜角</b>要填水平、垂直两个（用不到的那一行会自己收起来）。<br>'
  + '距离<b>留空＝0</b>，填<b>负数</b>自动翻到对面那个方向；框内 <b>Enter</b> 执行，<b>↑/↓</b> ±1px、<b>Shift+↑/↓</b> ±10px。<br>'
  + '数值不清零，连点即按同一距离<b>累加</b>。<br>'
  + '开<b>复制移动</b>则原对象留在原位，移动的是新复制出来的那一份（副本留在选中状态，可以接着再挪）。<br>'
  + '选中父组和它的子层时只移动父组（不会走双倍）；锁定层与背景层跳过。可移到画布外，画布尺寸不变；每次一步可撤销。');

bindTip(document.getElementById('tableInfo'), document.getElementById('tableTip'),
  '按行列生成<b>矢量形状</b>表格，不是像素、不是选区，生成后颜色、大小、圆角都能继续改。<br>'
  + '<b>行距 / 列距为 0</b> 时是连续表格；<b>大于 0</b> 时画成互相独立的格子。<br>'
  + '<b>独立单元格</b>模式每格一层（R1C1…）放进组，描边与填充各自独立，可同时有。<br>'
  + '点色块可开拾色器。表格画在<b>当前视图正中</b>，整次绘制可一次撤销。');

bindTip(document.getElementById('renameInfo'), document.getElementById('renameTip'),
  '改名对象＝<b>图层面板里选中的那些</b>；组和组里的层都点亮了，就各改一次。<br>'
  + '手点太慢用<b>「按名称查找」</b>：弹窗里查一批勾一批，攒成卡片，确认后一次性成为选中。<br>'
  + '四种方式：<b>替换</b>（换掉原名里的查找内容）/ <b>重新命名</b>（整名替换）/ <b>前缀 / 后缀</b>。<br>'
  + '开<b>数字编号 n</b> 后，模板里<b>单独的 n</b> 变连续数字（Button 里的 n 不算），可设起始 / 递增 / 位数 / 方向。<br>'
  + '预览显示「原名称 → 新名称」，重名标<b class="tag-red">⚠同名</b>，没变化的行不写回 PS。给<b>背景图层</b>改名会被 PS 转成普通图层。');

tiles.forEach((t) => t.addEventListener('click', () => {
  if (slicing || splitting || converting || grouping || laying || moving || drawing || gdBusy) return;  // 任务进行中不切页
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
/** @param {(item:object)=>void} [onPick] 选完一项后的回调（导出设置那两个不需要，查找排序需要） */
function bindDropdown(ddId, valueId, onPick) {
  const dd = document.getElementById(ddId);
  const valueEl = document.getElementById(valueId);
  if (!dd || !valueEl) return;
  const items = Array.from(dd.querySelectorAll('.dd-item'));
  items.forEach((item) => item.addEventListener('click', () => {
    items.forEach((q) => q.classList.remove('active'));
    item.classList.add('active');
    valueEl.textContent = item.textContent;
    dd.classList.remove('open');
    setDdMaskedFields(false);
    ddItemClicked = true;
    if (onPick) onPick(item);
  }));
  dd.addEventListener('click', () => {
    ddBoxClicked = true;
    if (ddItemClicked) { ddItemClicked = false; return; }   // 选项已处理，别再切换开合
    const wasOpen = dd.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) { dd.classList.add('open'); setDdMaskedFields(true); }
  });
}
function closeAllDropdowns() {
  Array.from(document.querySelectorAll('.dropdown')).forEach((d) => d.classList.remove('open'));
  setDdMaskedFields(false);          // 菜单都收了，把躲开的输入框放回来
}
/** 按 data 属性把下拉恢复到某一项（跨会话记忆的初值靠它落地） */
function setDropdownValue(ddId, valueId, attr, value) {
  const dd = document.getElementById(ddId);
  const valueEl = document.getElementById(valueId);
  if (!dd || !valueEl) return;
  const items = Array.from(dd.querySelectorAll('.dd-item'));
  const hit = items.find((it) => it.getAttribute(attr) === value);
  if (!hit) return;                              // 记着的值已不在选项里：保留标记里的默认项
  items.forEach((it) => it.classList.remove('active'));
  hit.classList.add('active');
  valueEl.textContent = hit.textContent;
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

// ---- 参考线助手：新建版面 / 收藏版面 / 最近使用 / 快速参考线 / 参考线控制 ----
// 全部几何与记录逻辑在 lib/guide-core.js（有单测），PS 调用在 ps/guides.js；
// 这里只做「读界面 → 调几何 → 交给 PS → 写记录 → 重渲染」。
//
// 放在文件末尾是有意的：本块要用到上面定义的 bindTip / allTips / closeAllDropdowns /
// ddItemClicked 等，插在它们前面会撞上 const 的暂时性死区。

const GD_CREATE_LABEL = '新建参考线版面';      // 主按钮的空闲文案（忙碌时临时换掉）

let gdBusy = false;              // 创建 / 应用 / 清除进行中：禁止并发与切页
let gdRecent = [];               // 最近使用（第一位最新，上限 20）
let gdFavs = [];                 // 收藏版面（不受 20 条上限影响）
let gdVisible = null;            // 参考线显示状态；null = 读不到，退回本地记忆
let gdLocked = null;
let gdNoDoc = true;              // 当前无打开文档（需求 §30）
let gdNameDecider = null;        // 起名弹窗的 Promise resolver
let gdHistDecider = null;        // 清空历史确认的 Promise resolver
let gdLayoutSeen = 0;            // 记下过几次版面（判断这次弹窗到底有没有记录成功）

// ---- 小工具 ----

function gdOff(id, off) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('btn-off', !!off);
}

/** 记录时间显示："09-04 11:20"（跨年的老记录也只显示月日，列表里够用了） */
function gdTime(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 收藏名称：去空白、限长 24（需求 §13），空则回落到默认名 */
function gdCleanName(v, dflt) {
  const s = String(v ?? '').trim().slice(0, 24);
  return s || dflt;
}

// 原样快照（raw）没有版面参数，别让它和「没读出参数」的记录撞在一起
const gdFavIndexOf = (cfg) => gdFavs.findIndex(
  (f) => !f.raw && signatureOf(f.cfg) === signatureOf(cfg),
);

// ---- 持久化（需求 §28）----
//
// 面板里没有任何参数输入框了 —— 版面全在 Photoshop 原生弹窗里填，插件只存
// 「建过什么」：最近使用 20 条 + 收藏版面。两个键都是整份 JSON 存取。
function saveGuideLists() {
  try { prefSet('guide.recent', JSON.stringify(gdRecent)); } catch { /* 忽略 */ }
  try { prefSet('guide.favs', JSON.stringify(gdFavs)); } catch { /* 忽略 */ }
}
function loadGuideLists() {
  try { gdRecent = JSON.parse(prefGet('guide.recent', '[]')) || []; } catch { gdRecent = []; }
  try { gdFavs = JSON.parse(prefGet('guide.favs', '[]')) || []; } catch { gdFavs = []; }
  if (!Array.isArray(gdRecent)) gdRecent = [];
  if (!Array.isArray(gdFavs)) gdFavs = [];
}

/** 记一条版面到「最近使用」：参数完全相同的不堆新条目，只提到第一位（需求 §10） */
function recordGuideLayout(cfg, canvas) {
  const c = normalizeCfg(cfg);
  gdRecent = pushRecent(gdRecent, { cfg: c, canvas, at: Date.now() });
  saveGuideLists();
  refreshGuideRecords();
  return c;
}

// ---- 版面记录：最近使用 / 收藏版面各一个入口按钮，点开弹窗列出全部 ----
// 两块共用同一个弹窗（#gdListOverlay），标题与每条的操作按钮随 gdListMode 变化。

let gdListMode = 'recent';       // 'recent' | 'fav'

/** 只绑下拉框本身的开合（清除参考线那个箭头菜单用） */
function bindDropdownBox(ddId) {
  const dd = document.getElementById(ddId);
  if (!dd) return;
  dd.addEventListener('click', () => {
    ddBoxClicked = true;
    if (ddItemClicked) { ddItemClicked = false; return; }   // 选项已处理，别再切换开合
    const wasOpen = dd.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) { dd.classList.add('open'); setDdMaskedFields(true); }
  });
}

/** 入口按钮上带条数，不用点开也知道有没有东西 */
function refreshGuideRecordBtns() {
  const rb = document.getElementById('gdRecentBtn');
  const fb = document.getElementById('gdFavBtn');
  if (rb) rb.textContent = gdRecent.length ? `最近使用 (${gdRecent.length})` : '最近使用';
  if (fb) fb.textContent = gdFavs.length ? `收藏版面 (${gdFavs.length})` : '收藏版面';
  applyGuideDisabled();
}

function guideItemHtml(title, sub, acts) {
  return `<div class="gd-item">
    <div class="gd-item-main">
      <div class="gd-item-title">${title}</div>
      <div class="gd-item-sub">${sub}</div>
    </div>
    <div class="gd-item-acts">${acts}</div>
  </div>`;
}

/** 重绘弹窗里的记录列表。动作编码在 data-act="动作:序号" 里 */
function renderGuideList() {
  const fav = gdListMode === 'fav';
  const list = fav ? gdFavs : gdRecent;
  const box = document.getElementById('gdList');
  document.getElementById('gdListTitle').textContent = fav ? '收藏版面' : '最近使用';
  // 「清空历史」只对最近使用有意义；收藏要逐条取消，避免一键清光辛苦攒的模板
  show('gdListClear', !fav && !!gdRecent.length);

  // 没有文档时「应用」不可用，其余（改名 / 删除）只动插件数据，照常可点
  const applyOff = gdNoDoc ? ' btn-off' : '';
  box.innerHTML = list.length
    ? list.map((r, i) => {
      const d = describeRecord(r);
      return fav
        ? guideItemHtml(
          `★ ${esc(r.name)}`,
          `${esc(d.title)} · ${esc(d.detail)}<br>${esc(formatCanvas(r.canvas))}`,
          `<span class="gd-mini gd-apply${applyOff}" data-act="fav-apply:${i}">应用</span>`
          + `<span class="gd-mini" data-act="fav-rename:${i}">改名</span>`
          + `<span class="gd-mini" data-act="fav-del:${i}">删除</span>`,
        )
        : guideItemHtml(
          esc(d.title),
          `${esc(d.detail)}<br>${esc(formatCanvas(r.canvas))} · ${gdTime(r.at)}`,
          `<span class="gd-mini gd-apply${applyOff}" data-act="rec-apply:${i}">应用</span>`
          + `<span class="gd-mini gd-star" data-act="rec-star:${i}">${gdFavIndexOf(r.cfg) >= 0 ? '★' : '☆'}</span>`
          + `<span class="gd-mini" data-act="rec-del:${i}">删除</span>`,
        );
    }).join('')
    : (fav
      ? '<div class="gd-empty">还没有收藏。<br>在「最近使用」里点 ☆，或用「收藏当前版面」把画布上现成的参考线存下来。</div>'
      : '<div class="gd-empty">还没有记录。<br>创建一次参考线版面后会自动出现在这里，之后点「应用」即可一键恢复。</div>');

  // innerHTML 换掉了旧节点，旧监听随之消失，这里重新挂一遍。
  // 选择器只用 class —— 光秃秃的属性选择器 [data-xxx] 在 UXP 下没验证过
  const ACTIONS = {
    'fav-apply': (i) => { closeGuideList(); applyGuideRecord(gdFavs[i]); },
    'fav-rename': (i) => renameFavorite(i),
    'fav-del': (i) => deleteFavorite(i),
    'rec-apply': (i) => { closeGuideList(); applyGuideRecord(gdRecent[i]); },
    'rec-star': (i) => toggleFavorite(i),
    'rec-del': (i) => deleteRecent(i),
  };
  Array.from(document.querySelectorAll('#gdList .gd-mini')).forEach((el) => {
    const [kind, idx] = String(el.getAttribute('data-act') || '').split(':');
    const fn = ACTIONS[kind];
    if (!fn) return;
    el.addEventListener('click', () => fn(parseInt(idx, 10)));
  });
}

function openGuideList(mode) {
  if (gdBusy) return;
  gdListMode = mode;
  renderGuideList();
  showOverlay('gdListOverlay', true);
}
function closeGuideList() {
  showOverlay('gdListOverlay', false);
}
/** 记录变动后：列表开着就就地重绘，入口按钮上的条数也跟着更新 */
function refreshGuideRecords() {
  refreshGuideRecordBtns();
  if (document.getElementById('gdListOverlay').style.display !== 'none') renderGuideList();
}

// ---- 无文档 / 忙碌 / 列表为空时的按钮可用性（需求 §30）----

function applyGuideDisabled() {
  const noDoc = gdNoDoc || gdBusy;            // 需要当前文档才能做的事
  gdOff('gdCreateBtn', noDoc);
  for (const id of ['gdVisibleBtn', 'gdLockBtn', 'gdClearBtn']) gdOff(id, noDoc);
  Array.from(document.querySelectorAll('#guidePage .gd-btn')).forEach((b) => {
    if (b.getAttribute('data-quick')) b.classList.toggle('btn-off', noDoc);
  });
  // 两个记录入口：列表为空时点开也没东西，直接置灰；改名 / 删除不需要文档，所以只看条数
  gdOff('gdRecentBtn', gdBusy || !gdRecent.length);
  gdOff('gdFavBtn', gdBusy || !gdFavs.length);
  gdOff('gdFavNowBtn', noDoc);                // 收藏当前版面要读当前文档里的参考线
}

/** 画布尺寸与按钮可用性（同步、廉价，文档变化通知里也调它） */
function refreshGuideDocState() {
  const canvas = hasDoc() ? readCanvas() : null;
  gdNoDoc = !canvas;
  const el = document.getElementById('gdCanvas');
  if (el) el.textContent = canvas ? formatCanvas(canvas) : '未打开文档';
  applyGuideDisabled();
  if (currentPage === 'guide' && gdNoDoc) setStatus('请先打开一个 Photoshop 文档。');
}

/** 显隐 / 锁定状态（要走 batchPlay，只在进页与操作后读） */
async function refreshGuideMenuState() {
  if (gdNoDoc) return;
  gdVisible = await readGuidesVisible();
  gdLocked = await readGuidesLocked();
  refreshGuideCtrlLabels();
}

function refreshGuideCtrlLabels() {
  const v = gdVisible === null ? true : gdVisible;      // 读不到就按「显示中」显示
  const l = gdLocked === null ? false : gdLocked;
  const vb = document.getElementById('gdVisibleBtn');
  const lb = document.getElementById('gdLockBtn');
  if (vb) vb.textContent = v ? '隐藏参考线' : '显示参考线';
  if (lb) lb.textContent = l ? '解锁参考线' : '锁定参考线';
}

// ---- 执行：创建 / 应用 / 快速 / 清除 / 显隐 / 锁定 ----

/** 主按钮忙碌态（本页所有耗时操作共用） */
function setGuideBusy(on, label) {
  gdBusy = on;
  setTilesDisabled(on);
  const lbl = document.getElementById('gdCreateBtn').querySelector('.btn-label');
  lbl.textContent = on ? (label || '处理中…') : GD_CREATE_LABEL;
  applyGuideDisabled();
}

/**
 * 「新建参考线版面」：直接打开 Photoshop 原生弹窗（需求 §7 的新形态）。
 *
 * 参数不在面板里填，因此：
 *   · 弹窗走的是菜单项那条路，初值完全由 Photoshop 自己记：首次出厂默认，之后是上一次的设置；
 *   · 弹窗自带「预览」，点确定才创建，直接关掉弹窗文档里什么都不留 —— 两种状态由 PS 保证；
 *   · 用户在弹窗里填了什么，插件靠三条途径拿（通知 / batchPlay 返回值 / 前后对比反推），
 *     记录因此是「他实际建的那一版」，而不是面板里的猜测。
 */
async function runNewGuideLayout() {
  if (gdBusy) return;
  refreshGuideDocState();
  if (gdNoDoc) return setStatus('请先打开一个 Photoshop 文档。');

  const seen = gdLayoutSeen;
  setGuideBusy(true, '等待弹窗…');
  setStatus('已打开 Photoshop 的「新建参考线版面」：勾上「预览」可边改边看，点「确定」才创建。');
  try {
    // 走菜单项打开，弹窗里的初值由 PS 自己记：首次出厂默认，之后是上一次的设置。
    // prefill 只在菜单项这条路走不通时兜底（见 guides.js）
    const r = await openGuideLayoutDialog({ prefill: gdRecent.length ? gdRecent[0].cfg : null });
    // 途径一：PS 随 batchPlay 回传的「实际执行的参数」
    if (r.desc) takeGuideLayoutDesc(r.desc);
    // 途径二：动作通知，异步来的，可能比 batchPlay 的返回晚一点，等一小会儿（最多 ~0.5 秒），没有就走反推
    for (let i = 0; !r.cancelled && i < 10 && gdLayoutSeen === seen; i++) {
      await new Promise((res) => setTimeout(res, 50));
    }
    if (r.cancelled) {
      setStatus('已取消，文档里的参考线没有变化');
    } else if (gdLayoutSeen > seen) {
      // 状态栏只报一句摘要就够了，完整参数在「最近使用」里能看到；
      // 有没认出来的参数键才追一段 —— 列 / 行没进记录时，这行就是定位线索
      const odd = unknownGuideLayoutKeys(r.desc);
      setStatus(`已创建参考线版面：${describeCfg(gdRecent[0].cfg).title}`
        + (odd.length ? `；有没认出来的参数：${formatGuideLayoutParams(r.desc, odd)}` : ''));
    } else if (takeGuideLayoutGuides(r.before, r.after)) {
      // 途径三：谁都没送参数回来，就对比弹窗前后的参考线，把这一版反推出来。
      // 菜单项那条路 batchPlay 不回传参数，通知也不是每个版本都发 —— 全靠这条兜底
      setStatus(`已创建参考线版面：${describeCfg(gdRecent[0].cfg).title}`);
    } else {
      // 三条途径都没结果 → 如实说明，不编一条假记录。
      // 顺带把 PS 回传的键名报出来：键名对不上时这行提示就是唯一的线索
      const keys = guideLayoutKeys(r.desc);
      setStatus('已创建参考线版面，但没能读出这一版的参数，本次没有记入「最近使用」'
        + (keys.length ? `（Photoshop 回传的键：${keys.join('、')}）` : ''));
    }
    if (!r.cancelled && !r.native) {
      // 菜单项这条路没走通 → 弹窗是插件按上一条记录填的，PS 自己的记忆用不上，说清楚
      setStatus(statusEl.textContent + '；本次弹窗由插件按上一条记录预填（菜单项打不开）');
    }
  } catch (e) {
    setStatus('打开「新建参考线版面」失败：' + errMsg(e));
  } finally {
    setGuideBusy(false);
  }
}

/**
 * 一键应用历史 / 收藏版面（需求 §11 / §31）。不弹窗，直接重放那一版。
 * 走 Photoshop 自己的 newGuideLayout，所以记录里存「宽度自动」时会按【当前画布】
 * 重算，同一条记录在 1920 和 2560 的稿子上都对得上。
 * 万一那条描述符执行不了，退回插件自己算坐标、逐条建（几何有单测兜底）。
 */
async function applyGuideRecord(rec) {
  if (gdBusy || !rec) return;
  refreshGuideDocState();
  if (gdNoDoc) return setStatus('请先打开一个 Photoshop 文档。');
  const canvas = readCanvas();
  // 原样快照，或者「收藏当前版面」存下的、画布尺寸没变过的记录：按坐标还原，
  // 保证与收藏时看到的一模一样（换了尺寸的稿子才走下面的参数重算）
  if (rec.guides && (rec.raw || formatCanvas(rec.canvas) === formatCanvas(canvas))) {
    return applyRawGuides(rec);
  }
  const cfg = normalizeCfg(rec.cfg);

  // 先把「这一版应该长什么样」算出来：既当原生命令空转时的判据，也当兜底方案
  const plan = computeGuides(cfg, canvas);

  setGuideBusy(true, '应用中…');
  try {
    let via = 'ps';
    try {
      await applyGuideLayout(cfg, plan.error ? null : plan);
    } catch {
      if (plan.error) throw new Error(plan.error);  // 兜底：自己算、自己画
      await applyGuides(plan, { clearFirst: cfg.clearFirst, commandName: '应用参考线版面' });
      via = 'plugin';
    }
    // 重放也算「用过一次」：提到最近使用第一位（签名相同不会堆出第二条）
    recordGuideLayout(cfg, canvas);
    const d = describeCfg(cfg);
    setStatus(`已应用「${rec.name ? rec.name : d.title}」：${d.detail}`
      + (via === 'plugin' ? '（原生版面命令不可用，已由插件直接创建）' : ''));
  } catch (e) {
    setStatus('应用版面失败：' + errMsg(e));
  } finally {
    setGuideBusy(false);
  }
}

/**
 * 原样快照的重放：那一版不是规则版面（手摆的、拼出来的），没有参数可算，
 * 就按存下来的坐标逐条建。跨画布不缩放 —— 位置是用户当初挑的，缩了反而不是那一版了。
 */
async function applyRawGuides(rec) {
  const canvas = readCanvas();
  setGuideBusy(true, '应用中…');
  try {
    await applyGuides(rec.guides, { clearFirst: true, commandName: '应用参考线版面' });
    // 参数化的记录即便走坐标还原，也照旧算「用过一次」，提到最近使用第一位
    if (rec.cfg) recordGuideLayout(rec.cfg, canvas);
    const d = describeRecord(rec);
    setStatus(`已应用「${rec.name || d.title}」：${d.title}`
      + (formatCanvas(rec.canvas) === formatCanvas(canvas)
        ? '' : `（存的时候画布是 ${formatCanvas(rec.canvas)}，坐标未缩放）`));
  } catch (e) {
    setStatus('应用版面失败：' + errMsg(e));
  } finally {
    setGuideBusy(false);
  }
}

/**
 * 「收藏当前版面」：把当前文档里【已经画好】的参考线整套存进收藏，不用照着重建一遍。
 * 能认出规则（几列几行、装订线、边距）就按参数存 —— 换个尺寸的稿子应用时会重算；
 * 认不出来（手摆的、拼出来的）就按原坐标存成快照，照样能一键还原。
 */
async function favoriteCurrentGuides() {
  if (gdBusy) return;
  refreshGuideDocState();
  if (gdNoDoc) return setStatus('请先打开一个 Photoshop 文档。');
  const canvas = readCanvas();
  const guides = readExistingGuides();
  if (!guides.vertical.length && !guides.horizontal.length) {
    return setStatus('当前文档里还没有参考线，先建一版再收藏。');
  }

  const empty = { vertical: [], horizontal: [] };
  const cfg = inferCfgFromGuides(empty, guides, canvas);
  // 收藏的是「画布上现在这个样子」，应用时自然应当替换掉当时的参考线
  if (cfg) cfg.clearFirst = true;
  // 认出参数也把【坐标一起存】：应用时同尺寸画布按坐标原样还原，换了尺寸才用参数重算。
  // 只存参数不够 —— 推断出的参数未必能原样算回这批线。真实例子：「4 列 + 左右边距 100、
  // 没有横线」只能被推断成「边距 上0 下0 左100 右100」（边距是一个整体开关，没法只开左右），
  // 而这套参数还会多画出画布上下两条边线。收藏当前版面的承诺是「应用后和现在一模一样」，
  // 这种损耗不能留给用户去发现。
  const rec = cfg
    ? { cfg, guides, canvas, at: Date.now() }
    : { raw: true, cfg: null, guides, canvas, at: Date.now() };

  // 参数相同还要坐标也相同才算重复：不同的线有可能推断出同一套参数，
  // 而现在坐标是会被原样还原的，判成重复就等于「按了收藏却什么都没存下来」。
  // 旧版存的记录没有 guides 字段，那就仍按参数签名判（保持兼容）
  const dup = gdFavs.findIndex((f) => (cfg
    ? (!f.raw && signatureOf(f.cfg) === signatureOf(cfg)
      && (!f.guides || sameGuides(f.guides, guides)))
    : (f.raw && sameGuides(f.guides, guides))));
  if (dup >= 0) return setStatus(`这一版已经在收藏里了：「${gdFavs[dup].name}」`);

  const d = describeRecord(rec);
  const name = await askGuideName('收藏当前版面', d.name);
  if (name === null) return;                       // 用户取消
  gdFavs.unshift({ ...rec, name: gdCleanName(name, d.name) });
  saveGuideLists();
  refreshGuideRecords();
  setStatus(`已收藏为「${gdFavs[0].name}」：${d.title}`
    + (cfg ? '' : '（这一版不是规则版面，按原坐标存下来了）'));
}

/**
 * 快速参考线（需求 §24）。
 * 恒为【追加】：这几个是随手加的辅助线，把用户辛苦排好的版面清掉太粗暴；
 * 与已有参考线重合的位置会自动跳过，连点也不会堆出重复线。
 */
async function runQuickGuides(kind, label) {
  if (gdBusy) return;
  refreshGuideDocState();
  if (gdNoDoc) return setStatus('请先打开一个 Photoshop 文档。');
  const plan = quickGuides(kind, readCanvas());
  if (!plan.vertical.length && !plan.horizontal.length) return setStatus('没有可创建的参考线');

  setGuideBusy(true, '创建中…');
  try {
    const r = await applyGuides(plan, { clearFirst: false, commandName: label });
    if (!r.created) setStatus(`${label}：这些位置已经有参考线了，未重复创建`);
    else setStatus(`${label}：已追加 ${r.created} 条参考线`
      + (r.skipped ? `，跳过 ${r.skipped} 条重复位置` : ''));
  } catch (e) {
    setStatus(`${label}失败：` + errMsg(e));
  } finally {
    setGuideBusy(false);
  }
}

/** 清除参考线（需求 §20 / §21）。只动当前文档，不碰最近使用与收藏版面 */
async function runClearGuides(which) {
  if (gdBusy) return;
  refreshGuideDocState();
  if (gdNoDoc) return setStatus('请先打开一个 Photoshop 文档。');
  const label = which === 'v' ? '纵向参考线' : (which === 'h' ? '横向参考线' : '参考线');
  setGuideBusy(true, '清除中…');
  try {
    const r = await clearGuides(which);
    setStatus(r.removed ? `已清除 ${r.removed} 条${label}` : `当前文档没有${label}`);
  } catch (e) {
    setStatus('清除参考线失败：' + errMsg(e));
  } finally {
    setGuideBusy(false);
  }
}

/** 显示 / 隐藏（需求 §22）：只改显示状态，参考线数据仍在 */
async function runToggleGuidesVisible() {
  if (gdBusy) return;
  refreshGuideDocState();
  if (gdNoDoc) return setStatus('请先打开一个 Photoshop 文档。');
  setGuideBusy(true, '切换中…');
  try {
    const s = await toggleGuidesVisible();
    // 读不到状态就按「刚才是什么、现在就是反面」本地记着
    gdVisible = s === null ? !(gdVisible === null ? true : gdVisible) : s;
    refreshGuideCtrlLabels();
    setStatus(gdVisible ? '参考线已显示' : '参考线已隐藏（参考线本身没有被删除）');
  } catch (e) {
    setStatus('切换显示状态失败：' + errMsg(e));
  } finally {
    setGuideBusy(false);
  }
}

/** 锁定 / 解锁（需求 §23）：避免在画布上误拖动参考线 */
async function runToggleGuidesLock() {
  if (gdBusy) return;
  refreshGuideDocState();
  if (gdNoDoc) return setStatus('请先打开一个 Photoshop 文档。');
  setGuideBusy(true, '切换中…');
  try {
    const s = await toggleGuidesLock();
    gdLocked = s === null ? !(gdLocked === null ? false : gdLocked) : s;
    refreshGuideCtrlLabels();
    setStatus(gdLocked ? '参考线已锁定，画布上拖不动了' : '参考线已解锁');
  } catch (e) {
    setStatus('切换锁定状态失败：' + errMsg(e));
  } finally {
    setGuideBusy(false);
  }
}

// ---- 监听 Photoshop 的「新建参考线版面」----
//
// 记录功能全靠这个通知：PS 每次执行 newGuideLayout（插件按钮开的弹窗、用户自己走
// 菜单、乃至播放动作）都会带上【实际执行的描述符】，我们把它读回成插件的配置存起来。
// 于是「用户在弹窗里到底填了什么」不用猜，也顺手把用户手动建的版面也记了下来。
//
// 「应用」记录时也会触发这个通知，正好等于「用过一次提到最前」（签名相同不会堆重复）。

/**
 * 收到一份 newGuideLayout 描述符（来自 batchPlay 的返回值或动作通知）→ 记一条。
 * 两条途径可能都送到同一版参数，pushRecent 按签名去重，只会把同一条提到最前。
 * @returns {boolean} 是否记下来了
 */
function takeGuideLayoutDesc(desc) {
  const canvas = readCanvas();
  const cfg = canvas ? cfgFromGuideLayout(desc, canvas, readResolution()) : null;
  if (!cfg) return false;                            // 读不出参数：不记半条脏数据
  recordGuideLayout(cfg, canvas);
  gdLayoutSeen++;
  return true;
}

/**
 * 拿不到执行参数时的兜底：对比弹窗前后的参考线，把这一版版面反推出来再记一条。
 * 几何反推在 guide-core.js 里，纯逻辑有单测；认不出来就返回 false，不编假记录。
 * @returns {boolean} 是否记下来了
 */
function takeGuideLayoutGuides(before, after) {
  const canvas = readCanvas();
  const cfg = canvas ? inferCfgFromGuides(before, after, canvas) : null;
  if (!cfg) return false;
  recordGuideLayout(cfg, canvas);
  gdLayoutSeen++;
  return true;
}

function bindGuideLayoutEvent() {
  onGuideLayoutCreated((desc) => takeGuideLayoutDesc(desc));
}

// ---- 收藏管理（需求 §12 / §13 / §14）----

function askGuideName(title, dflt) {
  document.getElementById('gdNameTitle').textContent = title;
  const inp = document.getElementById('gdNameInput');
  fieldSet(inp, dflt);
  showOverlay('gdNameOverlay', true);
  return new Promise((res) => { gdNameDecider = res; });
}
function resolveGuideName(v) {
  showOverlay('gdNameOverlay', false);
  if (gdNameDecider) { const d = gdNameDecider; gdNameDecider = null; d(v); }
}

async function toggleFavorite(i) {
  const rec = gdRecent[i];
  if (!rec) return;
  const at = gdFavIndexOf(rec.cfg);
  if (at >= 0) {                                   // 已收藏 → 再点一次取消
    gdFavs.splice(at, 1);
    saveGuideLists();
    refreshGuideRecords();
    return setStatus('已从「收藏版面」移除（文档里的参考线不受影响）');
  }
  const dflt = describeCfg(rec.cfg).name;
  const name = await askGuideName('收藏这个版面', dflt);
  if (name === null) return;                       // 用户取消
  gdFavs.unshift({
    name: gdCleanName(name, dflt),
    cfg: normalizeCfg(rec.cfg),
    canvas: rec.canvas,
    at: Date.now(),
  });
  saveGuideLists();
  refreshGuideRecords();
  setStatus(`已收藏为「${gdFavs[0].name}」`);
}

async function renameFavorite(i) {
  const f = gdFavs[i];
  if (!f) return;
  const name = await askGuideName('重命名版面', f.name);
  if (name === null) return;
  f.name = gdCleanName(name, f.name);
  saveGuideLists();
  refreshGuideRecords();
  setStatus(`已改名为「${f.name}」`);
}

function deleteFavorite(i) {
  const f = gdFavs[i];
  if (!f) return;
  gdFavs.splice(i, 1);
  saveGuideLists();
  refreshGuideRecords();
  setStatus(`已取消收藏「${f.name}」（只删插件里的记录，不动文档参考线）`);
}

function deleteRecent(i) {
  if (!gdRecent[i]) return;
  gdRecent.splice(i, 1);
  saveGuideLists();
  refreshGuideRecords();
  setStatus('已删除这条记录');
}

// 清空历史：破坏性且不可撤销，走二次确认（需求 §26）
function askClearHistory() {
  showOverlay('gdHistConfirm', true);
  return new Promise((res) => { gdHistDecider = res; });
}
function resolveClearHistory(v) {
  showOverlay('gdHistConfirm', false);
  if (gdHistDecider) { const d = gdHistDecider; gdHistDecider = null; d(v); }
}

// ---- 事件绑定与初始化 ----

loadGuideLists();
bindGuideLayoutEvent();                            // 先挂通知，再让用户去点弹窗

// 旧版本的残留键：参数曾经存在 guide.cfg，三个开关存在 guide.colCenter / clearFirst /
// preview。参数与开关现在都在 Photoshop 的弹窗里，插件不再保存，顺手清掉
for (const k of ['guide.cfg', 'guide.colCenter', 'guide.clearFirst', 'guide.preview']) {
  try { localStorage.removeItem(k); } catch { /* 不支持则忽略 */ }
}

document.getElementById('gdCreateBtn').addEventListener('click', () => runNewGuideLayout());

const QUICK_LABEL = { cross: '十字中心', nine: '九宫格' };
Array.from(document.querySelectorAll('#guidePage [data-quick]')).forEach((btn) => {
  const kind = btn.getAttribute('data-quick');
  btn.addEventListener('click', () => runQuickGuides(kind, QUICK_LABEL[kind] || '快速参考线'));
});

document.getElementById('gdRecentBtn').addEventListener('click', () => openGuideList('recent'));
document.getElementById('gdFavBtn').addEventListener('click', () => openGuideList('fav'));
document.getElementById('gdFavNowBtn').addEventListener('click', () => { favoriteCurrentGuides(); });
document.getElementById('gdListClose').addEventListener('click', () => closeGuideList());

document.getElementById('gdVisibleBtn').addEventListener('click', () => runToggleGuidesVisible());
document.getElementById('gdLockBtn').addEventListener('click', () => runToggleGuidesLock());
document.getElementById('gdClearBtn').addEventListener('click', () => runClearGuides('all'));

// 清除参考线的下拉：选项点了就直接执行，不是「选个值」，所以不复用 bindDropdown
bindDropdownBox('gdClearDd');
Array.from(document.querySelectorAll('#gdClearDd .dd-item')).forEach((item) => {
  item.addEventListener('click', () => {
    ddItemClicked = true;
    document.getElementById('gdClearDd').classList.remove('open');
    setDdMaskedFields(false);
    runClearGuides(item.getAttribute('data-clear'));
  });
});
document.getElementById('gdNameOk').onclick = () =>
  resolveGuideName(fieldValue(document.getElementById('gdNameInput')));
document.getElementById('gdNameCancel').onclick = () => resolveGuideName(null);
document.getElementById('gdNameInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.preventDefault) e.preventDefault();
  resolveGuideName(fieldValue(document.getElementById('gdNameInput')));
});

// 「清空历史」在最近使用弹窗底部；确认框叠在列表弹窗之上，确认完列表就地刷新成空态
document.getElementById('gdListClear').addEventListener('click', async () => {
  if (!gdRecent.length) return;
  const go = await askClearHistory();
  if (!go) return;
  gdRecent = [];
  saveGuideLists();
  refreshGuideRecords();
  setStatus('已清空最近使用（收藏版面与文档参考线不受影响）');
});
document.getElementById('gdHistYes').onclick = () => resolveClearHistory(true);
document.getElementById('gdHistNo').onclick = () => resolveClearHistory(false);

bindTip(document.getElementById('guideInfo'), document.getElementById('guideTip'),
  '建过的参考线版面自动记下来，下次一键重放。<br>'
  + '<b>新建参考线版面</b>——开 PS 原生弹窗，确定才创建，数值由 PS 记忆。<br>'
  + '<b>最近使用</b>——自动记录，留 20 条；点「应用」直接重放。<br>'
  + '<b>收藏版面</b>——点 ☆ 存成模板，可命名，不限条数。<br>'
  + '<b>收藏当前版面</b>——把画布上现成的参考线整套存进收藏。<br>'
  + '<b>快速参考线</b>——点了直接建，追加不覆盖。<br>'
  + '<b>参考线控制</b>——显隐、锁定、清除（可只清横或竖）。');

refreshGuideRecords();
refreshGuideCtrlLabels();
refreshGuideDocState();

// 为什么参数不做在面板里、而是交给原生弹窗（这段结论别再推翻）：
// 插件自己画的「预览」没法在面板被折叠时撤掉 —— Adobe 的已知问题清单里写着
// 「uxphidepanel 及对应的 hide 回调从不发生，即使面板已经不可见」（PS-57284），
// show 也只在面板第一次显示时触发一次，uxpcommand 那条路同样收不到事件。
// 于是「没确认就不该留下的参考线」会赖在文档里。原生弹窗没这个问题：预览、确定、
// 取消全由 Photoshop 管，关掉弹窗文档里什么都不留。插件只做它做得好的部分——
// 把建过的版面记下来，下次一键重放。

// ---- 批量改尺寸：四步向导（选择图片 → 尺寸设置 → 输出设置 → 开始处理）----
//
// 分工：**策略全在这里**（来源怎么收、名字怎么起、同名怎么办、往哪个文件夹写），
//   机制在 src/ps/resizer.js（打开 → 改 → 存 → 关），算式在 src/lib/resize-core.js（已单测）。
//
// 「保存位置」为什么会随来源置灰：UXP 的文件权限是按【用户亲手选中的入口】授予的。
//   选文件夹时插件手里有根目录入口，「原文件所在位置」直接就能写；
//   多选图片时只有文件入口，父目录靠 getEntryWithUrl 反查（需要 manifest 的
//   localFileSystem: fullAccess，已声明）—— 先探一次，真拿不到才要求改用「指定文件夹」；
//   来源是当前文档时根本没有磁盘入口，只能写到指定文件夹。

const RZ_STEPS = 4;
const RZ_PRESET_KEY = 'rz.presets';
// 内置预设：只覆盖最常用的几套，用户自己存的排在后面
const RZ_BUILTIN = [
  { name: '1920 × 1080', builtin: true, cfg: { mode: 'wh', width: 1920, height: 1080, fit: 'contain' } },
  { name: '1080 × 1080', builtin: true, cfg: { mode: 'wh', width: 1080, height: 1080, fit: 'cover' } },
  { name: '1024 × 1024', builtin: true, cfg: { mode: 'wh', width: 1024, height: 1024, fit: 'contain' } },
  { name: '512 × 512', builtin: true, cfg: { mode: 'wh', width: 512, height: 512, fit: 'contain' } },
  { name: '最长边 2048', builtin: true, cfg: { mode: 'long', edge: 2048 } },
  { name: '缩放 50%', builtin: true, cfg: { mode: 'percent', percent: 50 } },
];
const RZ_MODE_NAME = {
  wh: '固定宽高', w: '固定宽度', h: '固定高度', long: '最长边',
  short: '最短边', percent: '百分比缩放', times: '尺寸倍数', max: '最大尺寸限制',
};
const RZ_FIT_NAME = { contain: '等比适应', cover: '等比填充', stretch: '拉伸', scale: '仅缩放' };
const RZ_FIT_HINT = {
  contain: '图完整装进目标框，剩下的空白按填充色补齐。',
  cover: '图放大到铺满目标框，超出的部分按锚点裁掉。',
  stretch: '⚠ 强行拉成目标尺寸，不保持比例 —— 图会变形。',
  scale: '图缩进目标框内，画布跟着图走，不补边也不裁切。',
};
// 四种适应方式的说明都收进标题后的问号浮层：写成一行一句会把这一页顶得很长，
// 而只显示「当前那一种」的旧写法等于要用户逐个点一遍才能比较。
const RZ_FIT_TIP = FITS.map((k) => `<b>${RZ_FIT_NAME[k]}</b>：${RZ_FIT_HINT[k]}`).join('<br>');
// 「位置」这一个控件的两种状态，说明和「现在输出到哪儿」都收进「输出设置」标题后面那个问号里
// （页面上原来还有一行提示，跟这段话重了一半，撤了）
const RZ_DEST_TIP = '<b>位置留空（默认）</b>：存回<b>原文件所在位置</b> —— 每张图写回它自己所在的'
  + '那个文件夹，不新建目录。同名会把原图盖掉，建议配合「添加后缀」，'
  + '或把「同名文件」设为自动重命名。<br>'
  + '<b>点文件夹图标</b>：改成<b>指定文件夹</b>，所有图都存到你选的那一个目录'
  + '（来源是「当前文档」时只能用这个）；来源是文件夹时可以再开「保持原文件夹结构」。';
const RZ_SKIP_TEXT = { small: '小图跳过', same: '尺寸没变化', exists: '同名跳过', invalid: '读不到尺寸' };

let rzStep = 1;
let rzSrc = 'files';                // doc | files | folder（默认「选择图片」，见 index.html 里那一排 pill）
let rzMode = 'wh';
let rzAnchor = 'cm';
let rzFill = 'none';                // none | fff | 000 | custom
let rzFillHex = '#ffffff';
let rzFmt = 'same';
let rzNameMode = 'keep';            // keep | suffix | tpl
let rzDup = 'rename';               // rename | overwrite | skip
let rzFiles = [];                   // [{entry, relDir, name}]
let rzRoot = null;                  // 选中的文件夹入口（只有「选择文件夹」才有）
let rzSkippedDirs = [];
// 输出位置只有这一个状态：null = 原文件所在位置，有值 = 指定文件夹。
// （原来另有一个 rzDest 的两选一，两处状态能互相说反话，撤了）
let rzOutFolder = null;
// 多尺寸列表，两种档混着放：{width,height} 固定宽高 / {times} 按原图倍率
let rzSizes = [];
let rzRunning = false;
let rzStopReq = false;
let rzDone = false;                 // 这一批跑完了：主按钮变「返回」
let rzDirty = false;                // 跑完之后又改了参数：主按钮变回「开始批量修改」
let rzFails = [];
let rzPresets = [];
let rzCustomCfg = null;             // 套预设之前那套「自定义」参数（选回「自定义」时还原）
let rzLastOut = null;               // 完成后「打开输出文件夹」用
let rzNameDecider = null;
const rzFolderCache = new Map();    // 目录路径 → 入口（避免反复 createFolder）
const rzNamesCache = new Map();     // 目录 → 已有文件名集合（小写，含扩展名）

const rzEl = (id) => document.getElementById(id);
const rzChecked = (id) => !!(rzEl(id) && rzEl(id).checked);
const rzVal = (id) => fieldValue(rzEl(id)).trim();
const rzMultiOn = () => rzChecked('rzMulti') && rzMode === 'wh';
const rzFolderKey = (f) => (f && (f.nativePath || f.name)) || '?';

/**
 * 面板上的参数 → resize-core 的 cfg。
 *
 * small 恒为 'up'：小图一律放大到目标尺寸。面板上原来有「不放大 / 放大 / 跳过」三选一，
 * 实际用起来只会让人困惑（选了 1024 却输出 512），所以入口撤掉、只留「放大到目标」这一种
 * 行为；resize-core 里另两档仍在（有单测），将来要放回来只是加个控件的事。
 * padSmall / skipSame 同理：跟着「高级设置」一起撤了，恒取默认值 false。
 */
function rzCfg() {
  return normalizeResizeCfg({
    mode: rzMode,
    fit: activePill('rzFitPills', 'data-fit') || 'contain',
    small: 'up',
    anchor: rzAnchor,
    width: numOr(rzVal('rzW'), 1920),
    height: numOr(rzVal('rzH'), 1080),
    edge: numOr(rzVal('rzEdge'), 2048),
    percent: numOr(rzVal('rzPercent'), 100),
    times: numOr(rzVal('rzTimes'), 1),
    maxW: numOr(rzVal('rzMaxW'), 2048),
    maxH: numOr(rzVal('rzMaxH'), 2048),
  });
}

const rzFillValue = () => (rzFill === 'none' ? null
  : rzFill === 'fff' ? '#ffffff' : rzFill === '000' ? '#000000' : rzFillHex);

// ---- 步骤导航 ----

function rzShowStep() {
  for (let i = 1; i <= RZ_STEPS; i++) show(`rzPane${i}`, i === rzStep);
  Array.from(document.querySelectorAll('#rzSteps .rz-step')).forEach((s) => {
    const n = parseInt(s.getAttribute('data-step'), 10);
    s.classList.toggle('active', n === rzStep);
    s.classList.toggle('done', n < rzStep);
  });
  show('rzPrevBtn', rzStep > 1 && !rzRunning);      // 处理中只留「停止处理」
  show('rzNextBtn', rzStep < RZ_STEPS);
  show('rzRunBtn', rzStep === RZ_STEPS);
  if (rzStep === 1) rzSyncSrc();
  if (rzStep === 2) rzSyncMode();
  if (rzStep === 3) rzSyncOut();
  if (rzStep === 4) {
    // 跑完之后又回去改了参数 → 这一批的结果不作数了，主按钮变回「开始批量修改」
    if (rzDone && rzDirty) rzClearDone();
    rzSyncSummary();
  }
  rzSyncRunBtn();
}

/**
 * 第 4 步主按钮的文字：跑着是「停止处理」，跑完是「返回」，其余是「开始批量修改」。
 * 卡片标题跟着走：还没开跑是「准备就绪」（不是「开始处理」—— 那是步骤指示器上那一步的
 * 名字，写在标题上会让人以为已经在跑了），跑着是「正在处理」，跑完是「处理完成 / 已停止」。
 */
function rzSyncRunBtn() {
  const lbl = rzEl('rzRunBtn').querySelector('.btn-label');
  if (lbl) lbl.textContent = rzRunning ? '停止处理' : rzDone ? '返回' : '开始批量修改';
  rzEl('rzRunBtn').classList.toggle('slicing', rzRunning);
  const title = rzEl('rzRunTitle');
  if (title) {
    title.textContent = rzRunning ? '正在处理'
      : rzDone ? (rzStopReq ? '已停止' : '处理完成') : '准备就绪';
  }
}

/** 收掉「已完成」这个状态：结果区清空，回到可以再跑一次的样子 */
function rzClearDone() {
  rzDone = false;
  rzDirty = false;
  rzStopReq = false;
  rzStats(0, 0, 0);
  rzEl('rzLog').innerHTML = '';
  rzProgress(0, 0, '');              // total=0 → 进度条归零、文字回到「尚未开始」
  show('rzDoneRow', false);
  rzSyncRunBtn();
}

/** 往前走之前校验当前步；返回错误文案，null 表示通过 */
async function rzValidate(step) {
  if (step === 1) {
    if (rzSrc === 'doc' && !app.activeDocument) return '当前没有打开的文档，请改选「选择图片 / 选择文件夹」。';
    if ((rzSrc === 'files' || rzSrc === 'folder') && !rzFiles.length) return '还没有选到图片，点上面的按钮选一下。';
    return null;
  }
  if (step === 2) {
    const cfg = rzCfg();
    for (const f of fieldsOfMode(cfg.mode)) {
      if (!(cfg[f] > 0)) return '尺寸参数要填大于 0 的数值。';
    }
    if (rzMultiOn() && !rzSizes.length) return '开了多尺寸输出，但列表是空的 —— 先添加尺寸。';
    return null;
  }
  if (step === 3) {
    if (rzOutFolder) return null;                  // 指定了文件夹，没什么可拦的
    if (rzSrc === 'doc') return '来源是当前文档，点「位置」的文件夹图标指定一个输出文件夹。';
    if (rzSrc === 'files') {
      // 多选图片 + 存回原位置：先探一次父目录拿不拿得到，拿不到就别让用户白跑一趟。
      // 原因照原样带出来 —— 反查父目录靠 manifest 的 localFileSystem: "fullAccess"，
      // 而权限是**装载插件时**读的：刚更新过插件、没重新加载，报的就是没权限那一类。
      const { folder, reason } = await parentFolderOf(rzFiles[0] && rzFiles[0].entry);
      if (!folder) return `定位不到原文件所在目录（${reason}），点「位置」的文件夹图标指定一个输出文件夹。`;
    }
    return null;
  }
  return null;
}

/**
 * 换页。四步之间**随便切**，不设卡（哪一步都可能是回头补设置的）——
 * 校验只在点「开始批量修改」时做一次，缺什么就跳到那一步说清楚（见 rzRun）。
 * 处理中不许换页：那会儿的界面得盯着进度和「停止处理」。
 */
function rzGoStep(next) {
  if (rzRunning) return;
  rzStep = Math.min(RZ_STEPS, Math.max(1, next));
  // 先清状态栏再换页：第 3 步的命名示例就写在状态栏里（rzRenderNameSample），
  // 顺序反了会把刚写上去的示例又擦掉
  setStatus('');
  rzShowStep();
}

// ---- ① 图片来源 ----

function rzSyncSrc() {
  const isFolder = rzSrc === 'folder';
  const isFiles = rzSrc === 'files';
  show('rzPickRow', isFolder || isFiles);
  show('rzRecursiveRow', isFolder);
  const btn = rzEl('rzPickBtn');
  if (btn) btn.textContent = isFolder ? '选择文件夹…' : '选择图片文件…';
  rzRenderFileList();
  const info = rzEl('rzSrcInfo');
  if (!info) return;
  if (rzSrc === 'doc') {
    const d = app.activeDocument;
    info.textContent = d ? `当前文档：${d.name}（${Math.round(d.width)} × ${Math.round(d.height)} px）` : '当前没有打开的文档。';
  } else if (!rzFiles.length) {
    info.textContent = isFolder ? '选一个文件夹，插件会扫描其中的图片。' : '可以一次选中多个图片文件。';
  } else {
    // 名字都在下面的清单里逐行列着，这一行只报数（和跳过的输出目录）
    const dirs = rzSkippedDirs.length ? `\n已跳过输出目录：${rzSkippedDirs.join('、')}` : '';
    info.textContent = `已选 ${rzFiles.length} 张：${dirs}`;
  }
}

/**
 * 已选清单：一行一个文件名，全都列出来 —— 一次只露 5 行，多的滚动看
 * （限高在 CSS 的 .rz-file-list，盒子本身用的是 .preview 那套带滚动的样式）。
 */
function rzRenderFileList() {
  const box = rzEl('rzFileList');
  if (!box) return;
  const listed = rzSrc !== 'doc' && rzFiles.length > 0;
  box.innerHTML = listed
    ? rzFiles.map((f) => `<div class="rz-file-row">${esc(ellipsizeName(f.name, 30))}</div>`).join('')
    : '';
  show('rzFileList', listed);
}

async function rzPick() {
  if (rzRunning) return;
  try {
    if (rzSrc === 'folder') {
      const f = await uxpFs.getFolder();
      if (!f) return;
      await rzScanFolder(f);
    } else {
      // ⚠️ 不传 types。真机反馈：带扩展名过滤时对话框里【一个图片都看不见】（文件夹里明明有）。
      //    UXP 在 Windows 上对这个过滤器的处理不可靠，与其让人看着空文件夹发愣，不如全都列出来、
      //    选完之后自己按扩展名筛（下面这一行 isSupportedImage 就是干这个的）。
      const list = await uxpFs.getFileForOpening({ allowMultiple: true });
      const arr = Array.isArray(list) ? list : (list ? [list] : []);
      if (!arr.length) return;
      rzRoot = null;
      rzFiles = arr.filter((e) => isSupportedImage(e.name)).map((e) => ({ entry: e, relDir: '', name: e.name }));
      rzSkippedDirs = [];
      rzTouch();
      const dropped = arr.length - rzFiles.length;
      setStatus(`已选 ${rzFiles.length} 张图片`
        + (dropped ? `（${dropped} 个不是支持的图片格式，已忽略）` : ''));
    }
  } catch { /* 用户取消：保持原状 */ }
  rzSyncSrc();
  rzSyncOut();
}

/**
 * 扫描一个【已经选好】的文件夹。
 * ⚠️ 单独抽出来是有原因的：「包含子文件夹」开关要重扫，但绝不能再弹一次文件夹选择框
 *    （真机反馈的毛病 —— 原来它直接调 rzPick，开关按一下就冒出一个选择框）。
 */
async function rzScanFolder(folder) {
  rzRoot = folder;
  setStatus('正在扫描文件夹…');
  // 输出目录要排除，否则第二遍会把上一遍的产物再处理一遍。已经选好「指定文件夹」
  // 且它就在这个文件夹里面时，按名字排掉；没选就没什么可排的。
  const { files, skippedDirs } = await collectImageFiles(folder, {
    recursive: rzChecked('rzRecursive'),
    excludeDirs: rzOutFolder && rzOutFolder.name ? [rzOutFolder.name] : [],
  });
  rzFiles = files;
  rzSkippedDirs = skippedDirs;
  rzTouch();
  setStatus(files.length ? `扫描完成：${files.length} 张图片` : '这个文件夹里没有找到支持的图片格式。');
}

/** 清空第 1 步选好的图片（第 4 步点「返回」时归零，免得以为还是上一批） */
function rzResetSource() {
  rzFiles = [];
  rzRoot = null;
  rzSkippedDirs = [];
  rzSyncSrc();
  rzSyncOut();
}

// ---- ② 尺寸设置 ----

function rzSyncMode() {
  const fields = fieldsOfMode(rzMode);
  // 宽和高在同一行：整行的显隐看「这个模式要不要宽或高」，两个格子再各自显隐
  const wantW = fields.indexOf('width') >= 0;
  const wantH = fields.indexOf('height') >= 0;
  show('rzFieldWH', wantW || wantH);
  show('rzCellW', wantW);
  show('rzCellH', wantH);
  show('rzFieldEdge', fields.indexOf('edge') >= 0);
  show('rzFieldPercent', rzMode === 'percent');
  show('rzPercentQuick', rzMode === 'percent');
  show('rzFieldTimes', rzMode === 'times');
  show('rzTimesQuick', rzMode === 'times');
  show('rzFieldMaxW', rzMode === 'max');
  show('rzFieldMaxH', rzMode === 'max');
  const edgeLabel = rzEl('rzEdgeLabel');
  if (edgeLabel) edgeLabel.textContent = rzMode === 'short' ? '最短边' : '最长边';

  // 适应方式 / 锚点 / 填充只有「固定宽高」才谈得上
  const fit = activePill('rzFitPills', 'data-fit') || 'contain';
  show('rzFitBlock', rzMode === 'wh');
  show('rzAnchorBlock', rzMode === 'wh' && fit !== 'scale' && fit !== 'stretch');
  show('rzFillBlock', rzMode === 'wh' && fit === 'contain');
  show('rzFillSwatch', rzFill === 'custom');

  // 多尺寸只在固定宽高下可用（列表存的是宽×高对）
  const multiRow = rzEl('rzMultiRow');
  if (multiRow) multiRow.classList.toggle('row-off', rzMode !== 'wh');
  show('rzMultiBox', rzMultiOn());
  if (rzMultiOn()) rzPrefillAdd();
  rzRenderSizes();
  rzRenderPreview();
}

/** 多尺寸那两行的默认值：宽高带出上面填的那一档，倍率给个 1,2,3 —— 空着让人不知道该填什么。
 *  注意两行各管各的：宽高那行是绝对尺寸，倍率那行按原图算，不拿这里的宽高当基准。 */
function rzPrefillAdd() {
  const cfg = rzCfg();
  if (!rzVal('rzAddW') && rzEl('rzAddW')) rzEl('rzAddW').value = String(cfg.width);
  if (!rzVal('rzAddH') && rzEl('rzAddH')) rzEl('rzAddH').value = String(cfg.height);
  if (!rzVal('rzScales') && rzEl('rzScales')) rzEl('rzScales').value = '1,2,3';
}

function rzRenderSizes() {
  const box = rzEl('rzSizeList');
  if (!box) return;
  box.innerHTML = rzSizes.length
    ? rzSizes.map((s, i) => `<div class="rz-size"><span class="rz-size-t">${esc(sizeLabel(s))}</span>`
      + `<span class="rz-size-del gd-mini" data-act="rz-del:${i}">✕</span></div>`).join('')
    : '<div class="rz-empty">还没有添加尺寸。在下面填好宽高点「添加」，或者填倍率按原图的倍数加几档。</div>';
  Array.from(document.querySelectorAll('#rzSizeList .gd-mini')).forEach((el) => {
    const [, idx] = String(el.getAttribute('data-act') || '').split(':');
    el.addEventListener('click', () => {
      rzSizes.splice(parseInt(idx, 10), 1);
      rzSaveMemory();
      rzRenderSizes();
      rzRenderPreview();
    });
  });
}

/** 标题行右侧的 before → after（有原始尺寸才显示） */
function rzRenderPreview() {
  const el = rzEl('rzPreviewInfo');
  if (!el) return;
  // 外部文件的像素尺寸不打开文档就是不知道，而为了显一行字去开文档不划算：
  // 只有「当前文档」这个来源才显 before → after（它的尺寸现成就有）。
  let src = null;
  if (rzSrc === 'doc' && app.activeDocument) {
    const d = app.activeDocument;
    src = { width: Math.round(d.width), height: Math.round(d.height) };
  }
  if (!src) { el.textContent = ''; return; }
  const cfg = rzCfg();
  const size = rzMultiOn() && rzSizes.length ? rzSizes[0] : null;
  const p = planResize(src, sizeCfg(cfg, size));
  if (p.skip) { el.textContent = `${src.width}×${src.height} → ${RZ_SKIP_TEXT[p.skip] || '跳过'}`; return; }
  const canvas = (p.canvas.width !== p.image.width || p.canvas.height !== p.image.height)
    ? ` / 画布 ${p.canvas.width}×${p.canvas.height}` : '';
  el.textContent = `${src.width}×${src.height} → ${p.image.width}×${p.image.height}${canvas}`;
}

// ---- ③ 输出设置 ----

/** 悬停「输出设置」后面那个问号时才算：先报现在输出到哪儿，再讲两种状态各是什么意思 */
function rzDestTipHtml() {
  const now = rzOutFolder
    ? `<b>现在：指定文件夹</b> —— ${esc(rzOutFolder.nativePath || rzOutFolder.name || '已选择')}`
    : (rzSrc === 'doc'
      ? '<b>现在：还没指定</b> —— 来源是当前文档，必须点文件夹图标选一个。'
      : '<b>现在：原文件所在位置</b> —— 每张图存回它自己所在的那个文件夹。');
  return `${now}<br>${RZ_DEST_TIP}`;
}

function rzSyncOut() {
  // 「位置」按切图的导出设置那样做：没选就是每张图各自的原文件夹，选了就都存到那一个目录。
  // 框内只够放缩略的文件夹名，所以选中后用名字顶掉图标；完整路径进问号浮层，页面上不再占一行。
  const hasPick = !!rzOutFolder;
  show('rzOutIco', !hasPick);
  const text = rzEl('rzOutText');
  if (text) text.textContent = hasPick ? (rzOutFolder.name || '已选择') : '';
  show('rzOutText', hasPick);
  show('rzOutReset', hasPick);
  show('rzKeepTreeRow', rzSrc === 'folder' && hasPick);
  show('rzQualityRow', rzFmt === 'jpg' || (rzFmt === 'webp' && !rzChecked('rzWebpLossless')));
  show('rzWebpRow', rzFmt === 'webp');
  show('rzSuffixRow', rzNameMode === 'suffix');
  show('rzTplRow', rzNameMode === 'tpl');
  rzRenderNameSample();
}

/**
 * 命名示例。第 3 步里不再单占一行（那一行挤得放不下长名字），
 * 改参数时直接报到底部状态栏 —— 只在停在第 3 步时写，免得盖掉别的页的提示。
 */
function rzRenderNameSample() {
  const name = (rzFiles[0] && rzFiles[0].name)
    || (app.activeDocument ? app.activeDocument.name : 'image.jpg');
  const { base, ext } = splitName(name);
  const outExt = extOf(rzFmt === 'same' ? (ext || 'png') : rzFmt);
  const size = rzMultiOn() && rzSizes.length ? rzSizes[0] : null;
  const cfg = rzCfg();
  const p = planResize({ width: cfg.width, height: cfg.height }, sizeCfg(cfg, size));
  const out = rzOutName(base, p, 0);
  // 状态栏也只有一行，两边各自压成「头…尾」（真机上那些 40 多字的文件名整着拼就溢出了）
  const text = `命名示例：${ellipsizeName(`${base}.${ext || 'jpg'}`, 16)} → ${ellipsizeName(`${out}.${outExt}`, 16)}`;
  if (rzStep === 3) setStatus(text);
  return text;
}

/** 一个输出文件的名字（不含扩展名）。多尺寸时保证名字里带尺寸，否则各档会互相覆盖 */
function rzOutName(base, plan, index) {
  const vars = {
    name: base,
    width: plan.canvas.width,
    height: plan.canvas.height,
    scale: formatScale(plan.scale),
    index: index + 1,
  };
  let out;
  if (rzNameMode === 'tpl') out = buildOutName(rzVal('rzTpl') || '{name}_{width}x{height}', vars);
  else if (rzNameMode === 'suffix') out = base + (rzVal('rzSuffix') || '_resized');
  else out = base;
  if (rzMultiOn() && out.indexOf(String(vars.width)) < 0) out = `${out}_${vars.width}x${vars.height}`;
  return sanitizeFileName(out);
}

async function rzPickOut() {
  if (rzRunning) return;
  try {
    const f = await uxpFs.getFolder();
    if (f) { rzOutFolder = f; rzTouch(); }
  } catch { /* 取消 */ }
  rzSyncOut();
}

/** 撤掉指定的输出文件夹 → 回到「存回原文件所在位置」这个默认 */
function rzResetOut() {
  if (rzRunning) return;
  rzOutFolder = null;
  rzTouch();
  rzSyncOut();
}

// ---- ④ 汇总与执行 ----

function rzSyncSummary() {
  const el = rzEl('rzSummary');
  if (!el) return;
  const n = rzSrc === 'doc' ? (app.activeDocument ? 1 : 0) : rzFiles.length;
  const sizes = rzMultiOn() && rzSizes.length ? rzSizes.length : 1;
  const cfg = rzCfg();
  const mode = RZ_MODE_NAME[cfg.mode] || cfg.mode;
  const param = cfg.mode === 'wh' ? `${cfg.width}×${cfg.height}`
    : cfg.mode === 'w' ? `宽 ${cfg.width}`
      : cfg.mode === 'h' ? `高 ${cfg.height}`
        : cfg.mode === 'percent' ? `${cfg.percent}%`
          : cfg.mode === 'times' ? `${cfg.times}x`
            : cfg.mode === 'max' ? `≤ ${cfg.maxW}×${cfg.maxH}` : `${cfg.edge}px`;
  el.textContent = `共 ${n} 张图片 · ${mode} ${param}`
    + (sizes > 1 ? ` · ${sizes} 档尺寸 → 预计输出 ${n * sizes} 个文件` : '')
    + (rzSkippedDirs.length ? `\n已跳过输出目录：${rzSkippedDirs.join('、')}` : '');
  const run = rzEl('rzRunInfo');
  const d = rzSrc === 'doc' ? app.activeDocument : null;
  if (run) run.textContent = d ? `${Math.round(d.width)}×${Math.round(d.height)}` : '';
}

function rzStats(ok, skip, fail) {
  rzEl('rzOkN').textContent = String(ok);
  rzEl('rzSkipN').textContent = String(skip);
  rzEl('rzFailN').textContent = String(fail);
}

function rzProgress(done, total, name) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const fill = rzEl('rzBarFill');
  if (fill) fill.style.width = `${pct}%`;
  const t = rzEl('rzProgText');
  if (t) t.textContent = total ? `${done} / ${total}　${name || ''}` : '尚未开始';
}

function rzLogRow(name, results) {
  const box = rzEl('rzLog');
  if (!box) return;
  const bad = results.filter((r) => r.status === 'fail');
  const ok = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skip');
  const state = bad.length ? `失败：${esc(bad[0].reason || '')}`
    : ok ? `${ok} 个文件`
      : (skipped[0] ? (RZ_SKIP_TEXT[skipped[0].reason] || '跳过') : '跳过');
  const cls = bad.length ? 'rz-fail' : ok ? 'rz-ok' : 'rz-skip';
  box.innerHTML += `<div class="rz-log-row"><span class="rz-log-n">${esc(name)}</span>`
    + `<span class="rz-log-s ${cls}">${state}</span></div>`;
}

/** 目标目录：按「保存位置 + 保持结构」算，创建过的目录缓存起来 */
async function rzTargetFolder(item) {
  const keep = rzChecked('rzKeepTree');
  const rel = keep ? (item.relDir || '') : '';
  if (rzOutFolder) return rzSubFolder(rzOutFolder, rel);
  // 「原文件所在位置」：文件夹来源手里有根目录入口，按相对路径下去就是原目录；
  //   多选图片时只有文件入口，得反查它的父目录
  if (rzSrc === 'folder' && rzRoot) return rzSubFolder(rzRoot, item.relDir || '');
  const { folder, reason } = await parentFolderOf(item.entry);
  if (!folder) throw new Error(`定位不到原文件所在目录（${reason}），点「位置」的文件夹图标指定一个输出文件夹`);
  return folder;
}

/** 逐级取/建子目录（'a/b' → root/a/b） */
async function rzSubFolder(root, rel) {
  if (!root) throw new Error('没有可用的输出文件夹');
  let cur = root;
  let key = rzFolderKey(root);
  for (const part of String(rel || '').split('/').filter(Boolean)) {
    key += `/${part}`;
    if (rzFolderCache.has(key)) { cur = rzFolderCache.get(key); continue; }
    let next = null;
    try { next = await cur.getEntry(part); } catch { next = null; }
    if (!next || !next.isFolder) next = await cur.createFolder(part);
    rzFolderCache.set(key, next);
    cur = next;
  }
  return cur;
}

/** 某目录里已有的文件名（小写、含扩展名）；同名策略与本次运行内去重共用这一个集合 */
async function rzNamesIn(folder) {
  const key = rzFolderKey(folder);
  if (rzNamesCache.has(key)) return rzNamesCache.get(key);
  const set = new Set();
  try {
    for (const e of await folder.getEntries()) {
      if (e.isFile) set.add(String(e.name).toLowerCase());
    }
  } catch { /* 读不到就当空目录：最坏结果是走覆盖 */ }
  rzNamesCache.set(key, set);
  return set;
}

/** resizer 的回调：这一档往哪儿写、叫什么名字；返回 null = 不输出 */
async function rzResolve({ src, plan, index }) {
  const folder = await rzTargetFolder(src);
  // 「打开输出文件夹」要的就是这个入口。别指望 rzFolderCache —— 「原文件所在位置」+ 多选图片
  // 那条路是反查父目录、根本不进缓存，所以真机上点了只会说「还没有产生输出文件夹」。
  if (!rzLastOut) rzLastOut = folder;
  const { base, ext } = splitName(src.name || 'image');
  const fmt = rzFmt === 'same' ? (ext || 'png') : rzFmt;
  const outExt = extOf(fmt);
  const taken = await rzNamesIn(folder);
  let name = rzOutName(base, plan, index);
  if (taken.has(`${name}.${outExt}`.toLowerCase())) {
    if (rzDup === 'skip') return null;
    if (rzDup === 'rename') {
      let i = 2;
      while (taken.has(`${name}_${i}.${outExt}`.toLowerCase())) i++;
      name = `${name}_${i}`;
    }
    // overwrite：用原名直接盖
  }
  taken.add(`${name}.${outExt}`.toLowerCase());     // 本次运行内也不许再撞
  const q = Math.min(100, Math.max(1, numOr(rzVal('rzQuality'), 90)));
  return {
    folder,
    fileName: name,
    save: {
      format: fmt,
      jpgQuality: q,
      webpLossless: rzChecked('rzWebpLossless'),
      webpQuality: q,
      overwrite: true,
    },
  };
}

/** 来源 → 待处理清单 */
function rzBuildItems() {
  if (rzSrc === 'doc') {
    const d = app.activeDocument;
    return d ? [{ kind: 'doc', docId: d.id, name: d.name, relDir: '' }] : [];
  }
  return rzFiles.map((f) => ({ kind: 'file', entry: f.entry, relDir: f.relDir, name: f.name }));
}

function rzSetRunning(on) {
  rzRunning = on;
  setTilesDisabled(on);
  // 「停止处理」就是主按钮本身，而它和「上一步」同在 #rzNav 里 —— 整行不能藏，
  // 只藏「上一步」（藏整行等于把停止键一起藏掉，处理中就停不下来了）
  show('rzPrevBtn', !on);
  rzSyncRunBtn();
}

async function rzRun() {
  if (rzRunning) { rzStopReq = true; setStatus('已请求停止：当前这张处理完就停下，已经存好的文件都保留。'); return; }
  // 唯一的关卡就在这儿：逐步查，缺东西就跳到那一步并报出「第几步 + 缺什么」
  for (let s = 1; s <= 3; s++) {
    const err = await rzValidate(s);
    if (err) { rzStep = s; rzShowStep(); return setStatus(`第 ${s} 步：${err}`); }
  }
  const items = rzBuildItems();
  if (!items.length) return setStatus('没有可处理的图片。');

  await closeStrayResizeDocs();
  rzStopReq = false;
  rzFails = [];
  rzLastOut = null;                  // 这一批实际写到哪儿，由 rzResolve 现场记下来
  rzFolderCache.clear();
  rzNamesCache.clear();
  rzEl('rzLog').innerHTML = '';
  rzStats(0, 0, 0);
  rzDone = false;
  rzDirty = false;
  rzSetRunning(true);

  const sizes = rzMultiOn() && rzSizes.length ? rzSizes.slice() : [null];
  const cfg = rzCfg();
  const t0 = Date.now();
  let ok = 0; let skip = 0; let fail = 0; let done = 0;
  let lastStep = '尚未开始';
  try {
    rzProgress(0, items.length, items[0].name);
    for (const item of items) {
      await tick();                                  // 让排队的「停止」点击先执行
      if (rzStopReq) break;
      rzProgress(done, items.length, item.name);
      try {
        const r = await processOne(item, {
          sizes,
          cfg,
          interpolation: 'automaticInterpolation',   // 重采样算法的入口已去掉，交给 PS 自己挑
          fillHex: rzFillValue(),
          resolve: rzResolve,
          onStep: (m) => { lastStep = m; },
        });
        for (const one of r.results) {
          if (one.status === 'ok') ok++;
          else if (one.status === 'skip') skip++;
          else { fail++; rzFails.push({ name: item.name, reason: one.reason || '未知原因' }); }
        }
        rzLogRow(item.name, r.results);
      } catch (e) {
        fail++;
        rzFails.push({ name: item.name, reason: errMsg(e) });
        rzLogRow(item.name, [{ status: 'fail', reason: errMsg(e) }]);
      }
      done++;
      rzStats(ok, skip, fail);
      rzProgress(done, items.length, item.name);
    }
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    const stopped = rzStopReq ? `已停止（剩 ${items.length - done} 张未处理）：` : '处理完成：';
    setStatus(`${stopped}成功 ${ok}，跳过 ${skip}，失败 ${fail}，耗时 ${secs} 秒`
      + (fail ? '\n点「失败记录」看具体原因。' : ''));
    if (!rzLastOut) rzLastOut = rzFolderCache.size ? Array.from(rzFolderCache.values())[0] : rzOutFolder;
    show('rzDoneRow', true);
    // 「失败记录」不置灰：.btn-off 是 pointer-events:none，点了什么都不会发生（真机反馈）。
    // 没有失败也该给个交代，弹窗里会写「这一批没有失败的文件」。
    // 跑完了：标题变「处理完成」、主按钮变「返回」（rzSyncRunBtn 在下面的 finally 里统一刷）
    rzDone = true;
    rzDirty = false;
  } finally {
    rzSetRunning(false);
    rzProgress(done, items.length, '');
  }
  return undefined;
}

/**
 * 打开输出文件夹。
 * 机制全在 resizer.js 的 revealFolder 里（PS 的 ExtendScript 桥 → shell.openPath），
 * 这儿只管兜底：两条路都不通时把路径**复制到剪贴板**，粘到资源管理器地址栏就到了 ——
 * 比让人对着一行长路径手敲实在，也把每条拒绝理由如实报出来。
 */
async function rzOpenOut() {
  const path = rzLastOut && (rzLastOut.nativePath || '');
  if (!path) return setStatus('这一批还没有产生输出文件夹。');
  let why = [];
  try {
    const r = await revealFolder(path);
    if (r && r.ok) return undefined;
    why = (r && r.why) || [];
  } catch (e) {
    why = [errMsg(e)];
  }
  let copied = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(path);
      copied = true;
    }
  } catch { copied = false; }
  setStatus(`打不开文件夹（${why.join('；') || '没有可用的接口'}）`
    + (copied ? '，路径已复制到剪贴板，粘到资源管理器地址栏即可：\n' : '，请手动前往：\n')
    + path);
  return undefined;
}

// ---- 预设 ----

function rzLoadPresets() {
  try { rzPresets = JSON.parse(prefGet(RZ_PRESET_KEY, '[]')) || []; } catch { rzPresets = []; }
  if (!Array.isArray(rzPresets)) rzPresets = [];
  rzRenderPresetMenu();
}
function rzSavePresets() {
  try { prefSet(RZ_PRESET_KEY, JSON.stringify(rzPresets)); } catch { /* 存不下就只在本次会话有效 */ }
  rzRenderPresetMenu();
}
const rzAllPresets = () => RZ_BUILTIN.concat(rzPresets);

function rzRenderPresetMenu() {
  const box = rzEl('rzPresetMenu');
  if (!box) return;
  box.innerHTML = `<span class="dd-item active" data-preset="-1">自定义</span>`
    + rzAllPresets().map((p, i) => `<span class="dd-item" data-preset="${i}">${esc(p.name)}</span>`).join('');
  // innerHTML 换掉了节点，重新挂一遍点击
  Array.from(document.querySelectorAll('#rzPresetMenu .dd-item')).forEach((it) => {
    it.addEventListener('click', () => {
      const i = parseInt(it.getAttribute('data-preset'), 10);
      rzEl('rzPresetValue').textContent = it.textContent;
      rzEl('rzPresetDd').classList.remove('open');
      setDdMaskedFields(false);
      ddItemClicked = true;
      if (i >= 0) rzApplyPreset(rzAllPresets()[i]);
      else rzApplyCustom();                        // 「自定义」不是个空选项：要把参数还原回去
    });
  });
}

/** 一套 cfg 铺回面板上的控件（预设与「自定义」都走这里，参数区跟着换） */
function rzApplyCfg(cfg) {
  const c = normalizeResizeCfg(cfg);
  rzMode = c.mode;
  setDropdownValue('rzModeDd', 'rzModeValue', 'data-mode', c.mode);
  rzEl('rzW').value = String(c.width);
  rzEl('rzH').value = String(c.height);
  rzEl('rzEdge').value = String(c.edge);
  rzEl('rzPercent').value = String(c.percent);
  rzEl('rzTimes').value = String(c.times);
  rzEl('rzMaxW').value = String(c.maxW);
  rzEl('rzMaxH').value = String(c.maxH);
  setPillActive('rzFitPills', 'data-fit', c.fit);
  // 预设里可能存着老版本的 small，现在没有这个入口了（一律放大到目标），读进来直接丢掉
  rzAnchor = c.anchor;
  rzSetAnchor(c.anchor);
  rzSyncMode();              // 参数区随模式重排（少了这一步就会「选回自定义还停在缩放那一页」）
  rzSaveMemory();
}

function rzApplyPreset(preset) {
  if (!preset || !preset.cfg) return;
  if (!rzCustomCfg) rzCustomCfg = rzCfg();     // 第一次套预设：先把用户自己那套收起来
  rzApplyCfg(preset.cfg);
  setStatus(`已应用预设：${preset.name}`);
}

/**
 * 下拉里选回「自定义」：把套预设之前那套参数原样还原（模式、参数区一起回来）。
 * 没有存过快照（本来就在自定义上）就什么都不动 —— 拿默认值去覆盖等于把用户填的清了。
 */
function rzApplyCustom() {
  if (!rzCustomCfg) return setStatus('当前就是自定义参数。');
  rzApplyCfg(rzCustomCfg);
  rzCustomCfg = null;
  return setStatus('已回到自定义参数。');
}

/** 手动改了模式 → 下拉的名字回到「自定义」（否则标签写着预设名、参数早已不是那一套） */
function rzMarkCustom() {
  const v = rzEl('rzPresetValue');
  if (v) v.textContent = '自定义';
  rzCustomCfg = null;
}

function rzAskName(title, initial) {
  rzEl('rzNameTitle').textContent = title;
  fieldSet(rzEl('rzNameInput'), initial);
  showOverlay('rzNameOverlay', true);
  setTipMaskedFields(false);
  return new Promise((res) => { rzNameDecider = res; });
}
function rzResolveName(v) {
  showOverlay('rzNameOverlay', false);
  if (rzNameDecider) { const d = rzNameDecider; rzNameDecider = null; d(v); }
}

async function rzSaveAsPreset() {
  const cfg = rzCfg();
  const dflt = cfg.mode === 'wh' ? `${cfg.width} × ${cfg.height}` : RZ_MODE_NAME[cfg.mode];
  const name = await rzAskName('保存为预设', dflt);
  if (!name) return;
  const at = rzPresets.findIndex((p) => p.name === name);
  const rec = { name, cfg };
  if (at >= 0) rzPresets[at] = rec; else rzPresets.push(rec);
  rzSavePresets();
  setStatus(`已保存预设：${name}`);
}

function rzRenderPresetList() {
  const box = rzEl('rzPresetList');
  if (!box) return;
  box.innerHTML = rzPresets.length
    ? rzPresets.map((p, i) => guideItemHtml(
      esc(p.name),
      esc(rzDescribePreset(p.cfg)),
      `<span class="gd-mini gd-apply" data-act="rz-apply:${i}">应用</span>`
      + `<span class="gd-mini" data-act="rz-rename:${i}">改名</span>`
      + `<span class="gd-mini" data-act="rz-pdel:${i}">删除</span>`,
    )).join('')
    : '<div class="gd-empty">还没有自己的预设。<br>把参数调好后点「存为预设」就会出现在这里。</div>';
  const ACTIONS = {
    'rz-apply': (i) => { showOverlay('rzPresetOverlay', false); rzApplyPreset(rzPresets[i]); },
    'rz-rename': async (i) => {
      const name = await rzAskName('给这个预设改名', rzPresets[i].name);
      if (name) { rzPresets[i].name = name; rzSavePresets(); }
      rzRenderPresetList();
      showOverlay('rzPresetOverlay', true);
    },
    'rz-pdel': (i) => { rzPresets.splice(i, 1); rzSavePresets(); rzRenderPresetList(); },
  };
  Array.from(document.querySelectorAll('#rzPresetList .gd-mini')).forEach((el) => {
    const [kind, idx] = String(el.getAttribute('data-act') || '').split(':');
    const fn = ACTIONS[kind];
    if (fn) el.addEventListener('click', () => fn(parseInt(idx, 10)));
  });
}

function rzDescribePreset(cfg) {
  const c = normalizeResizeCfg(cfg);
  const mode = RZ_MODE_NAME[c.mode] || c.mode;
  if (c.mode === 'wh') return `${mode} ${c.width}×${c.height} · ${RZ_FIT_NAME[c.fit] || c.fit}`;
  if (c.mode === 'w') return `${mode} ${c.width}px`;
  if (c.mode === 'h') return `${mode} ${c.height}px`;
  if (c.mode === 'percent') return `${mode} ${c.percent}%`;
  if (c.mode === 'times') return `${mode} ${c.times}x`;
  if (c.mode === 'max') return `${mode} ${c.maxW}×${c.maxH}`;
  return `${mode} ${c.edge}px`;
}

function rzRenderFailList() {
  const box = rzEl('rzFailList');
  if (!box) return;
  box.innerHTML = rzFails.length
    ? rzFails.map((f) => guideItemHtml(esc(f.name), esc(f.reason), '')).join('')
    : '<div class="gd-empty">这一批没有失败的文件。</div>';
}

// ---- 参数记忆 ----

const RZ_MEM_KEYS = ['rzW', 'rzH', 'rzEdge', 'rzPercent', 'rzTimes', 'rzMaxW', 'rzMaxH', 'rzSuffix', 'rzTpl', 'rzQuality',
  'rzAddW', 'rzAddH', 'rzScales'];

/** 改过参数 —— 上一批的结果就不作数了（第 4 步的「返回」要变回「开始批量修改」） */
function rzTouch() { rzDirty = true; }

function rzSaveMemory() {
  rzTouch();
  prefSet('rz.mode', rzMode);
  prefSet('rz.fit', activePill('rzFitPills', 'data-fit') || 'contain');
  prefSet('rz.anchor', rzAnchor);
  prefSet('rz.fill', rzFill);
  prefSet('rz.fillHex', rzFillHex);
  prefSet('rz.fmt', rzFmt);
  prefSet('rz.name', rzNameMode);
  prefSet('rz.dup', rzDup);
  // 输出位置不记：文件夹入口跨会话拿不回来（跟切图的导出位置一个道理），
  // 重开面板就回到「原文件所在位置」这个默认
  prefSet('rz.keepTree', rzChecked('rzKeepTree') ? '1' : '0');
  prefSet('rz.webpLossless', rzChecked('rzWebpLossless') ? '1' : '0');
  prefSet('rz.sizes', JSON.stringify(rzSizes));
  for (const k of RZ_MEM_KEYS) prefSet(`rz.v.${k}`, rzVal(k));
}

function rzRestoreMemory() {
  const dflt = { rzW: '1920', rzH: '1080', rzEdge: '2048', rzPercent: '50', rzTimes: '2', rzMaxW: '2048', rzMaxH: '2048', rzSuffix: '_resized', rzTpl: '{name}_{width}x{height}', rzQuality: '90', rzScales: '1,2,3' };
  for (const k of RZ_MEM_KEYS) {
    const el = rzEl(k);
    if (el) el.value = prefGet(`rz.v.${k}`, dflt[k] || '');
  }
  rzMode = prefGet('rz.mode', 'wh');
  setDropdownValue('rzModeDd', 'rzModeValue', 'data-mode', rzMode);
  setPillActive('rzFitPills', 'data-fit', prefGet('rz.fit', 'contain'));
  rzAnchor = prefGet('rz.anchor', 'cm');
  rzSetAnchor(rzAnchor);
  rzFill = prefGet('rz.fill', 'none');
  setPillActive('rzFillPills', 'data-fill', rzFill);
  rzFillHex = prefGet('rz.fillHex', '#ffffff');
  const sw = rzEl('rzFillSwatch');
  if (sw) sw.style.background = rzFillHex;
  rzFmt = prefGet('rz.fmt', 'same');
  setDropdownValue('rzFmtDd', 'rzFmtValue', 'data-fmt', rzFmt);
  rzNameMode = prefGet('rz.name', 'keep');
  setDropdownValue('rzNameDd', 'rzNameValue', 'data-name', rzNameMode);
  rzDup = prefGet('rz.dup', 'rename');
  setDropdownValue('rzDupDd', 'rzDupValue', 'data-dup', rzDup);
  // 归一一下再收：存下来的可能是上个版本的列表，也可能被手改坏了
  let saved = [];
  try { saved = JSON.parse(prefGet('rz.sizes', '[]')); } catch { saved = []; }
  rzSizes = normalizeSizeList(saved);
}

function rzSetAnchor(a) {
  Array.from(document.querySelectorAll('#rzAnchorGrid .rz-anchor')).forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-anchor') === a);
  });
}

// ---- 接线 ----

bindPillGroup('rzSrcPills', 'data-src', (v) => { rzSrc = v; rzTouch(); rzSyncSrc(); rzSyncOut(); });
bindPillGroup('rzFitPills', 'data-fit', () => { rzSyncMode(); rzSaveMemory(); });
bindPillGroup('rzFillPills', 'data-fill', async (v) => {
  rzFill = v;
  show('rzFillSwatch', v === 'custom');
  if (v === 'custom') {
    try {
      const hex = await pickColor(rzFillHex);
      if (hex) { rzFillHex = hex; rzEl('rzFillSwatch').style.background = hex; }
    } catch { /* 取消拾色器 */ }
  }
  rzSaveMemory();
});
bindPillGroup('rzPercentQuick', 'data-percent', (v) => { rzEl('rzPercent').value = v; rzRenderPreview(); rzSaveMemory(); });
bindPillGroup('rzTimesQuick', 'data-times', (v) => { rzEl('rzTimes').value = v; rzRenderPreview(); rzSaveMemory(); });

bindDropdown('rzModeDd', 'rzModeValue', (item) => {
  rzMode = item.getAttribute('data-mode');
  rzMarkCustom();                    // 自己动过模式，就不再是那个预设了
  rzSyncMode();
  rzSaveMemory();
});
bindDropdown('rzFmtDd', 'rzFmtValue', (item) => { rzFmt = item.getAttribute('data-fmt'); rzSyncOut(); rzSaveMemory(); });
bindDropdown('rzNameDd', 'rzNameValue', (item) => { rzNameMode = item.getAttribute('data-name'); rzSyncOut(); rzSaveMemory(); });
bindDropdown('rzDupDd', 'rzDupValue', (item) => { rzDup = item.getAttribute('data-dup'); rzSaveMemory(); });
bindDropdown('rzPresetDd', 'rzPresetValue');       // 选项由 rzRenderPresetMenu 动态挂

// ⚠️ 只重扫【已经选好】的那个文件夹。走 rzPick 会再弹一次文件夹选择框 —— 真机反馈里
//    「无论开还是关都会出现文件夹选择弹窗」就是这么来的。还没选文件夹时什么都不做。
setupSwitch('rzRecursive', false, () => {
  if (!rzRoot) return;
  (async () => {
    try { await rzScanFolder(rzRoot); } catch (e) { setStatus(errMsg(e)); }
    rzSyncSrc();
    rzSyncOut();
  })();
});
setupSwitch('rzMulti', false, () => { rzSyncMode(); rzSaveMemory(); });
setupSwitch('rzKeepTree', true, rzSaveMemory);
setupSwitch('rzWebpLossless', true, () => { rzSyncOut(); rzSaveMemory(); });

rzEl('rzPickBtn').addEventListener('click', () => { rzPick(); });
rzEl('rzPickOutBtn').addEventListener('click', () => { rzPickOut(); });
rzEl('rzOutReset').addEventListener('click', () => { rzResetOut(); });
rzEl('rzPrevBtn').addEventListener('click', () => { rzGoStep(rzStep - 1); });
rzEl('rzNextBtn').addEventListener('click', () => { rzGoStep(rzStep + 1); });
rzEl('rzRunBtn').addEventListener('click', () => {
  // 跑完了：这个键是「返回」，回到第一步重新选图（结果面板与已选清单一并归零）
  if (rzDone && !rzRunning) { rzClearDone(); rzResetSource(); rzGoStep(1); return; }
  rzRun();
});
rzEl('rzSavePreset').addEventListener('click', () => { rzSaveAsPreset(); });
rzEl('rzManagePreset').addEventListener('click', () => { rzRenderPresetList(); showOverlay('rzPresetOverlay', true); });
rzEl('rzOpenOutBtn').addEventListener('click', () => { rzOpenOut(); });
rzEl('rzFailBtn').addEventListener('click', () => {
  // 没有失败也要有交代（弹窗里写着「这一批没有失败的文件」），状态栏再说一遍
  if (!rzFails.length) setStatus('这一批没有失败的文件。');
  rzRenderFailList();
  showOverlay('rzFailOverlay', true);
});
rzEl('rzPresetClose').addEventListener('click', () => showOverlay('rzPresetOverlay', false));
rzEl('rzFailClose').addEventListener('click', () => showOverlay('rzFailOverlay', false));
rzEl('rzNameOk').addEventListener('click', () => rzResolveName(rzVal('rzNameInput')));
rzEl('rzNameCancel').addEventListener('click', () => rzResolveName(''));
/** 往多尺寸列表里塞一档固定宽高；返回是否真的加进去了（重复的不加） */
function rzPushSize(w, h) {
  if (!(w > 0 && h > 0)) return false;
  if (rzSizes.some((s) => s.width === w && s.height === h)) return false;
  rzSizes.push({ width: w, height: h });
  return true;
}
/** 往多尺寸列表里塞一档倍率（相对每张原图，不折成绝对像素 —— 每张图的原尺寸不一样） */
function rzPushScale(k) {
  if (!(k > 0)) return false;
  if (rzSizes.some((s) => s.times === k)) return false;
  rzSizes.push({ times: k });
  return true;
}
function rzSizesChanged() {
  rzSaveMemory();
  rzRenderSizes();
  rzRenderPreview();
}
// 「添加」用的是它自己那两个输入框（默认带出上面填的那一档），所以想加几档就加几档 ——
// 原来只能加「当前尺寸」，一档加完得回上面改宽高才能加第二档。
rzEl('rzAddSize').addEventListener('click', () => {
  const w = Math.round(numOr(rzVal('rzAddW'), 0));
  const h = Math.round(numOr(rzVal('rzAddH'), 0));
  if (!(w > 0 && h > 0)) return setStatus('要添加的宽和高都得填大于 0 的数值。');
  if (!rzPushSize(w, h)) return setStatus(`${w} × ${h} 已经在列表里了。`);
  rzSizesChanged();
  return setStatus(`已添加 ${w} × ${h}`);
});
// 倍率的基准是**每张原图自己的尺寸**，不是上面那行填的宽高 —— @2x 就该是「原图的两倍」。
// （折成绝对像素是不对的：一批图横竖大小都不同，折一次就把所有图钉死在同一个尺寸上了。）
rzEl('rzAddScales').addEventListener('click', () => {
  const ks = parseScaleList(rzVal('rzScales'));
  if (!ks.length) return setStatus('倍率填成用逗号隔开的数字，如 1,2,3（最多 8 档、单档不超过 20 倍）。');
  let added = 0;
  for (const k of ks) if (rzPushScale(k)) added++;
  if (!added) return setStatus('这些倍率都已经在列表里了。');
  rzSizesChanged();
  return setStatus(`已按原图的 ${ks.join('、')} 倍添加 ${added} 档`);
});
Array.from(document.querySelectorAll('#rzAnchorGrid .rz-anchor')).forEach((el) => {
  el.addEventListener('click', () => {
    rzAnchor = el.getAttribute('data-anchor');
    rzSetAnchor(rzAnchor);
    rzSaveMemory();
  });
});
// 步骤指示器上的 1234 直接点着换页，前后都能点、不设卡（校验只在「开始批量修改」时做，
// 缺什么就跳到那一步说清楚）。处理中 rzGoStep 自己会拦住不动。
Array.from(document.querySelectorAll('#rzSteps .rz-step')).forEach((el) => {
  el.addEventListener('click', () => {
    const n = parseInt(el.getAttribute('data-step'), 10);
    if (n && n !== rzStep) rzGoStep(n);
  });
});
// 尺寸/命名相关的输入改动实时反映到预览与命名示例上
for (const id of ['rzW', 'rzH', 'rzEdge', 'rzPercent', 'rzTimes', 'rzMaxW', 'rzMaxH']) {
  const el = rzEl(id);
  if (el) el.addEventListener('input', () => { rzRenderPreview(); rzSaveMemory(); });
}
for (const id of ['rzSuffix', 'rzTpl', 'rzQuality']) {
  const el = rzEl(id);
  if (el) el.addEventListener('input', () => { rzSyncOut(); rzSaveMemory(); });
}
// 多尺寸那两行只需要记住，不用重画什么（列表要点「添加」才变）
for (const id of ['rzAddW', 'rzAddH', 'rzScales']) {
  const el = rzEl(id);
  if (el) el.addEventListener('input', rzSaveMemory);
}
// 四种适应方式的说明：挂在「适应方式」后面那个问号上
bindTip(rzEl('rzFitInfo'), rzEl('rzFitTip'), RZ_FIT_TIP);
// 保存位置两个选项的说明：挂在「保存位置」后面那个问号上
bindTip(rzEl('rzDestInfo'), rzEl('rzDestTip'), rzDestTipHtml);   // 传函数：悬停时才知道当前输出到哪儿

rzRestoreMemory();
rzLoadPresets();

// 文档打开 / 关闭 / 切换时刷新画布尺寸与按钮可用性（需求 §29 / §30）。
// 只在停留在参考线页时才刷，避免在别的功能页做无谓的开销。
(async () => {
  try {
    await action.addNotificationListener(['open', 'close', 'newDocument'], () => {
      if (currentPage === 'guide') refreshGuideDocState();
      if (currentPage === 'split') refreshGuideSplitInfo();   // 换文档 → 参考线也换了
      renderRenamePreview();               // 换文档后重命名页的预览也得跟着变
    });
  } catch { /* 某些版本不触发这些通知：切到本页时也会刷新一次 */ }
})();

// 顶栏版本号：始终显示 manifest 中的真实版本
const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = 'v' + manifest.version;

// 所有文字输入框统一挂上「聚焦高亮 + 点进去清空」。放在最后：各功能页自己那些
// input/keydown 监听都注册完了，通用行为排在它们后面触发，不会抢在前面把值清掉
for (const id of TEXT_FIELDS) bindTextField(document.getElementById(id));

renderRenamePreview();                                // 初始渲染一次
updateSliceLabel();                                    // 初始化主按钮文字
refreshLayoutBtn();                                    // 初始化排版按钮可用性
refreshMoveBtns();                                     // 初始化平移按钮可用性
setStatus('插件已加载');
