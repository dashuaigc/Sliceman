// 快速绘制表格的纯几何：参数校验 → 单元格布局 → 定位 → 矢量路径点。
// 不依赖 Photoshop，可在 Node 下单测（见 tests/table-core.test.js）。
//
// 产出的是「路径组件」列表，每个组件是一条闭合子路径 + 布尔运算（add / subtract）。
// PS 侧（src/ps/table-maker.js）只负责把它序列化成 batchPlay 描述符，不含任何几何计算。
//
// 坐标系与 PS 一致：原点左上角，y 向下增大，单位像素。

/** 九宫格定位点 → [水平比例, 垂直比例] */
export const ANCHOR_RATIO = {
  'top-left': [0, 0], 'top-center': [0.5, 0], 'top-right': [1, 0],
  'middle-left': [0, 0.5], center: [0.5, 0.5], 'middle-right': [1, 0.5],
  'bottom-left': [0, 1], 'bottom-center': [0.5, 1], 'bottom-right': [1, 1],
};

// 三次贝塞尔拟合 90° 圆弧的控制点系数
const KAPPA = 0.5522847498307936;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

/**
 * 参数校验。返回第一条错误信息，全部合法则返回 null。
 * @param {object} p
 * @param {{hasDoc?:boolean, hasSelection?:boolean}} env 运行环境（有无文档 / 有无选区）
 */
export function validateParams(p, env = {}) {
  if (env.hasDoc === false) return '请先打开一个 Photoshop 文档。';
  const rows = num(p.rows), cols = num(p.cols);
  if (!(rows > 0) || !Number.isInteger(rows)) return '行数必须大于 0。';
  if (!(cols > 0) || !Number.isInteger(cols)) return '列数必须大于 0。';
  if (p.sizeSource === 'selection' && env.hasSelection === false) {
    return '当前没有有效选区，请先创建选区。';
  }
  if (p.sizeSource === 'custom' || p.sizeSource == null) {
    if (p.sizeMode === 'total') {
      if (!(num(p.totalW) > 0)) return '宽度必须大于 0 px。';
      if (!(num(p.totalH) > 0)) return '高度必须大于 0 px。';
    } else {
      if (!(num(p.cellW) > 0)) return '宽度必须大于 0 px。';
      if (!(num(p.cellH) > 0)) return '高度必须大于 0 px。';
    }
  }
  if (!(num(p.lineWidth) > 0) && !p.fillCells) return '线宽必须大于 0 px。';
  return null;
}

/**
 * 算出每个单元格相对表格左上角的位置与尺寸。
 * 两种尺寸模式：给定单元格尺寸反推总尺寸，或给定总尺寸均分出单元格尺寸。
 * 间距只出现在单元格【之间】，不占表格外沿：总宽 = 列数×格宽 + (列数-1)×列间距。
 * @returns {{cells:Array<{row:number,col:number,x:number,y:number,w:number,h:number}>,
 *            cellW:number, cellH:number, totalW:number, totalH:number}}
 */
export function computeCells(p) {
  const rows = num(p.rows), cols = num(p.cols);
  const rowGap = Math.max(0, num(p.rowGap) || 0);
  const colGap = Math.max(0, num(p.colGap) || 0);

  let cellW, cellH, totalW, totalH;
  if (p.sizeMode === 'total' || p.sizeSource === 'selection' || p.sizeSource === 'canvas') {
    totalW = num(p.totalW); totalH = num(p.totalH);
    cellW = (totalW - (cols - 1) * colGap) / cols;
    cellH = (totalH - (rows - 1) * rowGap) / rows;
  } else {
    cellW = num(p.cellW); cellH = num(p.cellH);
    totalW = cols * cellW + (cols - 1) * colGap;
    totalH = rows * cellH + (rows - 1) * rowGap;
  }

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        row: r + 1, col: c + 1,
        x: c * (cellW + colGap),
        y: r * (cellH + rowGap),
        w: cellW, h: cellH,
      });
    }
  }
  return { cells, cellW, cellH, totalW, totalH };
}

/**
 * 独立单元格模式的格子位置：与 computeCells 的区别是【相邻格子共用一条边】。
 *
 * 每个格子是一个独立矩形、各自带内侧描边。若把它们紧挨着排，两条 1px 描边并排就成了
 * 2px，比外边框粗一倍。解决办法是把相邻矩形【重叠一个线宽】，两条描边落在同一列像素上，
 * 看起来就是 1px，和外边框一致。
 *
 * 间距 > 0 时格子本来就该分开，不重叠。所以水平/垂直两个方向各自判断。
 *
 * @returns {{cells:Array<{row:number,col:number,x:number,y:number,w:number,h:number}>,
 *            cellW:number, cellH:number, totalW:number, totalH:number,
 *            overlapX:number, overlapY:number}}
 */
export function computeCellRects(p) {
  const rows = num(p.rows), cols = num(p.cols);
  const rowGap = Math.max(0, num(p.rowGap) || 0);
  const colGap = Math.max(0, num(p.colGap) || 0);
  const lw = Math.max(0, num(p.lineWidth) || 0);

  let ox = colGap > 0 ? 0 : lw;                    // 水平重叠量
  let oy = rowGap > 0 ? 0 : lw;                    // 垂直重叠量

  // 「表格总尺寸」模式下总尺寸是用户给定的，反推格子尺寸时要把重叠量补回去，
  // 这样画出来的整体宽高仍然精确等于用户填的数
  const solve = () => {
    if (p.sizeMode === 'total') {
      const totalW = num(p.totalW), totalH = num(p.totalH);
      return {
        cellW: (totalW + (cols - 1) * (ox - colGap)) / cols,
        cellH: (totalH + (rows - 1) * (oy - rowGap)) / rows,
        totalW, totalH,
      };
    }
    const cellW = num(p.cellW), cellH = num(p.cellH);
    return {
      cellW, cellH,
      totalW: cols * cellW + (cols - 1) * (colGap - ox),
      totalH: rows * cellH + (rows - 1) * (rowGap - oy),
    };
  };

  let g = solve();
  // 格子比线宽还小的极端情况：重叠量夹到半个格子，再解一次
  const cx = Math.min(ox, g.cellW / 2), cy = Math.min(oy, g.cellH / 2);
  if (cx !== ox || cy !== oy) { ox = cx; oy = cy; g = solve(); }

  const pitchX = g.cellW + colGap - ox;            // 相邻格子左上角的间距
  const pitchY = g.cellH + rowGap - oy;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ row: r + 1, col: c + 1, x: c * pitchX, y: r * pitchY, w: g.cellW, h: g.cellH });
    }
  }
  return { cells, ...g, overlapX: ox, overlapY: oy };
}

/** 按输出方式选对应的排布算法——两种模式的总尺寸算法不同，别混用 */
export function computeLayout(p) {
  return p.output === 'cells' ? computeCellRects(p) : computeCells(p);
}

/**
 * 九宫格定位 + X/Y 偏移 → 表格左上角在文档中的坐标。
 * X/Y 方向与「快速平移」一致：右为正、下为正。
 */
export function computeOrigin(size, canvas, anchor, offsetX = 0, offsetY = 0) {
  const [ax, ay] = ANCHOR_RATIO[anchor] || ANCHOR_RATIO.center;
  return {
    x: (num(canvas.width) - size.w) * ax + (num(offsetX) || 0),
    y: (num(canvas.height) - size.h) * ay + (num(offsetY) || 0),
  };
}

/**
 * 圆角矩形的路径点。r ≤ 0 时退化为四个直角点（前后控制柄与锚点重合）。
 * 点序为顺时针，闭合子路径。
 * @returns {Array<{anchor:[number,number], forward:[number,number], backward:[number,number]}>}
 */
export function roundRectPoints(x, y, w, h, r = 0) {
  const pt = (a, f = a, b = a) => ({ anchor: a, forward: f, backward: b });
  const rr = Math.max(0, Math.min(num(r) || 0, w / 2, h / 2));
  if (rr <= 0) {
    return [pt([x, y]), pt([x + w, y]), pt([x + w, y + h]), pt([x, y + h])];
  }
  const k = rr * KAPPA;
  const x2 = x + w, y2 = y + h;
  return [
    // 上边：左端 → 右端
    pt([x + rr, y], [x + rr, y], [x + rr - k, y]),
    pt([x2 - rr, y], [x2 - rr + k, y], [x2 - rr, y]),
    // 右边
    pt([x2, y + rr], [x2, y + rr], [x2, y + rr - k]),
    pt([x2, y2 - rr], [x2, y2 - rr + k], [x2, y2 - rr]),
    // 下边：右端 → 左端
    pt([x2 - rr, y2], [x2 - rr, y2], [x2 - rr + k, y2]),
    pt([x + rr, y2], [x + rr - k, y2], [x + rr, y2]),
    // 左边
    pt([x, y2 - rr], [x, y2 - rr], [x, y2 - rr + k]),
    pt([x, y + rr], [x, y + rr - k], [x, y + rr]),
  ];
}

/** 一个组件 = 一条闭合子路径 + 布尔运算 */
const comp = (points, op = 'add') => ({ op, points });

/** 实心（圆角）矩形 */
function fillComp(rect, r) {
  return comp(roundRectPoints(rect.x, rect.y, rect.w, rect.h, r));
}

/**
 * 描边环：外圈 add + 内圈 subtract。
 * 用「挖空」而不是四条细边拼接，这样圆角描边、线宽都能一次算对。
 */
function ringComps(rect, lw, r) {
  const inset = Math.min(lw, rect.w / 2, rect.h / 2);
  const outer = roundRectPoints(rect.x, rect.y, rect.w, rect.h, r);
  const inner = roundRectPoints(
    rect.x + inset, rect.y + inset, rect.w - inset * 2, rect.h - inset * 2,
    Math.max(0, r - inset),
  );
  return [comp(outer, 'add'), comp(inner, 'subtract')];
}

/**
 * 传统连续表格线（间距为 0 时用）：每条线是一个细矩形。
 * 不靠 PS 的描边（Stroke）实现 —— 细矩形不会有半像素与交叉点对齐问题，见需求 §10.2。
 * 圆角只作用于外轮廓：外框改用圆角环，内部线仍是直角细矩形。
 */
function gridLineComps(p, geo) {
  const lw = num(p.lineWidth);
  const r = Math.max(0, num(p.radius) || 0);
  const { cellW, cellH, totalW, totalH } = geo;
  const rows = num(p.rows), cols = num(p.cols);
  const out = [];

  if (p.border) {
    if (r > 0) out.push(...ringComps({ x: 0, y: 0, w: totalW, h: totalH }, lw, r));
    else {
      out.push(fillComp({ x: 0, y: 0, w: lw, h: totalH }, 0));                 // 左
      out.push(fillComp({ x: totalW - lw, y: 0, w: lw, h: totalH }, 0));       // 右
      out.push(fillComp({ x: 0, y: 0, w: totalW, h: lw }, 0));                 // 上
      out.push(fillComp({ x: 0, y: totalH - lw, w: totalW, h: lw }, 0));       // 下
    }
  }
  // 内竖线：线中心压在列边界上，取整保证整数像素
  if (p.vLines) {
    for (let i = 1; i < cols; i++) {
      out.push(fillComp({ x: Math.round(i * cellW - lw / 2), y: 0, w: lw, h: totalH }, 0));
    }
  }
  // 内横线
  if (p.hLines) {
    for (let j = 1; j < rows; j++) {
      out.push(fillComp({ x: 0, y: Math.round(j * cellH - lw / 2), w: totalW, h: lw }, 0));
    }
  }
  return out;
}

/** 把相对表格原点的组件整体平移到文档坐标 */
function translate(components, ox, oy) {
  const mv = ([a, b]) => [a + ox, b + oy];
  return components.map((c) => ({
    op: c.op,
    points: c.points.map((pp) => ({
      anchor: mv(pp.anchor), forward: mv(pp.forward), backward: mv(pp.backward),
    })),
  }));
}

/**
 * 组装整张表格。
 *
 * 图层怎么分：
 *   · 线条与填充颜色不同，无法共存于同一个形状图层 → 各自成层
 *   · 单一形状：线条一层、填充一层（若开启），两层都有时套一个组
 *   · 独立单元格：每格一层放进组；开填充则该层是实心格，否则是描边环
 *
 * 间距 > 0 时传统表格线失去意义（格子之间是断开的），自动改用「每格一个描边环」，
 * 即需求 §24.3 说的内部切换为矩形网格结构。
 *
 * @param {object} p 参数
 * @param {{width:number,height:number}} canvas 画布尺寸（定位用）
 * @param {{left:number,top:number}} [rectOrigin] 选区/画布模式下表格的左上角（给定则不走九宫格）
 * @returns {{origin:{x:number,y:number}, size:{w:number,h:number}, cellCount:number,
 *            groupName:string|null, layers:Array<{name:string, role:'line'|'fill', components:Array}>}}
 */
export function buildTable(p, canvas, rectOrigin = null) {
  const geo = computeLayout(p);
  const size = { w: geo.totalW, h: geo.totalH };
  const origin = rectOrigin
    ? { x: rectOrigin.left + (num(p.offsetX) || 0), y: rectOrigin.top + (num(p.offsetY) || 0) }
    : computeOrigin(size, canvas, p.anchor, p.offsetX, p.offsetY);

  const rows = num(p.rows), cols = num(p.cols);
  const baseName = (p.name || '表格').trim() || '表格';
  const tableName = `${baseName} ${rows}×${cols}`;
  const r = Math.max(0, num(p.radius) || 0);
  const lw = num(p.lineWidth);
  const gapped = (num(p.rowGap) || 0) > 0 || (num(p.colGap) || 0) > 0;
  const wantLines = !!(p.border || p.hLines || p.vLines);

  const layers = [];

  if (p.output === 'cells') {
    // 独立单元格：每格建一个【实时形状矩形】（PS 属性面板里能直接改 W/H、圆角、描边、填充），
    // 而不是死的路径形状。结构开关（外边框/内横线/内竖线）在这里没有意义。
    //
    // 格子位置来自 computeCellRects：无间距时相邻矩形重叠一个线宽，两条描边压在同一列
    // 像素上，内部线与外边框都是 1×线宽，不会内粗外细。
    //
    // 与单一形状模式的一个重要差别：矩形的描边和填充是两套独立属性，可以【同时】存在——
    // 填充开关只管填充，线宽只管描边，不再二选一。
    //
    // components 是后备：万一 PS 建不出实时矩形，还能退回老的路径写法（见 ps/table-maker.js）。
    for (const c of geo.cells) {
      const comps = p.fillCells ? [fillComp(c, r)] : ringComps(c, lw, r);
      layers.push({
        name: `R${c.row}C${c.col}`,
        kind: 'rect',
        rect: {
          left: origin.x + c.x, top: origin.y + c.y,
          right: origin.x + c.x + c.w, bottom: origin.y + c.y + c.h,
        },
        radius: r,
        fill: !!p.fillCells,
        stroke: lw > 0,
        lineWidth: lw,
        role: p.fillCells ? 'fill' : 'line',
        // 实心圆角矩形：配合 PS 的描边样式用，边框由描边画、不靠挖空
        solid: translate([fillComp(c, r)], origin.x, origin.y),
        // 老写法后备：描边环 / 实心块，不依赖描边样式
        components: translate(comps, origin.x, origin.y),
      });
    }
    return {
      origin, size, cellCount: geo.cells.length,
      groupName: tableName, layers,
    };
  }

  // 单一形状：填充在下、线条在上
  if (p.fillCells) {
    layers.push({
      name: `${tableName} 填充`,
      role: 'fill',
      components: translate(geo.cells.map((c) => fillComp(c, r)), origin.x, origin.y),
    });
  }
  if (wantLines) {
    const comps = gapped
      ? geo.cells.flatMap((c) => ringComps(c, lw, r))   // 间距>0：退化成每格描边环
      : gridLineComps(p, geo);
    if (comps.length) {
      layers.push({ name: tableName, role: 'line', components: translate(comps, origin.x, origin.y) });
    }
  }

  return {
    origin, size, cellCount: geo.cells.length,
    groupName: layers.length > 1 ? tableName : null,
    layers,
  };
}

/**
 * 一批路径组件的外接矩形。用来核对 PS 真的按路径建出了形状层
 * ——「建成空形状层」时 PS 会给出一个铺满画布的纯色层，尺寸对不上就能发现。
 * @returns {{left:number,top:number,right:number,bottom:number}|null} 没有点则 null
 */
export function componentsBBox(components) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const c of components || []) {
    for (const p of c.points || []) {
      // 只看锚点：控制柄不会伸出圆角矩形的外接框
      const [x, y] = p.anchor;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < l) l = x;
      if (y < t) t = y;
      if (x > r) r = x;
      if (y > b) b = y;
    }
  }
  return Number.isFinite(l) ? { left: l, top: t, right: r, bottom: b } : null;
}

/**
 * 两个矩形是否在容差内一致。任一为 null 时返回 true（读不到就别误杀）。
 * @param {number} tol 每条边允许的偏差（px）
 */
export function bboxMatches(expected, actual, tol = 2) {
  if (!expected || !actual) return true;
  return ['left', 'top', 'right', 'bottom']
    .every((k) => Math.abs(expected[k] - actual[k]) <= tol);
}
