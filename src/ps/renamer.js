// PS API 封装：批量重命名 —— 读选中图层的面板顺序 + 批量写回图层名。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
// 纯逻辑（模式/编号/预览）在 src/lib/rename-core.js，有单测。
//
// 单步撤销：优先官方 doc.suspendHistory——回调内的全部改动自动合并为一条历史，
//   Ctrl+Z 一步全撤销（API 自带示例就是"回调里改 layer.name"）。
//   旧版 PS（无 suspendHistory）退回 executeAsModal 循环：历史多条、可多次撤销。
//   ⚠️ 绝不手动拨 activeHistoryState / make+select 快照折叠：真机实测该手法用在
//   改名流程上会弹「新建快照」窗、历史倒回文档打开状态、未保存的图层全部消失。
//   （smart-object.js 的折叠在其流程可用，此处不复用。）

const { app, action, core } = require('photoshop');

/**
 * 一次 batchPlay 读回一批图层的 itemIndex（面板顺序依据）。
 * Action Manager 约定：itemIndex 自面板底部向上递增（底层=1），
 * 因此「从上到下」= itemIndex 降序。DOM Layer 没有该属性，必须走 batchPlay。
 * @param {number[]} layerIds
 * @returns {Promise<Map<number,number>>} id → itemIndex；读取失败/不全时返回空 Map（调用方走兜底）
 */
export async function readItemIndexes(layerIds) {
  if (!layerIds.length) return new Map();
  try {
    const res = await action.batchPlay(layerIds.map((id) => ({
      _obj: 'get',
      _target: [{ _property: 'itemIndex' }, { _ref: 'layer', _id: id }],
      _options: { dialogOptions: 'dontDisplay' },
    })), {});
    const map = new Map();
    res.forEach((r, i) => {
      const v = r?.itemIndex?._value;
      if (typeof v === 'number') map.set(layerIds[i], v);
    });
    return map;
  } catch { return new Map(); }
}

/**
 * 批量写回图层名：整个批量合并为一条历史（suspendHistory），Ctrl+Z 一步全撤销。
 * @param {Array<{id:number,name:string}>} pairs 要改名的图层 id 与新名（调用方已过滤掉空名/未变行）
 * @returns {Promise<{renamed:number,failed:number}>}
 */
export async function applyRename(pairs) {
  if (!pairs?.length) return { renamed: 0, failed: 0 };
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 PSD 文档');
  let renamed = 0, failed = 0;

  const doRenames = async () => {
    const setDesc = (p) => ({
      _obj: 'set',
      _target: [{ _ref: 'layer', _id: p.id }],
      to: { _obj: 'layer', name: p.name },
      _options: { dialogOptions: 'dontDisplay' },
    });
    // 全部「改名」拼进一次 batchPlay（最快）；被某个坏图层中断再逐个兜底。
    // 改名是幂等操作，整批失败后整批重试也安全。
    try {
      await action.batchPlay(pairs.map(setDesc), {});
      renamed = pairs.length;
    } catch {
      renamed = 0;
      for (const p of pairs) {
        try { await action.batchPlay([setDesc(p)], {}); renamed++; } catch { failed++; }
      }
    }
  };

  // 优先官方 suspendHistory：回调内全部改动合并为一条「批量重命名图层」历史。
  if (typeof doc.suspendHistory === 'function') {
    try {
      await doc.suspendHistory(doRenames, '批量重命名图层');
      return { renamed, failed };
    } catch (e) {
      // suspendHistory 本身不可用（一层都没动过）→ 换传统模态重试；
      // 已动过层却抛错则如实上抛，避免二次执行掩盖真实故障。
      if (renamed > 0 || failed > 0) throw e;
    }
  }
  await core.executeAsModal(doRenames, { commandName: '批量重命名图层' });
  return { renamed, failed };
}
