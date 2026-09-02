// 一键排版的纯逻辑：空间排序（识别行/列）→ 目标位置计算 → 画布扩展量。
// 不依赖 Photoshop，可在 Node 下单测（见 tests/layout-core.test.js）。
//
// 坐标系与 PS 一致：left/top 为小值，right/bottom 为大值，y 向下增大。

// 零尺寸对象（空图层、1px 细线）做除数时的下限，避免除零
const EPS = 0.01;

/** 两个区间的重叠长度占「较短那个区间」的比例；不重叠为 0 或负 */
function overlapRatio(aStart, aEnd, bStart, bEnd) {
  const ov = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  const minLen = Math.max(EPS, Math.min(aEnd - aStart, bEnd - bStart));
  return ov / minLen;
}

/**
 * 把对象按「视觉行」或「视觉列」分带。
 * 不用坐标相等判断（真实素材高度/顶边都不一致），而是按 Bounds 重叠比：
 * 与某条带重叠超过自身一半即归入该带，否则另起一带。
 *
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} items
 * @param {'y'|'x'} axis 'y'=分行（比较 top/bottom）；'x'=分列（比较 left/right）
 * @returns {Array<{start:number,end:number,members:Array<{it:object,i:number}>}>}
 *          带按主轴起点升序；带内成员按次轴起点升序
 */
export function groupIntoBands(items, axis) {
  const rows = axis === 'y';
  const S = rows ? 'top' : 'left';        // 主轴起点：分行看 top，分列看 left
  const E = rows ? 'bottom' : 'right';
  const CS = rows ? 'left' : 'top';       // 次轴起点：行内按 left 排，列内按 top 排
  const CE = rows ? 'right' : 'bottom';

  // 主轴起点升序入带；并列时按次轴起点、再按原始下标，保证结果稳定可预测
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) =>
    (a.it[S] - b.it[S]) || (a.it[CS] - b.it[CS]) || (a.i - b.i));

  const bands = [];
  for (const m of sorted) {
    // 归入重叠最多的那条带（可能同时压着两条，取重叠比最大者）；平手时保留先建的带
    let best = null, bestOv = 0;
    for (const b of bands) {
      const r = overlapRatio(m.it[S], m.it[E], b.start, b.end);
      if (r >= 0.5 && r > bestOv) { best = b; bestOv = r; }
    }
    if (best) {
      best.members.push(m);
      best.start = Math.min(best.start, m.it[S]);
      best.end = Math.max(best.end, m.it[E]);
    } else {
      bands.push({ start: m.it[S], end: m.it[E], members: [m] });
    }
  }

  // 带内：次轴起点升序（行内从左到右 / 列内从上到下）
  for (const b of bands) {
    b.members.sort((a, c) =>
      (a.it[CS] - c.it[CS])                                        // 主判据：次轴起点
      || ((a.it[CS] + a.it[CE]) - (c.it[CS] + c.it[CE]))           // 起点相同：比中心点
      || (a.it[S] - c.it[S])                                       // 再相同：比主轴起点
      || (a.i - c.i));                                             // 兜底：原始下标，杜绝随机序
  }
  // 带间：主轴起点升序（上面的行优先 / 左边的列优先）
  bands.sort((a, b) =>
    (a.start - b.start)
    || (a.members[0].it[CS] - b.members[0].it[CS])
    || (a.members[0].i - b.members[0].i));
  return bands;
}

/**
 * 智能空间排序：按对象在画布中的实际位置定序，而非图层面板顺序。
 * 横排 = 从上到下识别行、行内从左到右；竖排 = 从左到右识别列、列内从上到下。
 * @param {Array<object>} items 带 left/top/right/bottom 的对象
 * @param {'h'|'v'} direction
 * @returns {Array<object>} 排好序的原对象引用
 */
export function orderItems(items, direction) {
  return groupIntoBands(items, direction === 'h' ? 'y' : 'x')
    .flatMap((b) => b.members.map((m) => m.it));
}

/** 方向对应的默认对齐方式 */
export function defaultAlign(direction) {
  return direction === 'h' ? 'bottom' : 'left';
}

/**
 * 计算每个对象的位移量。
 *
 * 锚点 = 排序后的第一个对象（横排：最上一行的最左；竖排：最左一列的最上），位移恒为 0，
 * 其余对象依次排在它后面，相邻两者的「实际边缘」间距 = gap。
 *
 * 位移一律取整：像素图层做小数位移会被重采样发虚。游标用「取整后的实际落位」推进，
 * 因此取整误差不会沿链累积，每段间距与设定值最多差 1px。
 *
 * @param {Array<{id:*,left:number,top:number,right:number,bottom:number}>} items
 * @param {{direction?:'h'|'v', align?:string, gap?:number}} opts
 *        align 横排 top|middle|bottom；竖排 left|center|right
 * @returns {{ordered:Array, moves:Array<{id:*,dx:number,dy:number}>,
 *            bounds:{left:number,top:number,right:number,bottom:number}|null}}
 *          bounds 为排版后所有对象的整体外接框（供画布扩展判断）
 */
export function planLayout(items, opts = {}) {
  const direction = opts.direction === 'v' ? 'v' : 'h';
  const horizontal = direction === 'h';
  const align = opts.align || defaultAlign(direction);
  const gap = Math.max(0, Number(opts.gap) || 0);

  const ordered = orderItems(items, direction);
  if (!ordered.length) return { ordered: [], moves: [], bounds: null };

  const anchor = ordered[0];
  const moves = [{ id: anchor.id, dx: 0, dy: 0 }];
  let uL = anchor.left, uT = anchor.top, uR = anchor.right, uB = anchor.bottom;
  let cursor = horizontal ? anchor.right : anchor.bottom;   // 上一个对象在主轴上的实际末端

  for (let i = 1; i < ordered.length; i++) {
    const it = ordered[i];
    const w = it.right - it.left;
    const h = it.bottom - it.top;
    let tx, ty;
    if (horizontal) {
      tx = cursor + gap;
      ty = align === 'top' ? anchor.top
        : align === 'middle' ? (anchor.top + anchor.bottom) / 2 - h / 2
          : anchor.bottom - h;                               // 默认底部对齐
    } else {
      ty = cursor + gap;
      tx = align === 'left' ? anchor.left
        : align === 'center' ? (anchor.left + anchor.right) / 2 - w / 2
          : anchor.right - w;                                // 右侧对齐
    }
    const dx = Math.round(tx - it.left);
    const dy = Math.round(ty - it.top);
    moves.push({ id: it.id, dx, dy });

    const L = it.left + dx, T = it.top + dy, R = it.right + dx, B = it.bottom + dy;
    cursor = horizontal ? R : B;
    if (L < uL) uL = L;
    if (T < uT) uT = T;
    if (R > uR) uR = R;
    if (B > uB) uB = B;
  }
  return { ordered, moves, bounds: { left: uL, top: uT, right: uR, bottom: uB } };
}

/**
 * 计算画布四个方向各需扩展多少像素。
 * 只在「真的超出画布」的方向上扩，且扩到留出 margin 的边距；从不缩小画布。
 * @param {{left:number,top:number,right:number,bottom:number}} bounds 排版后整体外接框
 * @param {{width:number,height:number}} canvas 当前画布尺寸
 * @param {number} margin 画布边距（与对象间距相互独立）
 * @returns {{left:number,top:number,right:number,bottom:number}} 各方向扩展量（≥0）
 */
export function planCanvas(bounds, canvas, margin) {
  const m = Math.max(0, Number(margin) || 0);
  if (!bounds) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: bounds.left < 0 ? Math.ceil(-bounds.left + m) : 0,
    top: bounds.top < 0 ? Math.ceil(-bounds.top + m) : 0,
    right: bounds.right > canvas.width ? Math.ceil(bounds.right - canvas.width + m) : 0,
    bottom: bounds.bottom > canvas.height ? Math.ceil(bounds.bottom - canvas.height + m) : 0,
  };
}
