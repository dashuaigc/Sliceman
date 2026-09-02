// PS API 封装：一键排版 —— 按对象在画布中的实际空间位置重排选中的图层/组。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
// 纯算法（行列识别 / 位移计算 / 画布扩展量）在 src/lib/layout-core.js，有单测。
//
// 只改位置：move + offset 是 PS 原地位移，不栅格化、不改图层类型/尺寸/层级/内容，
//   文字仍是文字、智能对象仍是智能对象，组作为整体移动、组内结构不变。
//
// 为什么逐个「选中→移动」而不是一次 batchPlay 全部移完：
//   move 的 offset 作用于当前选区，整批拼一次调用虽然快，但中途某层失败会整调用抛错、
//   已移的层却已生效；重试就会二次位移把版排乱。逐个调用则单层失败只计数，不影响其余。
//
// 单步撤销：优先官方 doc.suspendHistory（与 group-maker.js 同款，回调内全部位移 + 画布
//   扩展合并成一条「一键排版」历史）。旧版 PS 无此 API 时退回 executeAsModal。
//   ⚠️ 不复用 smart-object.js 的快照折叠：那套手法只在转 SO 流程验证过。

import { planLayout, planCanvas } from '../lib/layout-core.js';
import { readLockedIds } from './layer-lock.js';

const { app, action, core } = require('photoshop');

const dontDisplay = { dialogOptions: 'dontDisplay' };
const px = (v) => ({ _unit: 'pixelsUnit', _value: v });

/** 取数：bounds 各字段在不同 PS 版本里是 number 或 {_value} */
function n(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v._value === 'number') return v._value;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : 0;
}

function findLayerById(container, id) {
  for (const l of container.layers ?? []) {
    if (l.id === id) return l;
    if (l.layers) { const f = findLayerById(l, id); if (f) return f; }
  }
  return null;
}

// 只选中这一层（select 不带修饰符 = 替换当前选区；makeVisible 不点亮隐藏层——
// 用户主动选中的隐藏层要参与排版，但排完仍保持隐藏）
const selectOne = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false, _options: dontDisplay,
});
const addToSel = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false,
  selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
  _options: dontDisplay,
});
// 把当前选中的（=这一个）对象整体平移
const moveBy = (dx, dy) => ({
  _obj: 'move', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
  to: { _obj: 'offset', horizontal: px(dx), vertical: px(dy) },
  _options: dontDisplay,
});
// 扩画布：锚点定在不动的一侧，新增区域只出现在超出的方向（不缩放、不居中扩）
const setCanvas = (w, h, hLoc, vLoc) => ({
  _obj: 'canvasSize',
  width: px(w), height: px(h),
  horizontal: { _enum: 'horizontalLocation', _value: hLoc },
  vertical: { _enum: 'verticalLocation', _value: vLoc },
  _options: dontDisplay,
});

/**
 * 读对象边界。优先 boundsNoEffects：间距按图层主体算，
 * 避免带投影/外发光的图层与邻居之间空出一大截（需求 §34）。
 */
function readBounds(layer) {
  let b = null;
  try { b = layer.boundsNoEffects; } catch { /* 老版本无此属性 */ }
  const ok = (x) => x && (n(x.right) - n(x.left) > 0 || n(x.bottom) - n(x.top) > 0);
  if (!ok(b)) { try { b = layer.bounds; } catch { b = null; } }
  if (!b) return null;
  return { left: n(b.left), top: n(b.top), right: n(b.right), bottom: n(b.bottom) };
}

/**
 * 一键排版。
 * @param {number[]} layerIds 参与排版的图层/组 id（应为「最外层选中项」，组内子层不要传）
 * @param {{direction?:'h'|'v', align?:string, gap?:number,
 *          expandCanvas?:boolean, margin?:number,
 *          onProgress?:(done:number,total:number)=>void}} opts
 * @returns {Promise<{moved:number, failed:number, total:number, skipped:number,
 *                    locked:string[], expanded:{left,top,right,bottom}|null}>}
 *          locked 非空表示未做任何改动，调用方据此提示用户解锁
 */
export async function layoutLayers(layerIds, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 PSD 文档');

  // 1) 读边界与锁定状态（模态外读，读不到边界的对象直接排除在排版之外）
  const lockedByDesc = await readLockedIds(layerIds);
  const items = [];
  const lockedNames = [];
  let skipped = 0;
  for (const id of layerIds) {
    const l = findLayerById(doc, id);
    if (!l) { skipped++; continue; }                       // 中途被删
    // 背景图层钉死在画布上，与"完全锁定"同等处理
    if (lockedByDesc.has(id) || l.locked === true || l.isBackgroundLayer === true) {
      lockedNames.push(l.name);
      continue;
    }
    const b = readBounds(l);
    if (!b || (b.right - b.left <= 0 && b.bottom - b.top <= 0)) { skipped++; continue; }  // 空图层无边界
    items.push({ id, ...b });
  }
  // 有锁定图层就整体不动：排一半再报错会留下更难收拾的现场
  if (lockedNames.length) {
    return { moved: 0, failed: 0, total: 0, skipped, locked: lockedNames, expanded: null };
  }
  if (items.length < 2) {
    return { moved: 0, failed: 0, total: items.length, skipped, locked: [], expanded: null };
  }

  // 2) 算位移与画布扩展量（纯逻辑，出错前不碰文档）
  const { moves, bounds } = planLayout(items, {
    direction: opts.direction, align: opts.align, gap: opts.gap,
  });
  const expand = opts.expandCanvas
    ? planCanvas(bounds, { width: n(doc.width), height: n(doc.height) }, opts.margin)
    : { left: 0, top: 0, right: 0, bottom: 0 };
  const needExpand = expand.left || expand.top || expand.right || expand.bottom;

  let moved = 0, failed = 0;
  const todo = moves.filter((m) => m.dx !== 0 || m.dy !== 0);   // 锚点等零位移的不必下发

  const doLayout = async () => {
    moved = 0; failed = 0;
    // 3) 逐个「选中 → 平移」
    for (const m of todo) {
      try {
        await action.batchPlay([selectOne(m.id), moveBy(m.dx, m.dy)], {});
        moved++;
      } catch {
        failed++;                                  // 单层失败（如中途被锁）只计数，其余照排
      }
      onProgress(moved + failed, todo.length);
    }

    // 4) 扩画布：先右/下（锚点定左上），再左/上（锚点定右下）。
    //    分两次是因为一次 canvasSize 只能定一个锚点，合并会变成居中扩、原内容跟着位移。
    if (needExpand) {
      try {
        if (expand.right || expand.bottom) {
          await action.batchPlay([setCanvas(
            n(doc.width) + expand.right, n(doc.height) + expand.bottom, 'left', 'top',
          )], {});
        }
        if (expand.left || expand.top) {
          await action.batchPlay([setCanvas(
            n(doc.width) + expand.left, n(doc.height) + expand.top, 'right', 'bottom',
          )], {});
        }
      } catch { /* 扩画布失败不回滚已排好的版，结果里如实报出 */ }
    }

    // 5) 恢复排版前的选择：第一个替换选区，其余追加（需求 §35）
    try {
      const alive = layerIds.filter((id) => findLayerById(doc, id));
      if (alive.length) {
        await action.batchPlay(alive.map((id, i) => (i === 0 ? selectOne(id) : addToSel(id))), {});
      }
    } catch { /* 选择恢复失败不影响排版结果 */ }
  };

  // 优先官方 suspendHistory：回调内全部位移与扩画布合并成一条「一键排版」历史
  if (typeof doc.suspendHistory === 'function') {
    try {
      await doc.suspendHistory(doLayout, '一键排版');
      return { moved, failed, total: items.length, skipped, locked: [], expanded: needExpand ? expand : null };
    } catch (e) {
      // suspendHistory 本身不可用（一层都没动过）→ 换传统模态重试；
      // 已经动过则如实上抛，避免二次执行把对象再排一遍
      if (moved > 0 || failed > 0) throw e;
    }
  }
  await core.executeAsModal(doLayout, { commandName: '一键排版' });
  return { moved, failed, total: items.length, skipped, locked: [], expanded: needExpand ? expand : null };
}
