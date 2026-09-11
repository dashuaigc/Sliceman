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
  const { groups } = labelGrid(alpha, w, h);
  return filterByArea(groups, minArea).boxes;
}

/**
 * 面积过滤 + 保留映射。
 * @returns {{boxes:Array, keepOf:Int32Array}} keepOf[i] = 第 i 组在结果里的下标（-1 = 被丢弃）
 */
function filterByArea(groups, minArea) {
  const keepOf = new Int32Array(groups.length).fill(-1);
  const boxes = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.area < minArea) continue;
    keepOf[i] = boxes.length;
    boxes.push({ left: g.left, top: g.top, right: g.right, bottom: g.bottom });
  }
  return { boxes, keepOf };
}

/**
 * 网格 → 连通分组（不做面积过滤）：返回每格的组号（-1=无内容）与各组边界/面积。
 * 供 labelComponents 与近距离合并共用。
 * @returns {{labels:Int32Array, groups:Array<{left,top,right,bottom,area}>}}
 */
function labelGrid(alpha, w, h) {
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

  // 根标签 → 紧凑组号；汇总边界与面积，并填充每格组号
  const rootToGroup = new Map();
  const groups = [];
  const labels = new Int32Array(w * h).fill(-1);
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    const root = dsu.find(k);
    let gi = rootToGroup.get(root);
    if (gi === undefined) {
      gi = groups.length;
      rootToGroup.set(root, gi);
      groups.push({ left: r.x0, top: r.y, right: r.x1, bottom: r.y + 1, area: 0 });
    }
    const g = groups[gi];
    g.left = Math.min(g.left, r.x0);
    g.top = Math.min(g.top, r.y);
    g.right = Math.max(g.right, r.x1);
    g.bottom = Math.max(g.bottom, r.y + 1);
    g.area += r.x1 - r.x0;
    labels.fill(gi, r.y * w + r.x0, r.y * w + r.x1);
  }
  return { labels, groups };
}

/**
 * 二值网格形态学膨胀（方形结构元，水平/垂直两趟滑窗最大值，O(n·r)）。
 * 用于"近距离合并"：相距 ≤ 2r 格的内容块膨胀后会互相接触。
 */
function dilate(alpha, w, h, r) {
  if (r <= 0) return alpha;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) {
        if (alpha[base + k]) { tmp[base + x] = 1; break; }
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) {
        if (tmp[k * w + x]) { out[y * w + x] = 1; break; }
      }
    }
  }
  return out;
}

/** 两盒子欧氏间隙（相交/相切为 0）。 */
function boxGap(a, b) {
  const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
  const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
  return Math.hypot(dx, dy);
}

/**
 * 自适应合并：单链层次聚类（最小生成树）+ 自动切割点。
 *
 * 为什么不用固定阈值/最近邻统计：重度碎片化的图标（每个碎片的最近邻都是
 * 同图标的相邻笔画）采不到"元素间距"尺度，双峰不出现 → 阈值失真。
 *
 * 做法：Prim 建 MST（每条边 = 一次"最近合并"的间距）→ 把边距排序，
 * 在序列里找最宽的【对数断裂】：紧致的簇内合并（小边距）与跨元素合并
 * （大边距）之间天然有数量级跳变 → 在断裂中点切一刀，≤阈值的 MST 边
 * 连起来的块属于同一元素。断裂比 <2（无清晰分层，如等距排布）则不合并
 * （宁可少并，不误并）。尺度无关，任意分辨率通用。
 *
 * @param {Array<{left,top,right,bottom}>} comps 组件边界框（网格坐标）
 * @param {{components?:number, threshold?:number}} [info] 诊断回填
 * @returns {Array<{left,top,right,bottom}>} 合并后的元素边界框（并集，不外扩）
 */
function singleLinkageAutoCut(comps, info) {
  const n = comps.length;
  const ident = () => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; };
  if (info) info.components = n;
  if (n <= 1) return { boxes: comps.slice(), groupOf: ident() };

  // Prim 最小生成树（n 为块数，量级小，O(n²) 足够）
  const inTree = new Uint8Array(n);
  const bestDist = new Float64Array(n).fill(Infinity);
  const bestLink = new Int32Array(n).fill(-1);
  inTree[0] = 1;
  for (let j = 1; j < n; j++) { bestDist[j] = boxGap(comps[0], comps[j]); bestLink[j] = 0; }
  const mstEdges = [];                    // {gap, a, b}
  for (let k = 1; k < n; k++) {
    let m = -1;
    for (let j = 0; j < n; j++) if (!inTree[j] && (m < 0 || bestDist[j] < bestDist[m])) m = j;
    inTree[m] = 1;
    mstEdges.push({ gap: bestDist[m], a: m, b: bestLink[m] });
    for (let j = 0; j < n; j++) {
      if (inTree[j]) continue;
      const g = boxGap(comps[m], comps[j]);
      if (g < bestDist[j]) { bestDist[j] = g; bestLink[j] = m; }
    }
  }

  // 在边距序列里找最宽对数断裂（去重后相邻比值）
  const uniq = Array.from(new Set(mstEdges.map((e) => Math.round(e.gap * 100) / 100))).sort((a, b) => a - b);
  let cut = -1, bestRatio = 1;
  for (let k = 0; k < uniq.length - 1; k++) {
    const ratio = uniq[k + 1] / Math.max(uniq[k], 0.01);
    if (ratio > bestRatio) { bestRatio = ratio; cut = k; }
  }
  // 断裂比 ≥2 才认为分层可信；阈值取断裂两端几何中点；否则不合并（返回原块）
  if (cut < 0 || bestRatio < 2) {
    if (info) info.threshold = 0;
    return { boxes: comps.map((c) => ({ ...c })), groupOf: ident() };
  }
  const T = Math.sqrt(uniq[cut] * uniq[cut + 1]);
  if (info) info.threshold = T;

  // ≤T 的 MST 边并起来（单链），各簇边界取并集
  const dsu = makeDSU(n);
  for (const e of mstEdges) if (e.gap <= T) dsu.union(e.a, e.b);
  const out = new Map();
  const groupOf = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    let b = out.get(root);
    if (!b) { b = { idx: out.size, left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }; out.set(root, b); }
    groupOf[i] = b.idx;
    const s = comps[i];
    b.left = Math.min(b.left, s.left);
    b.top = Math.min(b.top, s.top);
    b.right = Math.max(b.right, s.right);
    b.bottom = Math.max(b.bottom, s.bottom);
  }
  const boxes = Array.from(out.values())
    .map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));
  return { boxes, groupOf };
}

/**
 * 规则网格布局检测：组件按 top/left 聚类成行/列带，若每个组件都落在独立的
 * 网格单元且填充率高（行列数×列数 ≈ 组件数），判定为字符表/雪碧图网格。
 * 这类图的组件本身就是完整元素（字符/贴块），不应做近距合并。
 */
function looksLikeGrid(comps) {
  const n = comps.length;
  if (n < 6) return false;
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const medH = median(comps.map((c) => c.bottom - c.top));
  const medW = median(comps.map((c) => c.right - c.left));
  const vTol = Math.max(2, medH * 0.6);
  const hTol = Math.max(2, medW * 0.6);
  const bands = (vals, tol) => {
    const s = [...vals].sort((x, y) => x - y);
    const out = [];
    for (const v of s) {
      const last = out[out.length - 1];
      if (last && v - last.v1 <= tol) last.v1 = v;
      else out.push({ v0: v, v1: v });
    }
    return out;
  };
  const rows = bands(comps.map((c) => c.top), vTol);
  const cols = bands(comps.map((c) => c.left), hTol);
  if (rows.length < 2 || cols.length < 2) return false;
  // 网格填充率：行列单元数不应远超组件数（碎片散布会形成大量空单元）
  if (rows.length * cols.length > n * 1.25) return false;
  const cellOf = (v, bs) => {
    for (let i = 0; i < bs.length; i++) if (v <= bs[i].v1) return i;
    return bs.length - 1;
  };
  const cells = new Set();
  for (const c of comps) cells.add(cellOf(c.top, rows) * 4096 + cellOf(c.left, cols));
  return cells.size === n;          // 每个组件独占一格 → 行列对齐的网格
}

/**
 * 自适应连通标记：6px 兜底粘合抗锯齿裂缝后，单链层次聚类自动切割合并近块。
 * 解决"图标内部细缝被拆开"的过分割，且不依赖固定像素值，任意分辨率的图都适配。
 * 规则网格（字符表/雪碧图）检测为完整元素，不做合并。
 * @param {number} floorR 兜底膨胀半径（网格格数，闭合 ≤2·floorR 格的裂缝）
 * @param {{components?:number, threshold?:number, grid?:boolean}} [info] 诊断回填
 */
export function labelComponentsAdaptive(alpha, w, h, minArea, floorR, info) {
  return adaptiveGroups(alpha, w, h, minArea, floorR, info).boxes;
}

/**
 * 自适应标记的带映射版：除了各元素边界，还给出「每格归哪个元素」所需的两级映射。
 * @returns {{boxes:Array, labels:Int32Array, rawOf:Int32Array, groupOf:Int32Array}}
 *   labels  每格的【原始连通块】号（-1=空）
 *   rawOf   原始连通块 → 近距合并后的块号（-1 = 被面积过滤掉的噪点）
 *   groupOf 合并后的块 → 最终元素号
 */
function adaptiveGroups(alpha, w, h, minArea, floorR, info) {
  const m = mergedGroups(alpha, w, h, minArea, floorR);
  if (info) info.components = m.boxes.length;
  const ident = (n) => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; };
  if (m.boxes.length > 1 && looksLikeGrid(m.boxes)) {
    if (info) { info.threshold = 0; info.grid = true; }
    return { ...m, boxes: m.boxes.map((c) => ({ ...c })), groupOf: ident(m.boxes.length) };
  }
  const cut = singleLinkageAutoCut(m.boxes, info);
  return { ...m, boxes: cut.boxes, groupOf: cut.groupOf };
}

/**
 * 近距离合并的连通域标记（固定半径版）。
 * 手法：把网格膨胀 r 格后重新连通分组，膨胀后同组的原始块属于同一元素 → 合并；
 * 但边界取原始块的并集（不外扩、不虚增像素）。
 * @param {number} r 膨胀半径（网格格数）；0 退化为普通 labelComponents
 */
export function labelComponentsMerged(alpha, w, h, minArea = 1, r = 0) {
  return mergedGroups(alpha, w, h, minArea, r).boxes;
}

/**
 * 近距合并的带映射版：返回合并后的块，外加「每格属于哪个原始连通块」与
 * 「原始块归到哪个合并块」—— 逐像素分割要靠这两张表把格子分派给元素。
 * @returns {{boxes:Array, labels:Int32Array, rawOf:Int32Array}}
 */
function mergedGroups(alpha, w, h, minArea = 1, r = 0) {
  const g1 = labelGrid(alpha, w, h);
  if (!g1.groups.length) return { boxes: [], labels: g1.labels, rawOf: new Int32Array(0) };
  if (r <= 0) {
    const { boxes, keepOf } = filterByArea(g1.groups, minArea);
    return { boxes, labels: g1.labels, rawOf: keepOf };
  }
  const g2 = labelGrid(dilate(alpha, w, h, r), w, h);

  // 原组 → 膨胀组映射（取该组任一有内容格；膨胀必覆盖原内容，故映射必存在）
  const mergeOf = new Int32Array(g1.groups.length).fill(-1);
  for (let i = 0; i < g1.labels.length; i++) {
    const a = g1.labels[i];
    if (a >= 0 && mergeOf[a] < 0) mergeOf[a] = g2.labels[i];
  }

  // 同一膨胀组的原组求并（边界并集、面积求和），并记下各自由哪些原组构成
  const idxOf = new Map();
  const list = [];
  for (let a = 0; a < g1.groups.length; a++) {
    const key = mergeOf[a] >= 0 ? mergeOf[a] : a;      // 保底：映射缺失则自成一组
    const src = g1.groups[a];
    let gi = idxOf.get(key);
    if (gi === undefined) {
      gi = list.length;
      idxOf.set(key, gi);
      list.push({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, area: 0, raws: [] });
    }
    const b = list[gi];
    b.left = Math.min(b.left, src.left);
    b.top = Math.min(b.top, src.top);
    b.right = Math.max(b.right, src.right);
    b.bottom = Math.max(b.bottom, src.bottom);
    b.area += src.area;
    b.raws.push(a);
  }
  const rawOf = new Int32Array(g1.groups.length).fill(-1);
  const boxes = [];
  for (const b of list) {
    if (b.area < minArea) continue;                    // 噪点：连带它的格子一起不归属任何元素
    const oi = boxes.length;
    for (const a of b.raws) rawOf[a] = oi;
    boxes.push({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
  }
  return { boxes, labels: g1.labels, rawOf };
}

/**
 * 通用降采样：按 isContent(像素偏移) 判定内容，块内任一内容像素则该格记 1。
 */
function downsampleGeneric(rgba, width, height, factor, isContent) {
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
          if (isContent((rowBase + x) * 4)) { solid = 1; break outer; }
        }
      }
      alpha[gy * w + gx] = solid;
    }
  }
  return { alpha, w, h, factor: f };
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
  return downsampleGeneric(rgba, width, height, factor, (i) => rgba[i + 3] >= alphaThreshold);
}

/**
 * 估计背景色：沿图像边框采样（四边），取各通道中位数。
 * 用于"无透明通道的实底图"（如白底素材图）的内容分离。
 * @returns {[number, number, number]} 背景色 RGB
 */
function borderBackground(rgba, width, height) {
  const rs = [], gs = [], bs = [];
  const step = Math.max(1, Math.floor((width + height) / 512));
  const push = (x, y) => {
    const i = (y * width + x) * 4;
    rs.push(rgba[i]); gs.push(rgba[i + 1]); bs.push(rgba[i + 2]);
  };
  for (let x = 0; x < width; x += step) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y += step) { push(0, y); push(width - 1, y); }
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}

/**
 * 构建内容掩码网格：
 *   常规（有透明）→ alpha 通道判定；
 *   图层几乎全不透明（≥99.5% 实心，如白底素材图）→ 从边框估计背景色，
 *   与背景色差 ≤容差的像素视为"空"，用颜色差异分离内容。
 * @param {{mode?:string}} [info] 诊断回填：mode = 'alpha' | 'color'
 * @returns {{alpha:Uint8Array, w:number, h:number, factor:number}}
 */
function buildMask(rgba, width, height, factor, alphaThreshold, bgTolerance, info) {
  const alphaGrid = downsampleAlpha(rgba, width, height, factor, alphaThreshold);
  let solid = 0;
  for (let i = 0; i < alphaGrid.alpha.length; i++) solid += alphaGrid.alpha[i];
  const coverage = solid / alphaGrid.alpha.length;
  if (coverage < 0.995) {                       // 有透明 → alpha 通道已可用
    if (info) info.mode = 'alpha';
    return alphaGrid;
  }
  // 全不透明：没有透明可依赖 → 按底色分离。
  // 带阴影/光晕的素材（如金色立体字）：阴影是灰色（无彩色），会和白底一起构成
  // 连通底，把所有元素连成一片 → 额外加"彩度门限"：R≈G≈B 的无彩色像素视为空。
  // 若彩度门限把灰色元素也滤掉（分离结果 <2 块），退回纯色差模式。
  const bg = borderBackground(rgba, width, height);
  const tol = bgTolerance ?? 24;
  const chromaTol = 24;
  const maskOf = (useChroma) => (i) => {
    if (rgba[i + 3] < alphaThreshold) return false;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const d = Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2]));
    if (d <= tol) return false;                        // 接近底色 → 空
    if (!useChroma) return true;
    return Math.max(r, g, b) - Math.min(r, g, b) > chromaTol;   // 无彩色（阴影/灰渐变）→ 空
  };
  let grid = downsampleGeneric(rgba, width, height, factor, maskOf(true));
  let comps = labelComponents(grid.alpha, grid.w, grid.h, 1);
  if (comps.length < 2) {                              // 灰色元素场景：彩度门限不适用
    grid = downsampleGeneric(rgba, width, height, factor, maskOf(false));
  }
  // 分离后一个内容都没有（整图同色/纯色填充）→ 退回整层即一个元素，避免"0 个元素"
  let any = 0;
  for (let i = 0; i < grid.alpha.length; i++) { if (grid.alpha[i]) { any = 1; break; } }
  if (!any) {
    if (info) info.mode = 'alpha';
    return alphaGrid;
  }
  if (info) info.mode = 'color';
  return grid;
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
 * 行序排列（阅读顺序）：先按 top 升序，纵向有重叠的并进同一"视觉行"，
 * 行内按 left 升序 —— 即"从最上面一行开始、每行从左往右，再第二行、第三行…"。
 * @param {Array<{left,top,right,bottom}>} boxes
 * @returns {Array} 重排后的 boxes
 */
export function orderRowMajor(boxes) {
  const sorted = [...boxes].sort((a, b) => (a.top - b.top) || (a.left - b.left));
  const rows = [];
  for (const b of sorted) {
    const row = rows.length ? rows[rows.length - 1] : null;
    if (row && b.top < row.bottom) {               // 与当前行纵向有重叠 → 并入该行
      row.items.push(b);
      if (b.bottom > row.bottom) row.bottom = b.bottom;
    } else {
      rows.push({ items: [b], bottom: b.bottom });
    }
  }
  const out = [];
  for (const r of rows) out.push(...r.items.sort((x, y) => x.left - y.left));
  return out;
}

/**
 * 一站式：RGBA → 连通域原始像素边界框列表（按"从上到下、每行从左到右"的行序排列）。
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {{factor?:number, alphaThreshold?:number, minAreaPx?:number, mergeGapPx?:number|'auto', bgTolerance?:number, info?:object}} opts
 *        minAreaPx   原始像素下的最小面积（噪点过滤），内部换算到网格坐标
 *        mergeGapPx  近距合并：'auto'（默认，按间隙分布自适应阈值，任意分辨率通用）；
 *                    数字 = 固定合并间距（原始像素）；0 = 关闭合并（纯连通域）
 *        bgTolerance 底色分离的颜色容差（图层全不透明时启用底色模式，默认 24）
 *        info        诊断回填（auto 时有效）：mode/components/thresholdPx
 * @returns {Array<{left,top,right,bottom}>} 原始像素坐标边界框
 */
export function findElementBounds(rgba, width, height, opts = {}) {
  return findElements(rgba, width, height, opts).elements.map((e) => e.box);
}

/**
 * 用若干矩形覆盖某个元素占的全部格子，且【不含任何其它元素的格子】。
 *
 * 为什么需要它：两个互不相连的元素，外框却常常互相交叠（一个人物伸出的手臂正好
 * 罩在另一个人物的裙摆上方）。按外框整块复制，另一个人的像素就被切进这一层了——
 * 这正是"看起来像沿直线切"的那个 bug。改成按这批矩形建选区，选中的就只是自己的像素。
 *
 * 做法：拿元素自己的格子当种子，向左右扩到碰上别的元素为止，再整段向下扩到同样为止
 * ——即"贪心极大矩形"。空格子（透明/噪点）允许被含进来，反正复制过去也是透明，
 * 所以轮廓平滑的图形通常只要几条横带就能覆盖完，下发给 PS 的选区操作很少。
 *
 * @param {Int32Array} cellElem 每格的元素号（-1 = 空格/噪点，谁都可以占）
 * @param {{left,top,right,bottom}} box 该元素的格子外框（右/下为开区间）
 * @param {{maxRects?:number, budget?:number, covered?:Int32Array}} [opts]
 * @returns {Array<{left,top,right,bottom}>|null} null = 太碎（超出上限），调用方应退回整框
 */
export function coverCells(cellElem, w, h, target, box, opts = {}) {
  const maxRects = opts.maxRects ?? 512;
  let budget = opts.budget ?? 60e6;                 // 格子检查次数上限，挡住病态图形
  const covered = opts.covered || new Int32Array(w * h);
  const mark = target + 1;                          // 复用 covered 时靠元素号区分
  const free = (x, y) => {                          // 这一格允许被本元素的选区含进来
    const v = cellElem[y * w + x];
    return v < 0 || v === target;
  };
  const rowFree = (y, x0, x1) => {
    budget -= x1 - x0;
    for (let x = x0; x < x1; x++) if (!free(x, y)) return false;
    return true;
  };
  const rects = [];
  for (let y = box.top; y < box.bottom; y++) {
    for (let x = box.left; x < box.right; x++) {
      const i = y * w + x;
      if (cellElem[i] !== target || covered[i] === mark) continue;
      if (budget < 0) return null;
      // 行内左右扩（只到本元素外框边界，别把选区甩到画布别处）
      let x0 = x;
      while (x0 > box.left && free(x0 - 1, y)) x0--;
      let x1 = x + 1;
      while (x1 < box.right && free(x1, y)) x1++;
      // 整段向下扩（上面的行已经处理过，不必向上扩）
      let y1 = y + 1;
      while (y1 < box.bottom && rowFree(y1, x0, x1)) y1++;
      rects.push({ left: x0, top: y, right: x1, bottom: y1 });
      for (let yy = y; yy < y1; yy++) {
        const base = yy * w;
        for (let xx = x0; xx < x1; xx++) if (cellElem[base + xx] === target) covered[base + xx] = mark;
      }
      budget -= (y1 - y) * (x1 - x0);
      if (rects.length > maxRects) return null;
    }
  }
  return rects;
}

/**
 * 一站式（完整版）：RGBA → 每个元素的【外框 + 逐像素选区矩形】，行序排列。
 * `findElementBounds` 是它只取外框的薄封装。
 *
 * @returns {{elements:Array<{box:object, rects:Array<object>, exact:boolean}>, info:object}}
 *   rects  建选区用的矩形（原始像素坐标，右/下为开区间）；只有一个时就等于 box
 *   exact  false = 该元素太碎、退回整框（会把邻居的像素带进来，如实告知调用方）
 */
export function findElements(rgba, width, height, opts = {}) {
  const factor = opts.factor ?? 2;
  const alphaThreshold = opts.alphaThreshold ?? 8;
  const minAreaPx = opts.minAreaPx ?? 64;          // 原始像素下 < 8x8 视为噪点
  const mergeGapPx = opts.mergeGapPx ?? 'auto';
  const info = opts.info instanceof Object ? opts.info : {};
  const { alpha, w, h, factor: f } = buildMask(rgba, width, height, factor, alphaThreshold, opts.bgTolerance, info);
  const minAreaGrid = Math.max(1, Math.ceil(minAreaPx / (f * f)));
  const ident = (n) => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; };

  let g;
  if (mergeGapPx === 0) {
    const m = mergedGroups(alpha, w, h, minAreaGrid, 0);
    g = { ...m, groupOf: ident(m.boxes.length) };
  } else if (mergeGapPx === 'auto') {
    // 兜底膨胀：闭合 ≤6px 抗锯齿裂缝，再做自适应间隙合并
    const floorR = Math.max(1, Math.ceil(6 / (2 * f)));
    const diag = {};
    g = adaptiveGroups(alpha, w, h, minAreaGrid, floorR, diag);
    info.components = diag.components;
    info.thresholdPx = diag.threshold != null ? Math.round(diag.threshold * f) : null;
    info.grid = !!diag.grid;
  } else {
    // 固定间距：两侧各 r 格 → 闭合 2r 格 = 2r·factor 像素的缝
    const r = Math.max(1, Math.ceil(mergeGapPx / (2 * f)));
    const m = mergedGroups(alpha, w, h, minAreaGrid, r);
    g = { ...m, groupOf: ident(m.boxes.length) };
  }

  // 每格归属哪个元素：原始连通块 → 合并块 → 元素（噪点与空格留 -1，谁都可以占）
  const cellElem = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < g.labels.length; i++) {
    const c = g.labels[i];
    if (c < 0) continue;
    const mid = g.rawOf[c];
    if (mid < 0) continue;
    const e = g.groupOf[mid];
    if (e >= 0) cellElem[i] = e;
  }

  const covered = new Int32Array(w * h);
  let rectTotal = 0;
  let fallback = 0;
  const items = g.boxes.map((gb, e) => {
    const box = boxToPixels(gb, f, width, height);
    const cover = coverCells(cellElem, w, h, e, gb, { covered, maxRects: opts.maxRects });
    if (!cover) fallback++;
    const rects = cover ? cover.map((r) => boxToPixels(r, f, width, height)) : [box];
    rectTotal += rects.length;
    return { box, rects, exact: !!cover };
  });
  info.rects = rectTotal;
  info.fallback = fallback;

  // 行序（阅读顺序）重排：orderRowMajor 返回的是同一批 box 对象，据此把元素带过去
  const byBox = new Map(items.map((it) => [it.box, it]));
  const elements = orderRowMajor(items.map((it) => it.box)).map((b) => byBox.get(b));
  return { elements, info };
}
