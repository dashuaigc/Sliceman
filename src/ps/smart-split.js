// PS API 封装：分割 —— 把一个图层里的内容拆成原文档里的多个独立图层（原图层保持不变）。
// 两种切法共用同一条提取流水线，只差「矩形框从哪来」：
//   · 智能分割   —— 框来自连通域识别（lib/segment.js）
//   · 参考线分割 —— 框来自画布上的参考线（lib/guide-split.js）
//
// ⚠️ 本文件依赖 Photoshop 运行时（imaging / batchPlay），无法在 Node 下单测。
//    两种切法的几何都在 lib/ 里、已单测覆盖；这里只负责"读像素 → 调算法 →
//    按块复制回原文档"的 PS 侧编排。
//
// 关键约束：select / 可见性 / duplicate / copy / paste 等"会改动 Photoshop 状态"
//   的事件只能在 executeAsModal 模态内执行；模态外一碰就报
//   "Event: select may modify the state of Photoshop … only allowed from inside a modal scope"。
//   因此整个分割流程收进【一个】长模态里执行，连通域算法（纯 JS）也在模态内调用。
//
// 提取手法（不碰 crop/undo，最稳）：工作文档里把目标图层 mergeVisible 拍平成底稿层，
//   之后底稿层全程不动；对每块在其上建选区 → copy → paste 出该块临时层 →
//   把这块临时层 duplicate 回原文档目标上方 → 删掉临时层。如此逐块提取，互不干扰。
//
// 选区为什么不是一个矩形：互不相连的两个元素，外框却常常交叠（一个人物伸出的手臂
//   正好罩在另一个人物的裙摆上方）。按外框整块复制，邻居的像素就被切进这一层了
//   ——看起来就像"沿着直线横竖切"。所以智能分割给每块算出一批矩形（lib/segment.js
//   的 coverCells：贪心极大矩形，只覆盖自己的格子、绕开别人的），第一块 set、
//   其余 addTo 拼成非矩形选区。参考线分割的格子本就互不相交，仍是单个矩形。
//
// 落位为什么要选【内容的紧贴外框】而不是格子：PS 的 paste 是把剪贴板内容【居中】贴进
//   当前选区的，而图层边界永远等于非透明像素的紧贴外框。框就是内容外框时居中即原位；
//   拿参考线格子当框、内容又偏在格子一角，贴回来就会跑位。所以参考线那条路先算出每格
//   内容的真实外框再选区，并在最后比对一次实际落位、必要时补一条 move offset。

import { findElements } from '../lib/segment.js';
import { cellsFromGuides, contentBoxes } from '../lib/guide-split.js';

const { app, action, core, imaging } = require('photoshop');

const WORK_DOC = '__sliceman_split';

const dontDisplay = { dialogOptions: 'dontDisplay' };
const px = (v) => ({ _unit: 'pixelsUnit', _value: v });

/** 取数：PS 各版本里尺寸字段可能是 number 或 {_value} */
function n(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v._value === 'number') return v._value;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : NaN;
}

function findLayerById(container, id) {
  for (const l of container.layers ?? []) {
    if (l.id === id) return l;
    if (l.layers) { const f = findLayerById(l, id); if (f) return f; }
  }
  return null;
}

/** 收集容器内全部图层（含嵌套）。 */
function allLayers(container, out = []) {
  for (const l of container.layers ?? []) { out.push(l); if (l.layers) allLayers(l, out); }
  return out;
}

/**
 * mergeVisible 之后取底稿层。
 *
 * ⚠️ 不能用 doc.layers[0]（真机踩过：报 "Unsupported layer type"）。
 *    mergeVisible 只合并【可见】图层，隐藏的原样留在图层栈里 —— 栈顶那个很可能是
 *    某个隐藏的文字层 / 调整层 / 智能对象，拿它的 id 去 imaging.getPixels 就是这个错。
 *    只有「目标本来就在最顶上」时 layers[0] 才恰好是对的，所以以前一直没露馅。
 *
 * 合并后的判据：文档里【非组的可见图层只剩一个】，那就是底稿层
 *   （单目标模式下只有目标可见；合并可见模式下所有可见层都被并进了同一层）。
 *   组本身的 visible 也是 true，所以必须把组排掉。
 */
function findFlatLayer(doc) {
  const hit = allLayers(doc).filter((l) => l.visible && l.kind !== 'group');
  return hit[0] || doc.layers?.[0] || null;
}

/** 只显示指定图层（隐藏其余全部，祖先组一并显示）——会改状态，须在模态内调用。 */
async function showOnly(doc, layer) {
  for (const l of allLayers(doc)) l.visible = false;
  layer.visible = true;
  let p = layer.parent;
  while (p && p.id !== doc.id && p.layers) { p.visible = true; p = p.parent; }
}

const rectOf = (box) => ({
  _obj: 'rectangle', top: px(box.top), left: px(box.left), bottom: px(box.bottom), right: px(box.right),
});
const setSel = (box) => ({
  _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: rectOf(box), _options: dontDisplay,
});
// 追加一块到当前选区（原生「加选」）—— 多个矩形拼出非矩形选区靠它
const addSel = (box) => ({
  _obj: 'addTo', _target: [{ _ref: 'channel', _property: 'selection' }], to: rectOf(box), _options: dontDisplay,
});

const SEL_CHUNK = 200;            // 一次 batchPlay 里最多塞多少条选区操作

/**
 * 选中某图层并为其建选区（文档坐标）。
 * rects 只有一个就是普通矩形选区；多个则第一个 set、其余 addTo 拼成非矩形选区
 * —— 智能分割靠这个只选中「本元素自己的像素」，不把交叠的邻居切进来。
 */
async function selectRegion(doc, layer, rects) {
  await action.batchPlay([
    { _obj: 'select', _target: [{ _ref: 'layer', _id: layer.id }], makeVisible: false, _options: dontDisplay },
  ], {});
  const ops = rects.map((box, i) => (i === 0 ? setSel(box) : addSel(box)));
  for (let i = 0; i < ops.length; i += SEL_CHUNK) {
    await action.batchPlay(ops.slice(i, i + SEL_CHUNK), {});
  }
}

// ---- 收尾（编组 / 位移校正）用的描述符，与 group-maker.js / mover.js 同款 ----
const selectOne = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false, _options: dontDisplay,
});
const addToSel = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false,
  selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
  _options: dontDisplay,
});
// 把当前选中的图层原地编成一个组（原生 Ctrl+G 的语义）
const makeGroup = (name) => ({
  _obj: 'make',
  _target: [{ _ref: 'layerSection' }],
  from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
  using: { _obj: 'layerSection', name },
  _options: dontDisplay,
});
const setName = (id, name) => ({
  _obj: 'set', _target: [{ _ref: 'layer', _id: id }], to: { _obj: 'layer', name }, _options: dontDisplay,
});
// 栅格化某一层（只在临时工作文档里用，为的是让 imaging 读得动）
const rasterize = (id) => ({
  _obj: 'rasterizeLayer', _target: [{ _ref: 'layer', _id: id }], _options: dontDisplay,
});
const moveById = (id, dx, dy) => ({
  _obj: 'move', _target: [{ _ref: 'layer', _id: id }],
  to: { _obj: 'offset', horizontal: px(dx), vertical: px(dy) },
  _options: dontDisplay,
});

/** 关闭本次分割的临时工作文档（best-effort，独立小模态）。 */
async function closeWorkDoc() {
  try {
    await core.executeAsModal(async () => {
      for (const d of Array.from(app.documents)) {
        if (d.name === WORK_DOC) { try { await d.closeWithoutSaving(); } catch { /* 忽略 */ } }
      }
    }, { commandName: '清理分割临时文档' });
  } catch { /* 忽略 */ }
}

/** 切回指定文档（best-effort）。 */
async function activateDoc(docId) {
  try {
    await core.executeAsModal(async () => {
      const d = Array.from(app.documents).find((x) => x.id === docId);
      if (d) app.activeDocument = d;
    }, { commandName: '返回原文档' });
  } catch { /* 忽略 */ }
}

/**
 * 分割流水线（两种切法共用）。
 * @param {object} opts
 *   targetId   要分割的图层 id；null = 合并可见内容（不筛图层，结果落在原文档顶层）
 *   plan       (rgba, bounds) => { items:[{box, rects?, expect}], blocks:number, meta:object }
 *              box   该块的外框（选区兜底 / 落位比对用）
 *              rects 建选区用的矩形序列（省略 = 就用 box 一个矩形）
 *              expect 该块内容应落在的位置（可为 null）
 *   correct    true 时按 expect 比对实际落位、差 ≥1px 补一条 move offset
 *   groupName  非空则把本次新建的图层统一编进这个名字的新组
 *   onStep / onProgress / shouldStop 同旧版
 * @returns {Promise<{created:number, blocks:number, meta:object, grouped:boolean, fixed:number}>}
 */
async function runSplitPipeline(opts) {
  const onProgress = opts.onProgress || (() => {});
  const onStep = opts.onStep || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  const srcDoc = app.activeDocument;
  if (!srcDoc) throw new Error('请先打开一个 PSD 文档');
  const srcDocId = srcDoc.id;
  let srcLayer = null;
  if (opts.targetId != null) {
    srcLayer = findLayerById(srcDoc, opts.targetId);
    if (!srcLayer) throw new Error('找不到要分割的图层');
  }

  await closeWorkDoc();                              // 清掉上次可能遗留的工作文档

  let result = { created: 0, blocks: 0, meta: {}, grouped: false, fixed: 0 };
  try {
    // 整个分割在一个长模态内完成：内部所有 select/可见性/copy/paste/duplicate 都合法。
    result = await core.executeAsModal(async () => {
      // 1) 复制出工作文档并切到它（duplicate + 切换活动文档都是状态修改，必须在模态内）
      const workDoc = await srcDoc.duplicate(WORK_DOC);
      app.activeDocument = workDoc;
      onStep('1 复制工作文档 ok');

      // 2) 拍平底稿层并读其 alpha 网格。
      //    单目标：只显示目标图层再拍平；合并可见：不筛，直接拍平当前所有可见内容
      if (opts.targetId != null) {
        const target = findLayerById(workDoc, opts.targetId);
        if (!target) throw new Error('在工作文档中找不到目标图层');
        onStep('2 找到目标图层 ok');
        await showOnly(workDoc, target);
      } else {
        onStep('2 合并可见内容（不筛图层）');
      }
      await action.batchPlay([{ _obj: 'mergeVisible' }], {});
      let flat = findFlatLayer(workDoc);
      if (!flat) throw new Error('图层无可读内容');
      onStep(`3 底稿层 id=${flat.id} kind=${flat.kind}`);

      // 读像素。imaging 只认像素图层，遇到"没被合并掉"的智能对象 / 文字 / 形状会报
      // Unsupported layer type —— 那就把它栅格化再读一次（工作文档马上要丢，栅格化无副作用）。
      let rgba = null;
      let bounds = null;
      for (let attempt = 0; !rgba; attempt++) {
        const b = flat.bounds;
        bounds = { left: n(b.left), top: n(b.top), right: n(b.right), bottom: n(b.bottom) };
        const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
        if (!(width > 0) || !(height > 0)) throw new Error('图层为空');
        try {
          const pix = await imaging.getPixels({ layerID: flat.id, sourceBounds: bounds });
          rgba = await pix.imageData.getData();
          await pix.imageData.dispose();
          onStep(`4 读像素 ok 尺寸 ${width}x${height} 字节 ${rgba.length}`);
        } catch (e) {
          if (attempt) throw e;                            // 栅格化后还读不动：如实上抛
          onStep(`4 读像素失败（${e.message || e}）→ 栅格化后重试`);
          await action.batchPlay([rasterize(flat.id)], {});
          // 栅格化后对象可能失效，按 id 重新取；取不到就再找一次可见的底稿层
          flat = findLayerById(workDoc, flat.id) || findFlatLayer(workDoc);
          if (!flat) throw e;
        }
      }

      // 3) 算出每块的矩形（纯 JS，不改 PS 状态）
      const { items, blocks, meta } = opts.plan(rgba, bounds, onStep);
      if (!items.length) return { created: 0, blocks, meta, grouped: false, fixed: 0 };

      // 4) 逐块：选区 copy → paste 临时层 → duplicate 回原文档 → 删临时层。底稿层不动。
      let created = 0;
      const made = [];
      for (let i = 0; i < items.length; i++) {
        if (shouldStop()) break;
        const rects = items[i].rects && items[i].rects.length ? items[i].rects : [items[i].box];
        onStep(`6.${i + 1} 建选区（${rects.length} 块）`);
        try {
          await selectRegion(workDoc, flat, rects);
        } catch (e) {
          // 万一某版本 PS 不认 addTo：退回整框选区（会带进交叠邻居的像素，但不至于整批失败）
          if (rects.length === 1) throw e;
          onStep(`6.${i + 1} 加选失败（${e.message || e}）→ 退回整框`);
          await selectRegion(workDoc, flat, [items[i].box]);
        }
        onStep(`6.${i + 1} copy`);
        await action.batchPlay([{ _obj: 'copyEvent' }], {});
        onStep(`6.${i + 1} paste`);
        const pastedArr = await action.batchPlay([{ _obj: 'paste' }], {});
        const pastedId = pastedArr?.[0]?.ID ?? pastedArr?.[0]?.layerID;
        const pasted = (pastedId != null ? findLayerById(workDoc, pastedId) : null) || workDoc.activeLayers[0];
        onStep(`6.${i + 1} paste返回=${JSON.stringify(pastedArr && pastedArr[0])} 取到层=${pasted ? pasted.id : '无'}`);
        if (pasted) {
          onStep(`6.${i + 1} duplicate回原文档`);
          // 先跨文档复制到原文档顶层（duplicate 的目标是“文档”），再同文档内移动到原图层上方
          // ——duplicate(图层,'placeBefore') 是移动语义、不能跨文档，会报 only move layers in the same document
          const copied = await pasted.duplicate(srcDoc);
          if (copied) {
            if (srcLayer) { try { await copied.moveAbove(srcLayer); } catch { /* 定位失败也保留（在顶层） */ } }
            try { copied.name = String(i); } catch { /* 命名失败不影响 */ }   // 从 0 开始依次编号
            made.push({ layer: copied, expect: items[i].expect });
            created++;
          }
          onStep(`6.${i + 1} duplicate结果=${copied ? 'ok' : '空'}`);
          try { await pasted.delete(); } catch { /* 忽略 */ }
        }
        onProgress(i + 1, items.length);
      }

      // 5) 收尾：切片都已在原文档里，工作文档不再需要 —— 切回原文档做校正与编组
      //    （batchPlay 作用于活动文档，用 _id 指向别的文档里的图层是没保证的）
      let grouped = false;
      let fixed = 0;
      if (made.length && (opts.correct || opts.groupName)) {
        app.activeDocument = srcDoc;
        if (opts.correct) fixed = await fixPositions(made, onStep);
        if (opts.groupName) grouped = await groupLayers(srcDoc, made.map((m) => m.layer.id), opts.groupName, onStep);
      }
      return { created, blocks, meta, grouped, fixed };
    }, { commandName: opts.commandName || '分割' });
  } finally {
    // 无论成功/失败/中途出错：关掉临时工作文档并切回原 PSD，不留下新文档
    await closeWorkDoc();
    await activateDoc(srcDocId);
  }
  return result;
}

/**
 * 落位校正：比对实际图层边界与预期外框，差 ≥1px 才补一条整体位移。
 * 对了就不动——不平白挪图层。读不到边界时同样不动（宁可不校正）。
 * @returns {Promise<number>} 实际校正了几层
 */
async function fixPositions(made, onStep) {
  let fixed = 0;
  for (const m of made) {
    if (!m.expect) continue;
    try {
      const got = m.layer.bounds;
      const dx = m.expect.left - n(got.left);
      const dy = m.expect.top - n(got.top);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      await action.batchPlay([moveById(m.layer.id, dx, dy)], {});
      fixed++;
      onStep(`7 落位校正 ${m.layer.id}: ${dx},${dy}`);
    } catch { /* 单层校正失败不影响其余 */ }
  }
  return fixed;
}

/** 把这批图层编进一个新组（失败只记一笔，不影响已切好的图层）。 */
async function groupLayers(doc, ids, name, onStep) {
  if (!ids.length) return false;
  try {
    await action.batchPlay([
      ...ids.map((id, i) => (i === 0 ? selectOne(id) : addToSel(id))),
      makeGroup(name),
    ], {});
    // 兜底：某些 PS 版本忽略 make 描述符里的 using.name，这里补一次改名
    const g = Array.from(doc.activeLayers || []).find((l) => l.kind === 'group');
    if (g && g.name !== name) {
      try { await action.batchPlay([setName(g.id, name)], {}); } catch { /* 名字不对不算失败 */ }
    }
    onStep('8 编组 ok');
    return true;
  } catch {
    onStep('8 编组失败（切片已保留在原图层上方）');
    return false;
  }
}

/**
 * 智能分割：识别像素图层中互不相连的内容块，每块复制成独立图层。
 * @param {number} sourceLayerId 原文档中要分割的像素图层 id
 * @param {{onProgress?:(done:number,total:number)=>void, shouldStop?:()=>boolean,
 *          onStep?:(msg:string)=>void, merge?:boolean}} opts
 *        onStep：分步回调，用于在面板状态栏直接看到每个环节 OK/失败（绕开 UDT 控制台）
 * @returns {Promise<{created:number, blocks:number}>}
 */
export async function smartSplitLayer(sourceLayerId, opts = {}) {
  const mergeFragments = opts.merge !== false;   // 面板「保持元素完整」开关（面板默认关）
  const srcDoc = app.activeDocument;
  if (!srcDoc) throw new Error('请先打开一个 PSD 文档');
  const srcLayer = findLayerById(srcDoc, sourceLayerId);
  if (!srcLayer) throw new Error('找不到要分割的图层');
  if (srcLayer.kind === 'group') throw new Error('请选中一个像素图层（不是组）');

  const res = await runSplitPipeline({
    onStep: opts.onStep,
    onProgress: opts.onProgress,
    shouldStop: opts.shouldStop,
    commandName: '智能分割',
    targetId: sourceLayerId,
    correct: false,          // 连通域的框由 factor=2 降采样推出，比内容外框大 1~2px，
    groupName: null,         // 一开校正反而会把图层挪偏 —— 保持原有落位行为
    plan: (rgba, bounds, onStep) => {
      // 连通域标记（自适应合并）→ 各元素的外框 + 逐像素选区矩形（加上图层在画布中的偏移）
      // mergeGapPx：'auto'=自适应（细缝并回、网格按格分割）；0=纯连通域（面板关闭「保持元素完整」）
      const meta = {};
      const width = bounds.right - bounds.left;
      const height = bounds.bottom - bounds.top;
      const off = (r) => ({
        left: r.left + bounds.left, top: r.top + bounds.top,
        right: r.right + bounds.left, bottom: r.bottom + bounds.top,
      });
      const { elements } = findElements(rgba, width, height,
        { factor: 2, minAreaPx: 64, mergeGapPx: mergeFragments ? 'auto' : 0, info: meta });
      onStep(`5 连通域识别 ${elements.length} 块（合并前 ${meta.components} 块，阈值 ${meta.thresholdPx}px）`);
      // 外框交叠时按外框复制会把邻居切进来，所以每块都按自己的像素范围建选区
      onStep(`5b 选区矩形共 ${meta.rects} 块${meta.fallback ? `（其中 ${meta.fallback} 块太碎，退回整框）` : ''}`);
      return {
        items: elements.length <= 1 ? [] : elements.map((el) => ({
          box: off(el.box), rects: el.rects.map(off), expect: null,
        })),
        blocks: elements.length,
        meta,
      };
    },
  });
  return { created: res.created, blocks: res.blocks, mergeInfo: res.meta };
}

/**
 * 参考线分割：用画布上已有的参考线把内容切成网格，每格复制成独立图层。
 * 画布边缘算作外边界（3 条竖线 = 4 列），整格没有内容的自动跳过。
 *
 * @param {object} opts
 *   layerId   要切的图层/组 id；merged 为 true 时忽略
 *   merged    true = 先合并可见内容再切（不看选中）
 *   guides    {vertical:number[], horizontal:number[]}（来自 ps/guides.js 的 readExistingGuides）
 *   canvas    {width:number, height:number}
 *   groupName 切片统一放进的新组名
 *   onStep / onProgress / shouldStop 同上
 * @returns {Promise<{created:number, cells:number, skipped:number, cols:number, rows:number,
 *                    grouped:boolean, fixed:number}>}
 */
export async function splitByGuides(opts = {}) {
  const grid = cellsFromGuides(opts.guides, opts.canvas);
  if (grid.error) throw new Error(grid.error);

  const res = await runSplitPipeline({
    onStep: opts.onStep,
    onProgress: opts.onProgress,
    shouldStop: opts.shouldStop,
    commandName: '参考线分割',
    targetId: opts.merged ? null : opts.layerId,
    correct: true,
    groupName: opts.groupName || null,
    plan: (rgba, bounds, onStep) => {
      // alpha 阈值取 1（任何不全透明的像素都算内容）：这样算出来的外框与 PS 自己的
      // 图层边界口径一致，选区=内容外框，paste 居中即原位
      const boxes = contentBoxes(rgba, bounds, grid.cells, 1);
      const items = [];
      grid.cells.forEach((cell, i) => {
        if (boxes[i]) items.push({ box: boxes[i], expect: boxes[i], cell });
      });
      onStep(`5 参考线网格 ${grid.cols} 列 × ${grid.rows} 行 = ${grid.cells.length} 块，其中有内容 ${items.length} 块`);
      return { items, blocks: grid.cells.length, meta: { cols: grid.cols, rows: grid.rows, kept: items.length } };
    },
  });
  const kept = res.meta && res.meta.kept != null ? res.meta.kept : res.created;
  return {
    created: res.created,
    cells: grid.cells.length,
    skipped: grid.cells.length - kept,
    cols: grid.cols,
    rows: grid.rows,
    grouped: res.grouped,
    fixed: res.fixed,
  };
}
