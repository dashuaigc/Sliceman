// 视图（画布窗口可见区域）相关的纯计算。不依赖 Photoshop，可在 Node 下单测。
//
// Photoshop 没有「取当前可见区域」的现成 API，只能拼两个描述符：
//   viewTransform  —— 文档坐标 → 屏幕坐标的仿射矩阵（含缩放，旋转视图时还含旋转）
//   documentArea   —— 画布窗口在屏幕上的矩形
// 把 documentArea 的中心用 viewTransform 的逆变换映射回文档坐标，就是「视图中心」。
//
// 两个描述符在不同 PS 版本里的形状不完全一致（裸数字 / {_value} / 不同键名），
// 所以解析写得比较宽松；解析不出来一律返回 null，调用方退回画布中心。

/** 取出数值：裸数字、{_value:n}、字符串数字都认；否则 NaN */
export function dnum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  if (v && typeof v === 'object') {
    if (typeof v._value === 'number') return v._value;
    if (typeof v.value === 'number') return v.value;
  }
  return NaN;
}

/**
 * 解析 viewTransform → [a, b, c, d, tx, ty]（屏幕 = [a c; b d]·文档 + [tx, ty]）。
 * 已知会出现的形状：
 *   - 六元素数组（可能是裸数字，也可能是 {_value}）
 *   - {xx, xy, yx, yy, tx, ty} 之类的具名对象
 *   - 外面再包一层 {viewTransform: ...}
 * @returns {number[]|null}
 */
export function parseTransform(raw) {
  let v = raw;
  if (v && typeof v === 'object' && !Array.isArray(v) && v.viewTransform !== undefined) {
    v = v.viewTransform;
  }
  if (Array.isArray(v)) {
    if (v.length < 6) return null;
    const m = v.slice(0, 6).map(dnum);
    return m.every(Number.isFinite) ? m : null;
  }
  if (v && typeof v === 'object') {
    // 具名键的几种常见拼法，按顺序试
    const sets = [
      ['xx', 'xy', 'yx', 'yy', 'tx', 'ty'],
      ['a', 'b', 'c', 'd', 'tx', 'ty'],
      ['m00', 'm01', 'm10', 'm11', 'm02', 'm12'],
    ];
    for (const keys of sets) {
      const m = keys.map((k) => dnum(v[k]));
      if (m.every(Number.isFinite)) return m;
    }
  }
  return null;
}

/**
 * 解析一个矩形描述符 → {left, top, right, bottom}。
 * 认 left/top/right/bottom，也认 left/top + width/height。
 * @returns {{left:number,top:number,right:number,bottom:number}|null}
 */
export function parseRect(raw) {
  let v = raw;
  if (v && typeof v === 'object' && v.documentArea !== undefined) v = v.documentArea;
  if (!v || typeof v !== 'object') return null;
  const left = dnum(v.left), top = dnum(v.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  let right = dnum(v.right), bottom = dnum(v.bottom);
  if (!Number.isFinite(right)) {
    const w = dnum(v.width);
    if (!Number.isFinite(w)) return null;
    right = left + w;
  }
  if (!Number.isFinite(bottom)) {
    const h = dnum(v.height);
    if (!Number.isFinite(h)) return null;
    bottom = top + h;
  }
  if (!(right - left > 0) || !(bottom - top > 0)) return null;   // 空矩形当解析失败
  return { left, top, right, bottom };
}

/**
 * 屏幕坐标 → 文档坐标（对仿射矩阵求逆）。矩阵退化（det≈0）返回 null。
 * @param {{x:number,y:number}} pt 屏幕点
 * @param {number[]} m [a, b, c, d, tx, ty]
 */
export function screenToDoc(pt, m) {
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const sx = pt.x - tx, sy = pt.y - ty;
  return { x: (d * sx - c * sy) / det, y: (a * sy - b * sx) / det };
}

/**
 * 由两个原始描述符算出「当前视图中心」在文档中的坐标。
 * 任一环节解析不出来就返回 null，交给调用方退回画布中心。
 * @returns {{x:number,y:number}|null}
 */
export function viewCenterFromDescriptors(transformRaw, areaRaw) {
  const m = parseTransform(transformRaw);
  const rect = parseRect(areaRaw);
  if (!m || !rect) return null;
  const mid = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  const p = screenToDoc(mid, m);
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return p;
}

/**
 * 视图中心是否落在画布上（含一点点容差）。
 * 描述符解析出来的东西可能语义完全不是我以为的那个，算出个离谱的中心点会把
 * 表格画到画布外几千像素处——看起来就是「什么都没画出来」。挡在这里。
 */
export function isPlausibleCenter(center, canvas) {
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return false;
  const w = Number(canvas?.width), h = Number(canvas?.height);
  if (!(w > 0) || !(h > 0)) return false;
  const pad = 1;                                   // 边上一点点越界算正常（标尺误差）
  return center.x >= -pad && center.x <= w + pad && center.y >= -pad && center.y <= h + pad;
}

/**
 * 把表格摆到某个中心点上 —— 返回左上角坐标，取整到像素。
 * center 为 null 时退回画布中心，效果与改版前一致。
 * @param {{w:number,h:number}} size 表格总尺寸
 * @param {{width:number,height:number}} canvas 画布尺寸
 * @param {{x:number,y:number}|null} center 期望的中心点（文档坐标）
 */
export function originAtCenter(size, canvas, center) {
  const cx = center && Number.isFinite(center.x) ? center.x : canvas.width / 2;
  const cy = center && Number.isFinite(center.y) ? center.y : canvas.height / 2;
  return { left: Math.round(cx - size.w / 2), top: Math.round(cy - size.h / 2) };
}
