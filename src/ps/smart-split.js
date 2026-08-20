// PS API 封装：智能分割 —— 识别像素图层中互不相连的内容块，
// 把每一块复制成原文档里的独立图层（原图层保持不变）。
//
// ⚠️ 本文件依赖 Photoshop 运行时（imaging / batchPlay），无法在 Node 下单测。
//    连通域算法本身在 lib/segment.js 中、已单测覆盖；这里只负责"读像素 →
//    调算法 → 按块复制回原文档"的 PS 侧编排。
//
// 关键约束：select / 可见性 / duplicate / copy / paste 等"会改动 Photoshop 状态"
//   的事件只能在 executeAsModal 模态内执行；模态外一碰就报
//   "Event: select may modify the state of Photoshop … only allowed from inside a modal scope"。
//   因此整个分割流程收进【一个】长模态里执行，连通域算法（纯 JS）也在模态内调用。
//
// 提取手法（不碰 crop/undo，最稳）：工作文档里把目标图层 mergeVisible 拍平成底稿层，
//   之后底稿层全程不动；对每块在其上建矩形选区 → copy → paste 出该块临时层 →
//   把这块临时层 duplicate 回原文档目标上方 → 删掉临时层。如此逐块提取，互不干扰。

import { findElementBounds } from '../lib/segment.js';

const { app, action, core, imaging } = require('photoshop');

const WORK_DOC = '__sliceman_split';

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

/** 只显示指定图层（隐藏其余全部，祖先组一并显示）——会改状态，须在模态内调用。 */
async function showOnly(doc, layer) {
  for (const l of allLayers(doc)) l.visible = false;
  layer.visible = true;
  let p = layer.parent;
  while (p && p.id !== doc.id && p.layers) { p.visible = true; p = p.parent; }
}

/** 选中某图层并为其建一个矩形选区（文档坐标）。 */
async function selectRect(doc, layer, box) {
  await action.batchPlay([
    { _obj: 'select', _target: [{ _ref: 'layer', _id: layer.id }], makeVisible: false,
      _options: { dialogOptions: 'dontDisplay' } },
    { _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }],
      to: { _obj: 'rectangle',
        top: { _unit: 'pixelsUnit', _value: box.top },
        left: { _unit: 'pixelsUnit', _value: box.left },
        bottom: { _unit: 'pixelsUnit', _value: box.bottom },
        right: { _unit: 'pixelsUnit', _value: box.right } },
      _options: { dialogOptions: 'dontDisplay' } },
  ], {});
}

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
 * 智能分割主流程。
 * @param {number} sourceLayerId 原文档中要分割的像素图层 id
 * @param {{onProgress?:(done:number,total:number)=>void, shouldStop?:()=>boolean, onStep?:(msg:string)=>void}} opts
 *        onStep：分步回调，用于在面板状态栏直接看到每个环节 OK/失败（绕开 UDT 控制台）
 * @returns {Promise<{created:number, blocks:number}>}
 */
export async function smartSplitLayer(sourceLayerId, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const onStep = opts.onStep || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  const srcDoc = app.activeDocument;
  if (!srcDoc) throw new Error('请先打开一个 PSD 文档');
  const srcDocId = srcDoc.id;
  const srcLayer = findLayerById(srcDoc, sourceLayerId);
  if (!srcLayer) throw new Error('找不到要分割的图层');
  if (srcLayer.kind === 'group') throw new Error('请选中一个像素图层（不是组）');
  const baseName = srcLayer.name || '元素';

  await closeWorkDoc();                              // 清掉上次可能遗留的工作文档

  let result = { created: 0, blocks: 0 };
  try {
    // 整个分割在一个长模态内完成：内部所有 select/可见性/copy/paste/duplicate 都合法。
    result = await core.executeAsModal(async () => {
      // 1) 复制出工作文档并切到它（duplicate + 切换活动文档都是状态修改，必须在模态内）
      const workDoc = await srcDoc.duplicate(WORK_DOC);
      app.activeDocument = workDoc;
      onStep('1 复制工作文档 ok');

      // 2) 只显示目标图层并拍平底稿层，读其 alpha 网格
      const target = findLayerById(workDoc, sourceLayerId);
      if (!target) throw new Error('在工作文档中找不到目标图层');
      onStep('2 找到目标图层 ok');
      await showOnly(workDoc, target);
      await action.batchPlay([{ _obj: 'mergeVisible' }], {});
      const flat = workDoc.layers[0];
      if (!flat) throw new Error('图层无可读内容');
      const b = flat.bounds;
      const width = b.right - b.left, height = b.bottom - b.top;
      if (width <= 0 || height <= 0) throw new Error('图层为空');
      onStep(`3 拍平 ok 尺寸 ${width}x${height}`);
      const px = await imaging.getPixels({
        layerID: flat.id,
        sourceBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      });
      const rgba = await px.imageData.getData();
      await px.imageData.dispose();
      onStep(`4 读像素 ok 字节 ${rgba.length}`);

      // 3) 连通域标记 → 各块边界框（加上图层在画布中的偏移）。纯 JS，不改 PS 状态。
      const boxes = findElementBounds(rgba, width, height, { factor: 2, minAreaPx: 64 })
        .map((r) => ({
          left: r.left + b.left, top: r.top + b.top,
          right: r.right + b.left, bottom: r.bottom + b.top,
        }));
      onStep(`5 连通域识别 ${boxes.length} 块`);
      if (boxes.length <= 1) return { created: 0, blocks: boxes.length };

      // 4) 逐块：选区 copy → paste 临时层 → duplicate 回原文档 → 删临时层。底稿层不动。
      let created = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (shouldStop()) break;
        onStep(`6.${i + 1} 建选区`);
        await selectRect(workDoc, flat, boxes[i]);
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
            try { await copied.moveAbove(srcLayer); } catch { /* 定位失败也保留（在顶层） */ }
            try { copied.name = `${baseName}_${i + 1}`; } catch { /* 命名失败不影响 */ }
            created++;
          }
          onStep(`6.${i + 1} duplicate结果=${copied ? 'ok' : '空'}`);
          try { await pasted.delete(); } catch { /* 忽略 */ }
        }
        onProgress(i + 1, boxes.length);
      }
      return { created, blocks: boxes.length };
    }, { commandName: '智能分割' });
  } finally {
    // 无论成功/失败/中途出错：关掉临时工作文档并切回原 PSD，不留下新文档
    await closeWorkDoc();
    await activateDoc(srcDocId);
  }
  return result;
}
