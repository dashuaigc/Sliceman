// 创建定位格的纯几何：间距 → 行列 → 每格坐标 → 画布 → 参考线。
// 不碰 Photoshop API，可在 Node 下单测（tests/gridcell-core.test.js）。
//
// 贯穿全篇的一条硬规则：**一切结果都是整数像素**。
// 间距、格子坐标、画布尺寸、参考线位置（含中心线）全部四舍五入取整，
// 绝不把 83.5 / 500.5 这种半像素交给 PS —— 形状层会糊边，参考线也吸不住。
// 代价是整套定位格在画布里可能偏心 1px，这是需求明确允许的取舍。

import { sortDedupe } from './guide-core.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

/** 单次创建的上限。纯属自保：一个格子 = 一个形状层 + 最多 6 条参考线，
 *  数量失控时 PS 会卡到像死机。需求没给上限，这里给一个够用又不至于把 PS 拖垮的数。 */
export const MAX_COUNT = 999;

/**
 * 间距（§5 §6）：宽高平均值的 1/8，即 (宽 + 高) ÷ 16，四舍五入取整。
 * 下限 1px —— 格子只有几像素时公式会算出 0，那样格子会互相粘死、画布也不留边距。
 */
export function gapOf(width, height) {
  const g = Math.round((num(width) + num(height)) / 16);
  return Number.isFinite(g) ? Math.max(1, g) : 1;
}

/** 整体外框宽度（§12）：C×W + (C-1)×S */
export const blockWidth = (cols, width, gap) => cols * width + (cols - 1) * gap;
/** 整体外框高度（§12）：R×H + (R-1)×S */
export const blockHeight = (rows, height, gap) => rows * height + (rows - 1) * gap;

// 1～9 个用固定排列（§7），下标即数量：[列, 行]。
// 这张表不由「最接近正方形」推导 —— 5 个是 3+2、4 个是 2×2，是需求钉死的视觉习惯，
// 非方形格子下自动算法会给出别的答案，所以 9 个以内一律查表。
const FIXED = [null, [1, 1], [2, 1], [3, 1], [2, 2], [3, 2], [3, 2], [4, 2], [4, 2], [3, 3]];

/**
 * 行列布局（§7 §11）。
 * 9 个以内查固定表；10 个及以上遍历所有列数，挑「整体外框最接近正方形」的那组。
 * 注意判据是**外框实际像素宽高比**，不是列数行数之比 —— 扁格子（如 1000×200）
 * 排成 2×5 才方，排成 5×2 会宽得离谱。
 * @param {number} count 数量（≥1）
 * @param {number} width 单格宽
 * @param {number} height 单格高
 * @param {number} gap 间距
 * @returns {{cols:number, rows:number}}
 */
export function gridOf(count, width, height, gap) {
  const n = Math.max(1, Math.round(num(count) || 1));
  if (n <= 9) {
    const [cols, rows] = FIXED[n];
    return { cols, rows };
  }
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const bw = blockWidth(cols, width, gap);
    const bh = blockHeight(rows, height, gap);
    const ratio = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));   // 1 = 正方形
    const waste = cols * rows - n;                                    // 末行空位数
    if (!best || better({ ratio, waste, cols }, best)) best = { cols, rows, ratio, waste };
  }
  return { cols: best.cols, rows: best.rows };
}

/** 方正度优先；一样方正则末行空位少的优先；再一样则列多的优先（横向铺开，与 1～9 的表同取向） */
function better(a, b) {
  const EPS = 1e-9;
  if (a.ratio < b.ratio - EPS) return true;
  if (a.ratio > b.ratio + EPS) return false;
  if (a.waste !== b.waste) return a.waste < b.waste;
  return a.cols > b.cols;
}

/** 图层名（§4 §24）：两位起编号，超过 99 自然进位成三位 */
export const cellName = (n) => `定位格 ${String(n).padStart(2, '0')}`;

/**
 * 目标画布（§13～§15）。够装下就原样返回，装不下才扩到「外框 + 四周各一个间距」。
 * 只扩不够的那一边：画布本来就比需要的宽，没有理由把它改窄或改宽。
 * @param {{w:number,h:number}} block 整体外框尺寸
 * @param {{width:number,height:number}} canvas 当前画布
 * @param {number} gap 安全边距 = 间距（§14）
 */
export function planCanvas(block, canvas, gap) {
  const curW = Math.round(num(canvas?.width) || 0);
  const curH = Math.round(num(canvas?.height) || 0);
  const width = Math.max(curW, block.w + 2 * gap);
  const height = Math.max(curH, block.h + 2 * gap);
  return { width, height, expanded: width !== curW || height !== curH };
}

/** 整体外框在画布里居中的左上角（§17）。取整后可能偏心 1px，需求允许 */
export function originOf(block, canvas) {
  return {
    left: Math.round((num(canvas.width) - block.w) / 2),
    top: Math.round((num(canvas.height) - block.h) / 2),
  };
}

/**
 * 每格 6 条参考线（§18～§22）：四边 + 中心十字，中心线四舍五入到整数。
 * 相邻格子共用的边、以及与中心线重合的位置只留一条 —— 否则 PS 文档里会堆一大堆
 * 完全重合的参考线，拖动时一拖一大把。
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} cells
 * @param {{vertical:number[], horizontal:number[]}} [existing] 文档里已有的参考线，一并去重
 */
export function guidesOf(cells, existing = { vertical: [], horizontal: [] }) {
  const v = [];
  const h = [];
  for (const c of cells) {
    v.push(c.left, c.right, Math.round((c.left + c.right) / 2));
    h.push(c.top, c.bottom, Math.round((c.top + c.bottom) / 2));
  }
  return {
    vertical: sortDedupe(v, existing.vertical || []),
    horizontal: sortDedupe(h, existing.horizontal || []),
  };
}

/**
 * 参数校验（§28）。通过返回 null，不通过返回 {field, message}，
 * field 用来在界面上标红对应的输入框。
 * @param {{width:*, height:*, count:*, color:*}} p
 * @param {{hasDoc?:boolean}} [env]
 */
export function validateGridCfg(p, env = {}) {
  if (env.hasDoc === false) return { field: 'doc', message: '请先打开一个 Photoshop 文档。' };
  if (!isPosInt(p.width)) return { field: 'width', message: '宽度：请输入大于 0 的整数' };
  if (!isPosInt(p.height)) return { field: 'height', message: '高度：请输入大于 0 的整数' };
  if (!isPosInt(p.count)) return { field: 'count', message: '数量：请输入大于 0 的整数' };
  if (Number(p.count) > MAX_COUNT) {
    return { field: 'count', message: `数量最多 ${MAX_COUNT} 个（再多 Photoshop 会很卡）` };
  }
  if (!/^#?[0-9a-f]{6}$/i.test(String(p.color || '').trim())) {
    return { field: 'color', message: '颜色：请填 #rrggbb 形式的色值' };
  }
  return null;
}

/** 严格的正整数：'12.5'、'abc'、空串、0、负数全部不算 */
function isPosInt(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return false;
  return Number(s) >= 1;
}

/**
 * 排列示意（§27）：每行一串方块，末行不足就短一截，直观看出「末行靠左不居中」。
 * 格子太多时画出来只会糊成一片，直接返回空数组，由界面改用文字描述。
 * @returns {string[]} 每个元素是一行，形如 '■ ■ ■ ■'
 */
export function previewRows(count, cols, limit = 60) {
  const n = Math.max(0, Math.round(num(count) || 0));
  const c = Math.max(1, Math.round(num(cols) || 1));
  if (n === 0 || n > limit) return [];
  const rows = [];
  for (let i = 0; i < n; i += c) rows.push(Array(Math.min(c, n - i)).fill('■').join(' '));
  return rows;
}

/**
 * 一次算完整份方案。
 * @param {{width:number, height:number, count:number}} p 已校验过的参数
 * @param {{width:number, height:number}} canvas 当前画布
 * @param {{expandCanvas?:boolean}} [opts] expandCanvas=false 则画布保持原样（格子可能落到画布外）
 * @returns {{gap:number, cols:number, rows:number, block:{w:number,h:number},
 *            canvas:{width:number,height:number,expanded:boolean},
 *            origin:{left:number,top:number}, fits:boolean,
 *            cells:Array<{index:number,name:string,left:number,top:number,right:number,bottom:number}>}}
 */
export function buildGrid(p, canvas, opts = {}) {
  const width = Math.round(num(p.width));
  const height = Math.round(num(p.height));
  const count = Math.round(num(p.count));
  const gap = gapOf(width, height);
  const { cols, rows } = gridOf(count, width, height, gap);
  const block = { w: blockWidth(cols, width, gap), h: blockHeight(rows, height, gap) };

  const cur = { width: Math.round(num(canvas?.width) || 0), height: Math.round(num(canvas?.height) || 0) };
  const target = opts.expandCanvas === false
    ? { ...cur, expanded: false }
    : planCanvas(block, cur, gap);
  const origin = originOf(block, target);

  const cells = [];
  for (let i = 0; i < count; i++) {
    const left = origin.left + (i % cols) * (width + gap);
    const top = origin.top + Math.floor(i / cols) * (height + gap);
    cells.push({
      index: i + 1,
      name: cellName(i + 1),
      left,
      top,
      right: left + width,
      bottom: top + height,
    });
  }

  return {
    gap,
    cols,
    rows,
    block,
    canvas: target,
    origin,
    // 关掉自动扩画布时，格子可能顶出画布外 —— 界面据此提醒一句，但照样创建
    fits: origin.left >= 0 && origin.top >= 0
      && origin.left + block.w <= target.width && origin.top + block.h <= target.height,
    cells,
  };
}
