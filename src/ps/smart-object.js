// PS API 封装：批量转智能对象 —— 把选中的图层逐个转换为独立智能对象。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
//
// 核心难点：PS 原生「转换为智能对象」会把当前所有选中图层合并进同一个 SO。
//   解法：模态内逐个「只选中这一层 → newPlacedLayer」，每个图层独立成 SO，绝不合并。
//
// 单次撤销（快照折叠）：逐层转换会各占一条历史状态（batchPlay 层面无法合并，
//   historyStateInfo/coalesce/单次调用多描述符均实测无效）。折叠手法：
//   转换完成 → 拍「转换后」快照 → 把历史指针拨回转换前 → 再恢复该快照。
//   恢复动作会在指针处追加一条状态并【截断】中间的逐层转换状态——
//   最终历史里只有一条「批量转智能对象」，Ctrl+Z 一次即全部恢复普通图层。
//   两步原语（make/select snapshotClass）与 exporter.js 快照回退同款，真机已验证。
//
// 保真：newPlacedLayer 是 PS 原地转换，图层名称/顺序/位置/所在组/不透明度/
//   混合模式/可见性/锁定状态与视觉效果全部保留。

const { app, action, core } = require('photoshop');

function findLayerById(container, id) {
  for (const l of container.layers ?? []) {
    if (l.id === id) return l;
    if (l.layers) { const f = findLayerById(l, id); if (f) return f; }
  }
  return null;
}

/**
 * 批量把图层转换为独立智能对象。
 * @param {number[]} layerIds 选中的图层/组 id（调用前收集；转换某层不影响其它层 id）
 * @param {{onProgress?:(done:number,total:number)=>void}} opts
 * @returns {Promise<{converted:number, skippedSO:number, failed:number}>}
 *          converted 成功转换数；skippedSO 已是智能对象被跳过数；failed 转换失败数
 */
export async function convertToSmartObjects(layerIds, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 PSD 文档');

  // 先分类（在模态外读 kind）：已是智能对象的直接跳过，避免二次嵌套
  const targets = [];
  let skippedSO = 0;
  for (const id of layerIds) {
    const l = findLayerById(doc, id);
    if (!l) continue;                                // 图层已不存在（中途被删等）
    if (l.kind === 'smartObject') { skippedSO++; continue; }
    targets.push(id);
  }
  if (!targets.length) return { converted: 0, skippedSO, failed: 0 };

  let converted = 0, failed = 0;
  await core.executeAsModal(async () => {
    const historyOptions = {
      historyStateInfo: {
        name: '批量转智能对象',
        target: { _ref: 'document', _id: doc.id },
      },
    };
    const selectDesc = (id) => ({
      // 只选中这一层（select 不带叠加修饰符 = 替换当前选区；makeVisible 不强制点亮）
      _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false,
      _options: { dialogOptions: 'dontDisplay' },
    });
    const placedDesc = () => ({
      // 把当前选中的（=这一个）图层原地转为智能对象
      _obj: 'newPlacedLayer', _options: { dialogOptions: 'dontDisplay' },
    });
    // 仍待转换的目标 id（跳过已不存在 / 已转好的）
    const pending = () => targets.filter((id) => {
      const l = findLayerById(doc, id);
      return l && l.kind !== 'smartObject';
    });

    const histBefore = doc.activeHistoryState;   // 转换前的历史位置（折叠锚点）

    // 1) 一次性整批调用：全部「选中→转换」拼进一次 batchPlay（快一些；历史随后统一折叠）
    let ids = pending();
    if (ids.length) {
      try {
        await action.batchPlay(ids.flatMap((id) => [selectDesc(id), placedDesc()]), historyOptions);
      } catch { /* 整批调用被某个坏图层中断：下面逐层兜底 */ }
    }

    // 2) 兜底：仍有未转换的 → 逐层转换，单层失败只计数不中断
    for (const id of pending()) {
      try {
        await action.batchPlay([selectDesc(id), placedDesc()], historyOptions);
      } catch { /* 单层失败不中断 */ }
      onProgress(targets.length - pending().length, targets.length);
    }

    // 3) 终态统计：原目标中已是 SO 的算成功；不存在/未转成算失败
    for (const id of targets) {
      const l = findLayerById(doc, id);
      if (l && l.kind === 'smartObject') converted++; else failed++;
    }
    onProgress(targets.length, targets.length);

    // 4) 历史折叠（只有真转换过才做）：拍「转换后」快照 → 指针拨回转换前 → 恢复快照。
    //    恢复会在指针处追加状态并截断中间的逐层转换状态 → 历史只剩一条。
    if (converted > 0) {
      const SNAP = 'sliceman_so';
      try {
        const histAfter = doc.activeHistoryState;      // 转换后位置（折叠失败的恢复点）
        await action.batchPlay([{
          _obj: 'make', _target: [{ _ref: 'snapshotClass' }],
          from: { _ref: 'historyState', _property: 'currentHistoryState' },
          name: SNAP, using: { _enum: 'historyState', _value: 'fullDocument' },
          _options: { dialogOptions: 'dontDisplay' },
        }], {});
        try {
          doc.activeHistoryState = histBefore;         // 拨回转换前（不追加状态）
          await action.batchPlay([{                    // 恢复快照：追加 + 截断中间状态
            _obj: 'select', _target: [{ _ref: 'snapshotClass', _name: SNAP }],
            _options: { dialogOptions: 'dontDisplay' },
          }], {});
        } catch {
          // 折叠中途失败：把指针拨回「转换后」，保住转换结果（历史保持多条，不再强求）
          try { doc.activeHistoryState = histAfter; } catch { /* 忽略 */ }
        }
        try {
          await action.batchPlay([{                    // 清理临时快照（不影响历史状态）
            _obj: 'delete', _target: [{ _ref: 'snapshotClass', _name: SNAP }],
            _options: { dialogOptions: 'dontDisplay' },
          }], {});
        } catch { /* 忽略 */ }
      } catch { /* 拍快照失败：跳过折叠，功能本身不受影响 */ }
    }
  }, { commandName: '批量转智能对象' });   // 模态名与历史名一致，历史面板显示清晰

  return { converted, skippedSO, failed };
}
