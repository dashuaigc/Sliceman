// PS API 封装：快速平移 —— 把选中的图层/组按同一个 X/Y 偏移量整体平移。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
// 纯逻辑（输入解析 / 负数归一 / 方向换算）在 src/lib/move-core.js，有单测。
//
// 与一键排版的区别：那边每个对象位移各不相同，只能逐个「选中→移动」；这边所有对象共用
//   同一个偏移量，PS 原生就支持「对当前选区整体平移」，所以一条 move 描述符搞定全部对象——
//   既是最快的写法，也天然只产生一条历史、只刷新一次画布。
//
// 父子去重：调用方传进来的应当是「最外层选中项」（panel.js 的 selectedLayers 已剔除
//   被选中组的后代），否则父组和子图层会各自吃一次位移、子图层跑出两倍距离。
//
// 保真：move + offset 是原地位移，不栅格化、不改尺寸/旋转/层级/组结构，只改位置。

import { readLockedIds } from './layer-lock.js';

const { app, action, core } = require('photoshop');

const dontDisplay = { dialogOptions: 'dontDisplay' };
const px = (v) => ({ _unit: 'pixelsUnit', _value: v });

function findLayerById(container, id) {
  for (const l of container.layers ?? []) {
    if (l.id === id) return l;
    if (l.layers) { const f = findLayerById(l, id); if (f) return f; }
  }
  return null;
}

// makeVisible:false —— 用户主动选中的隐藏层照样参与平移，且移完仍保持隐藏
const selectOne = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false, _options: dontDisplay,
});
const addToSel = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false,
  selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
  _options: dontDisplay,
});
// 对「当前选中的全部图层」整体平移
const moveSelection = (dx, dy) => ({
  _obj: 'move', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
  to: { _obj: 'offset', horizontal: px(dx), vertical: px(dy) },
  _options: dontDisplay,
});

/**
 * 按统一偏移量平移选中的对象。
 * @param {number[]} layerIds 最外层选中项的 id（组内子层不要传，见上文父子去重）
 * @param {number} dx 水平位移，右为正
 * @param {number} dy 垂直位移，下为正
 * @returns {Promise<{moved:number, skipped:number, lockedNames:string[]}>}
 *          skipped 为锁定/背景等动不了而被跳过的数量（不影响其余对象）
 */
export async function moveLayers(layerIds, dx, dy) {
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 PSD 文档');
  if (!layerIds?.length) return { moved: 0, skipped: 0, lockedNames: [] };
  if (!dx && !dy) return { moved: 0, skipped: 0, lockedNames: [] };   // 两轴都是 0：不下发

  // 分类：锁定/背景的跳过，其余照移（与一键排版不同，这里不因为锁定就整体中止）
  const lockedByDesc = await readLockedIds(layerIds);
  const movable = [];
  const lockedNames = [];
  for (const id of layerIds) {
    const l = findLayerById(doc, id);
    if (!l) continue;                                   // 中途被删：静默跳过
    if (lockedByDesc.has(id) || l.locked === true || l.isBackgroundLayer === true) {
      lockedNames.push(l.name);
      continue;
    }
    movable.push(id);
  }
  const skipped = lockedNames.length;
  if (!movable.length) return { moved: 0, skipped, lockedNames };

  const needReselect = movable.length !== layerIds.length;   // 有跳过项才动选区

  const doMove = async () => {
    // 全部可移动 → 直接对现有选区平移，一条描述符，连选区都不用碰；
    // 有锁定项 → 先把选区收窄到可移动的那些（否则 PS 会因为选区里有锁定层而整体拒绝）
    const desc = [];
    if (needReselect) movable.forEach((id, i) => desc.push(i === 0 ? selectOne(id) : addToSel(id)));
    desc.push(moveSelection(dx, dy));
    await action.batchPlay(desc, {});

    // 收窄过选区就恢复回用户原来的选择（含被跳过的锁定层）
    if (needReselect) {
      try {
        const alive = layerIds.filter((id) => findLayerById(doc, id));
        if (alive.length) {
          await action.batchPlay(alive.map((id, i) => (i === 0 ? selectOne(id) : addToSel(id))), {});
        }
      } catch { /* 选择恢复失败不影响已完成的平移 */ }
    }
  };

  // 单步撤销：整批平移（含收窄/恢复选区）合并成一条「快速平移」历史。
  // 不像 group-maker 那样「失败后换模态重试」——平移无法判断前一次是否已生效，
  // 重试一遍就会移出双倍距离，宁可如实上抛让用户重点一次。
  if (typeof doc.suspendHistory === 'function') {
    await doc.suspendHistory(doMove, '快速平移');
  } else {
    await core.executeAsModal(doMove, { commandName: '快速平移' });
  }
  return { moved: movable.length, skipped, lockedNames };
}
