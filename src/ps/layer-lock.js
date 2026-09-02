// PS API 小工具：批量读图层锁定状态。一键排版与快速平移共用。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。

const { action } = require('photoshop');

/**
 * 读出「动不了」的图层。
 * 完全锁定（protectAll）与锁定位置（protectPosition）都会让 move 失败，等同处理。
 * 描述符读不到时返回空集合，调用方应再用 DOM 的 layer.locked 兜底。
 * @param {number[]} ids
 * @returns {Promise<Set<number>>}
 */
export async function readLockedIds(ids) {
  const locked = new Set();
  if (!ids?.length) return locked;
  try {
    const res = await action.batchPlay(ids.map((id) => ({
      _obj: 'get', _target: [{ _property: 'layerLocking' }, { _ref: 'layer', _id: id }],
    })), {});
    res.forEach((d, i) => {
      const lk = d && d.layerLocking;
      if (lk && (lk.protectAll || lk.protectPosition)) locked.add(ids[i]);
    });
  } catch { /* 读不到就交给调用方的 DOM 兜底 */ }
  return locked;
}
