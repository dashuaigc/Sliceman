/**
 * 智能分割的纯算法部分：把一张图（降采样后的 alpha 网格）做连通域标记，
 * 找出图中"互不相连的内容块"，返回每块的边界框（换算回原始像素坐标）。
 *
 * 本模块不依赖 photoshop / uxp，可在 Node 下用 vitest 单测。
 *
 * 算法：RLE 两趟连通标记 + 并查集合并相邻行的重叠游程。
 *   - 输入是稀疏的 alpha 网格（0/1），直接 RLE 比逐像素扫描快且省内存；
 *   - 8 连通（允许对角相连算同一块），贴合"视觉上是同一个元素"的直觉；
 *   - 过小的块（噪点/抗锯齿残影）按面积阈值过滤掉。
 */

/** 并查集（按秩合并 + 路径压缩） */
function makeDSU(n) {
  const parent = new Int32Array(n);
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a === b) return a;
    if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
    return a;
  };
  return { find, union };
}

/**
 * 从降采样网格提取每行的实心游程（run）。
 * @param {Uint8Array} alpha 长 w*h 的 0/1 网格（1=有内容）
 * @param {number} w
 * @param {number} h
 * @returns {Array<Array<{x0:number,x1:number}>>} 每行的游程列表（x1 为开区间右端）
 */
function extractRuns(alpha, w, h) {
  const rows = new Array(h);
  for (let y = 0; y < h; y++) {
    const runs = [];
    const base = y * w;
    let x = 0;
    while (x < w) {
      if (alpha[base + x]) {
        const x0 = x;
        while (x < w && alpha[base + x]) x++;
        runs.push({ x0, x1: x });
      } else x++;
    }
    rows[y] = runs;
  }
  return rows;
}

/**
 * 对 0/1 网格做 8 连通标记，返回各连通域的边界框（网格坐标）。
 * @param {Uint8Array} alpha 长 w*h 的 0/1 网格
 * @param {number} w
 * @param {number} h
 * @param {number} minArea 网格坐标下的最小面积（像素数），小于则判为噪点丢弃
 * @returns {Array<{left,top,right,bottom}>} 网格坐标边界框（right/bottom 为开区间）
 */
export function labelComponents(alpha, w, h, minArea = 1) {
  const rows = extractRuns(alpha, w, h);
  // 给每个游程分配一个初始标签 id，并记录其网格坐标区间与所在行
  const runs = [];               // {y, x0, x1}
  const rowRunIds = new Array(h);
  let id = 0;
  for (let y = 0; y < h; y++) {
    const ids = [];
    for (const r of rows[y]) { runs.push({ y, x0: r.x0, x1: r.x1 }); ids.push(id++); }
    rowRunIds[y] = ids;
  }
  const dsu = makeDSU(id);

  // 相邻行（y 与 y+1）之间：游程在 x 上"相交或仅隔 1 格"（含对角）即相连，合并。
  // 用双指针按 x 顺序扫两行游程；由于两端都有序，可在线性时间完成。
  for (let y = 0; y < h - 1; y++) {
    const aIds = rowRunIds[y], bIds = rowRunIds[y + 1];
    if (!aIds.length || !bIds.length) continue;
    const A = rows[y], B = rows[y + 1];
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      const ra = A[i], rb = B[j];
      // 8 连通：把上一行游程左右各外扩 1 格后与下一行游程做区间相交判定
      if (ra.x0 - 1 < rb.x1 && rb.x0 < ra.x1 + 1) {
        dsu.union(aIds[i], bIds[j]);
      }
      // 双指针推进：右端小的先走
      if (ra.x1 < rb.x1) i++; else if (rb.x1 < ra.x1) j++; else { i++; j++; }
    }
  }

  // 汇总每个根标签的边界框与面积
  const boxes = new Map();       // root -> {left,top,right,bottom,area}
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    const root = dsu.find(k);
    const area = r.x1 - r.x0;
    let b = boxes.get(root);
    if (!b) { b = { left: r.x0, top: r.y, right: r.x1, bottom: r.y + 1, area: 0 }; boxes.set(root, b); }
    b.left = Math.min(b.left, r.x0);
    b.top = Math.min(b.top, r.y);
    b.right = Math.max(b.right, r.x1);
    b.bottom = Math.max(b.bottom, r.y + 1);
    b.area += area;
  }

  return Array.from(boxes.values())
    .filter((b) => b.area >= minArea)
    .map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));
}

/**
 * 把 RGBA 像素缓冲降采样成 0/1 alpha 网格（取块内最大 alpha，>=阈值记 1）。
 * 降采样倍数 factor：factor=2 表示 2x2 像素合并为 1 格，提速并连通抗锯齿小缝。
 * @param {Uint8Array|Uint8ClampedArray} rgba 原始 RGBA（长度 width*height*4）
 * @param {number} width  原始宽
 * @param {number} height 原始高
 * @param {number} factor 降采样倍数（>=1 整数）
 * @param {number} alphaThreshold 判定"有内容"的 alpha 阈值（0-255）
 * @returns {{alpha:Uint8Array, w:number, h:number, factor:number}}
 */
export function downsampleAlpha(rgba, width, height, factor = 2, alphaThreshold = 8) {
  const f = Math.max(1, Math.floor(factor));
  const w = Math.max(1, Math.ceil(width / f));
  const h = Math.max(1, Math.ceil(height / f));
  const alpha = new Uint8Array(w * h);
  for (let gy = 0; gy < h; gy++) {
    const y0 = gy * f, y1 = Math.min(height, y0 + f);
    for (let gx = 0; gx < w; gx++) {
      const x0 = gx * f, x1 = Math.min(width, x0 + f);
      let solid = 0;
      outer: for (let y = y0; y < y1; y++) {
        const rowBase = y * width;
        for (let x = x0; x < x1; x++) {
          if (rgba[(rowBase + x) * 4 + 3] >= alphaThreshold) { solid = 1; break outer; }
        }
      }
      alpha[gy * w + gx] = solid;
    }
  }
  return { alpha, w, h, factor: f };
}

/**
 * 把网格坐标边界框换算回原始像素坐标。
 * @param {{left,top,right,bottom}} box 网格坐标（开区间）
 * @param {number} factor 降采样倍数
 * @param {number} width  原始宽（钳制上限）
 * @param {number} height 原始高（钳制上限）
 * @returns {{left,top,right,bottom}} 原始像素坐标
 */
export function boxToPixels(box, factor, width, height) {
  return {
    left: Math.max(0, box.left * factor),
    top: Math.max(0, box.top * factor),
    right: Math.min(width, box.right * factor),
    bottom: Math.min(height, box.bottom * factor),
  };
}

/**
 * 一站式：RGBA → 连通域原始像素边界框列表（按面积从大到小）。
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {{factor?:number, alphaThreshold?:number, minAreaPx?:number}} opts
 *        minAreaPx 为"原始像素"下的最小面积，内部会换算到网格坐标
 * @returns {Array<{left,top,right,bottom}>} 原始像素坐标边界框
 */
export function findElementBounds(rgba, width, height, opts = {}) {
  const factor = opts.factor ?? 2;
  const alphaThreshold = opts.alphaThreshold ?? 8;
  const minAreaPx = opts.minAreaPx ?? 64;          // 原始像素下 < 8x8 视为噪点
  const { alpha, w, h, factor: f } = downsampleAlpha(rgba, width, height, factor, alphaThreshold);
  const minAreaGrid = Math.max(1, Math.ceil(minAreaPx / (f * f)));
  const boxes = labelComponents(alpha, w, h, minAreaGrid);
  return boxes
    .map((b) => boxToPixels(b, f, width, height))
    .sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top));
}
