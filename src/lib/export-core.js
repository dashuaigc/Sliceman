// 切图的纯几何逻辑。与 PS 无关，可在 Node 下单测。

/**
 * 「完整导出超出画布部分」要把画布扩到多大。
 *
 * 为什么不直接用 Photoshop 的 Reveal All：它把【隐藏】图层也算进去。真机实测——
 * 200×200 的画布里放一个被挪到 (3000,3000) 且已隐藏的层，revealAll 把画布撑到
 * 3080×3080。而切图用的工作文档装着整个 PSD 的图层（只是把非目标层隐藏），于是
 * 每导出一张都会把画布撑到覆盖全 PSD，后面的合并与 trim 全在巨图上做，慢得离谱。
 * 所以这里只按【这一轮真会合并的那些层】算，画布始终是紧的。
 *
 * @param {Array<{left:number, top:number, right:number, bottom:number}>} rects
 *        参与合并的像素图层各自的边界（空数组 / 全是空层都返回 null）
 * @param {number} docW 当前画布宽
 * @param {number} docH 当前画布高
 * @returns {?{left:number, top:number, right:number, bottom:number}}
 *          需要扩画布时给出目标矩形（左/上可为负，crop 到画布外会补透明）；
 *          内容完全落在画布内、不需要动时返回 null
 */
export function computeBleedRect(rects, docW, docH) {
  let vb = null;
  for (const r of rects || []) {
    if (!r) continue;
    if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue;   // 空层不参与
    vb = vb ? {
      left: Math.min(vb.left, r.left),
      top: Math.min(vb.top, r.top),
      right: Math.max(vb.right, r.right),
      bottom: Math.max(vb.bottom, r.bottom),
    } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  if (!vb) return null;
  // 与现画布取并集：只扩不缩 —— 画布内的部分一寸都不能少
  const rect = {
    left: Math.min(0, Math.floor(vb.left)),
    top: Math.min(0, Math.floor(vb.top)),
    right: Math.max(docW, Math.ceil(vb.right)),
    bottom: Math.max(docH, Math.ceil(vb.bottom)),
  };
  const unchanged = rect.left === 0 && rect.top === 0
    && rect.right === docW && rect.bottom === docH;
  return unchanged ? null : rect;
}
