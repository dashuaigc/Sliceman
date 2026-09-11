// 纯逻辑：参考线 → 网格单元格 → 每格内容的真实外框。
//
// 参考线分割的两件事都在这里，PS 侧（src/ps/smart-split.js）只负责按这些矩形去
// 选区 / 复制 / 贴回，所以这一层可以在 Node 下完整单测。
//
// 坐标约定与 PS 的 layer.bounds 一致：left/top 含、right/bottom 不含
//   （宽 = right - left）。全部是【画布坐标、整数像素】。
//
// ⚠️ 参考线坐标的基准是标尺原点（见 src/ps/guides.js 头部）。用户在 PS 里拖动过
//    标尺原点时读回来的值就是偏的，这里不补偿——只做防御：落在画布外的丢弃，
//    切不出格子就报错，不闷头切出一堆错位图层。

export const ERR_NO_CANVAS = '读不到画布尺寸，请先打开一个 Photoshop 文档。';
export const ERR_NO_GUIDES = '当前文档没有参考线，请先创建参考线再分割。';
export const ERR_ONE_CELL = '参考线没有把画布切开（只有 1 块），无需分割。';

/** 取数：坐标可能是 number 或 {_value}（PS 各版本的 UnitValue） */
function num(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v._value === 'number') return v._value;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : NaN;
}

/**
 * 某一轴上的切割边界：画布两端 + 落在画布内的参考线，取整、升序、1px 内视为同一条。
 * 为什么要 1px 去重：参考线坐标是浮点，两条肉眼重合的线取整后会差 0 或 1px，
 * 不去重就会切出宽 0 / 宽 1 的碎条。
 */
function boundaries(list, size) {
  const all = [0, size];
  for (const raw of list || []) {
    const p = Math.round(num(raw));
    if (!Number.isFinite(p)) continue;
    if (p <= 0 || p >= size) continue;         // 压在画布边缘或跑到画布外：不是切线
    all.push(p);
  }
  all.sort((a, b) => a - b);
  const out = [];
  for (const p of all) {
    if (!out.length || p - out[out.length - 1] >= 1) out.push(p);
  }
  return out;
}

/**
 * 参考线 → 网格单元格（画布坐标、整数像素、行主序：从上到下、每行从左到右）。
 *
 * 画布边缘算作外边界，所以 3 条竖线 = 4 列。横竖任一方向没有参考线时，
 * 该方向只有一个区间——于是「只拖竖线」自然切出整条的列。
 *
 * @param {{vertical:number[], horizontal:number[]}} guides 当前文档的参考线坐标
 * @param {{width:number, height:number}} canvas 画布尺寸（px）
 * @returns {{cells:Array<{left:number,top:number,right:number,bottom:number,row:number,col:number}>,
 *            cols:number, rows:number, error?:string}}
 *          row/col 从 1 开始，只用于显示（结果图层按顺序号命名）
 */
export function cellsFromGuides(guides, canvas) {
  const w = canvas ? num(canvas.width) : NaN;
  const h = canvas ? num(canvas.height) : NaN;
  if (!(w > 0) || !(h > 0)) return { cells: [], cols: 0, rows: 0, error: ERR_NO_CANVAS };

  const raw = ((guides && guides.vertical) || []).length
    + ((guides && guides.horizontal) || []).length;
  if (!raw) return { cells: [], cols: 0, rows: 0, error: ERR_NO_GUIDES };

  const xs = boundaries(guides.vertical, w);
  const ys = boundaries(guides.horizontal, h);
  const cells = [];
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      cells.push({
        left: xs[c], top: ys[r], right: xs[c + 1], bottom: ys[r + 1], row: r + 1, col: c + 1,
      });
    }
  }
  const cols = Math.max(0, xs.length - 1);
  const rows = Math.max(0, ys.length - 1);
  if (cells.length <= 1) return { cells, cols, rows, error: ERR_ONE_CELL };
  return { cells, cols, rows };
}

/**
 * 每个单元格里【内容】的紧贴外框（画布坐标）；整格没有不透明像素 → null。
 *
 * 一次解决两件事：
 *   · 空白格靠它筛掉（切出来也是空图层，没意义）；
 *   · PS 的 paste 是把剪贴板【居中】贴进选区的，而图层边界永远是非透明像素的紧贴
 *     外框——内容偏在格子一角时贴回来就会跑位。这个外框就是校正位移的目标位置。
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba 拍平层的像素（长度 = 宽*高*4）
 * @param {{left:number,top:number,right:number,bottom:number}} bounds rgba 对应的画布区域
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} cells 单元格
 * @param {number} [alphaThreshold] 判定「有内容」的 alpha 下限（0-255）
 * @returns {Array<{left:number,top:number,right:number,bottom:number}|null>} 与 cells 同序
 */
export function contentBoxes(rgba, bounds, cells, alphaThreshold = 8) {
  const bw = bounds.right - bounds.left;
  const bh = bounds.bottom - bounds.top;
  return (cells || []).map((cell) => {
    // 先与像素缓冲的范围求交：格子超出拍平层的部分一定是空的
    const x0 = Math.max(0, cell.left - bounds.left);
    const y0 = Math.max(0, cell.top - bounds.top);
    const x1 = Math.min(bw, cell.right - bounds.left);
    const y1 = Math.min(bh, cell.bottom - bounds.top);
    if (x1 <= x0 || y1 <= y0) return null;

    let minX = x1, minY = y1, maxX = x0 - 1, maxY = y0 - 1;
    for (let y = y0; y < y1; y++) {
      const row = y * bw;
      for (let x = x0; x < x1; x++) {
        if (rgba[(row + x) * 4 + 3] < alphaThreshold) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) return null;      // 整格全透明
    return {
      left: minX + bounds.left,
      top: minY + bounds.top,
      right: maxX + 1 + bounds.left,
      bottom: maxY + 1 + bounds.top,
    };
  });
}
