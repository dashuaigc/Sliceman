import { describe, it, expect } from 'vitest';
import {
  validateParams, computeCells, computeOrigin, roundRectPoints, buildTable, ANCHOR_RATIO, componentsBBox, bboxMatches,
} from '../src/lib/table-core.js';

// 一组够用的默认参数，各用例只覆盖自己关心的字段
const P = (over = {}) => ({
  rows: 3, cols: 4,
  sizeSource: 'custom', sizeMode: 'cell',
  cellW: 100, cellH: 60, totalW: 0, totalH: 0,
  rowGap: 0, colGap: 0,
  lineWidth: 1, radius: 0,
  border: true, hLines: true, vLines: true,
  fillCells: false, output: 'single',
  anchor: 'center', offsetX: 0, offsetY: 0,
  name: '表格',
  ...over,
});
const CANVAS = { width: 1200, height: 900 };

describe('validateParams 错误校验', () => {
  it('合法参数返回 null', () => {
    expect(validateParams(P(), { hasDoc: true })).toBeNull();
  });

  it('没有文档时优先报文档', () => {
    expect(validateParams(P({ rows: 0 }), { hasDoc: false })).toBe('请先打开一个 Photoshop 文档。');
  });

  it('行列必须为大于 0 的整数', () => {
    expect(validateParams(P({ rows: 0 }))).toBe('行数必须大于 0。');
    expect(validateParams(P({ rows: 2.5 }))).toBe('行数必须大于 0。');
    expect(validateParams(P({ cols: 0 }))).toBe('列数必须大于 0。');
    expect(validateParams(P({ cols: -1 }))).toBe('列数必须大于 0。');
  });

  it('单元格模式校验单元格宽高，总尺寸模式校验总宽高', () => {
    expect(validateParams(P({ cellW: 0 }))).toBe('宽度必须大于 0 px。');
    expect(validateParams(P({ cellH: 0 }))).toBe('高度必须大于 0 px。');
    expect(validateParams(P({ sizeMode: 'total', totalW: 0, totalH: 500 }))).toBe('宽度必须大于 0 px。');
    expect(validateParams(P({ sizeMode: 'total', totalW: 800, totalH: 0 }))).toBe('高度必须大于 0 px。');
    // 总尺寸模式下不该再挑剔单元格尺寸
    expect(validateParams(P({ sizeMode: 'total', totalW: 800, totalH: 500, cellW: 0, cellH: 0 }))).toBeNull();
  });

  it('选区来源但没有选区', () => {
    expect(validateParams(P({ sizeSource: 'selection' }), { hasDoc: true, hasSelection: false }))
      .toBe('当前没有有效选区，请先创建选区。');
    expect(validateParams(P({ sizeSource: 'selection' }), { hasDoc: true, hasSelection: true })).toBeNull();
  });

  it('选区/画布来源不校验自定义尺寸', () => {
    expect(validateParams(P({ sizeSource: 'canvas', cellW: 0, cellH: 0 }), { hasDoc: true })).toBeNull();
  });

  it('线宽为 0 且不填充时报错；开了填充则允许', () => {
    expect(validateParams(P({ lineWidth: 0 }))).toBe('线宽必须大于 0 px。');
    expect(validateParams(P({ lineWidth: 0, fillCells: true }))).toBeNull();
  });
});

describe('computeCells 单元格布局', () => {
  it('单元格尺寸模式：由格宽高反推总尺寸（需求 §5.1 的例子）', () => {
    const g = computeCells(P({ rows: 5, cols: 4, cellW: 100, cellH: 60 }));
    expect(g.totalW).toBe(400);
    expect(g.totalH).toBe(300);
    expect(g.cells).toHaveLength(20);
  });

  it('总尺寸模式：均分出单元格尺寸（需求 §5.2 的例子）', () => {
    const g = computeCells(P({ sizeMode: 'total', rows: 5, cols: 4, totalW: 800, totalH: 500 }));
    expect(g.cellW).toBe(200);
    expect(g.cellH).toBe(100);
  });

  it('选区来源按总尺寸均分（需求 §6 的例子）', () => {
    const g = computeCells(P({ sizeSource: 'selection', rows: 5, cols: 4, totalW: 800, totalH: 500 }));
    expect(g.cellW).toBe(200);
    expect(g.cellH).toBe(100);
  });

  it('画布来源按总尺寸均分（需求 §7 的例子）', () => {
    const g = computeCells(P({ sizeSource: 'canvas', rows: 3, cols: 4, totalW: 1200, totalH: 900 }));
    expect(g.cellW).toBe(300);
    expect(g.cellH).toBe(300);
  });

  it('间距只出现在单元格之间，不占表格外沿', () => {
    const g = computeCells(P({ rows: 2, cols: 3, cellW: 100, cellH: 50, colGap: 10, rowGap: 20 }));
    expect(g.totalW).toBe(3 * 100 + 2 * 10);   // 320
    expect(g.totalH).toBe(2 * 50 + 1 * 20);    // 120
    expect(g.cells[0]).toMatchObject({ row: 1, col: 1, x: 0, y: 0 });
    expect(g.cells[1]).toMatchObject({ col: 2, x: 110 });
    expect(g.cells[2]).toMatchObject({ col: 3, x: 220 });
    expect(g.cells[3]).toMatchObject({ row: 2, col: 1, x: 0, y: 70 });
  });

  it('总尺寸模式下间距从总尺寸里扣，不会撑破', () => {
    const g = computeCells(P({ sizeMode: 'total', rows: 2, cols: 4, totalW: 430, totalH: 220, colGap: 10, rowGap: 20 }));
    expect(g.cellW).toBe(100);                 // (430 - 3*10) / 4
    expect(g.cellH).toBe(100);                 // (220 - 1*20) / 2
    const last = g.cells[g.cells.length - 1];
    expect(last.x + last.w).toBe(430);         // 右下角正好贴住总尺寸
    expect(last.y + last.h).toBe(220);
  });

  it('单行单列也成立', () => {
    const g = computeCells(P({ rows: 1, cols: 1, cellW: 80, cellH: 40, rowGap: 99, colGap: 99 }));
    expect(g.totalW).toBe(80);
    expect(g.totalH).toBe(40);
    expect(g.cells).toHaveLength(1);
  });

  it('单元格按行优先、行内从左到右编号', () => {
    const g = computeCells(P({ rows: 2, cols: 2, cellW: 10, cellH: 10 }));
    expect(g.cells.map((c) => `R${c.row}C${c.col}`)).toEqual(['R1C1', 'R1C2', 'R2C1', 'R2C2']);
  });
});

describe('computeOrigin 九宫格定位', () => {
  const size = { w: 400, h: 300 };

  it('九个定位点各就各位', () => {
    expect(computeOrigin(size, CANVAS, 'top-left')).toEqual({ x: 0, y: 0 });
    expect(computeOrigin(size, CANVAS, 'center')).toEqual({ x: 400, y: 300 });
    expect(computeOrigin(size, CANVAS, 'bottom-right')).toEqual({ x: 800, y: 600 });
    expect(computeOrigin(size, CANVAS, 'top-right')).toEqual({ x: 800, y: 0 });
    expect(computeOrigin(size, CANVAS, 'bottom-left')).toEqual({ x: 0, y: 600 });
    expect(computeOrigin(size, CANVAS, 'middle-left')).toEqual({ x: 0, y: 300 });
  });

  it('X/Y 偏移与快速平移同向：右为正、下为正（需求 §16 的例子）', () => {
    expect(computeOrigin(size, CANVAS, 'center', 100, -50)).toEqual({ x: 500, y: 250 });
  });

  it('未知定位点退回画布中心', () => {
    expect(computeOrigin(size, CANVAS, '不存在')).toEqual(computeOrigin(size, CANVAS, 'center'));
    expect(Object.keys(ANCHOR_RATIO)).toHaveLength(9);
  });
});

describe('roundRectPoints 路径点', () => {
  it('圆角为 0 → 四个直角点，控制柄与锚点重合', () => {
    const pts = roundRectPoints(10, 20, 100, 50, 0);
    expect(pts).toHaveLength(4);
    expect(pts.map((p) => p.anchor)).toEqual([[10, 20], [110, 20], [110, 70], [10, 70]]);
    pts.forEach((p) => {
      expect(p.forward).toEqual(p.anchor);
      expect(p.backward).toEqual(p.anchor);
    });
  });

  it('圆角 > 0 → 八个点，锚点都落在矩形边界上', () => {
    const pts = roundRectPoints(0, 0, 100, 60, 10);
    expect(pts).toHaveLength(8);
    pts.forEach((p) => {
      const [x, y] = p.anchor;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(60);
    });
    expect(pts[0].anchor).toEqual([10, 0]);
    expect(pts[1].anchor).toEqual([90, 0]);
  });

  it('圆角被夹到边长一半，不会自交', () => {
    const pts = roundRectPoints(0, 0, 40, 20, 999);
    expect(pts).toHaveLength(8);
    pts.forEach((p) => {
      expect(p.anchor[0]).toBeGreaterThanOrEqual(0);
      expect(p.anchor[0]).toBeLessThanOrEqual(40);
      expect(p.anchor[1]).toBeGreaterThanOrEqual(0);
      expect(p.anchor[1]).toBeLessThanOrEqual(20);
    });
  });
});

describe('buildTable 图层组装', () => {
  it('单一形状 + 无填充 → 只有一个线条图层，名称含行列数', () => {
    const t = buildTable(P({ rows: 3, cols: 4 }), CANVAS);
    expect(t.layers).toHaveLength(1);
    expect(t.layers[0].name).toBe('表格 3×4');
    expect(t.layers[0].role).toBe('line');
    expect(t.groupName).toBeNull();
    expect(t.cellCount).toBe(12);
  });

  it('自定义名称参与命名（需求 §19 的例子）', () => {
    expect(buildTable(P({ name: '商品' }), CANVAS).layers[0].name).toBe('商品 3×4');
    expect(buildTable(P({ name: '   ' }), CANVAS).layers[0].name).toBe('表格 3×4');
  });

  it('开启填充 → 填充层在前（下方）、线条层在后，并套一个组', () => {
    const t = buildTable(P({ fillCells: true }), CANVAS);
    expect(t.layers.map((l) => l.role)).toEqual(['fill', 'line']);
    expect(t.layers[0].name).toBe('表格 3×4 填充');
    expect(t.groupName).toBe('表格 3×4');
  });

  it('独立单元格 → 每格一层，命名 RxCy，全部放进组', () => {
    const t = buildTable(P({ rows: 3, cols: 4, output: 'cells' }), CANVAS);
    expect(t.layers).toHaveLength(12);
    expect(t.layers[0].name).toBe('R1C1');
    expect(t.layers[11].name).toBe('R3C4');
    expect(t.groupName).toBe('表格 3×4');
  });

  it('独立单元格：不填充时每格是描边环（add + subtract）', () => {
    const t = buildTable(P({ output: 'cells', fillCells: false }), CANVAS);
    expect(t.layers[0].components.map((c) => c.op)).toEqual(['add', 'subtract']);
  });

  it('独立单元格：填充时每格是实心矩形', () => {
    const t = buildTable(P({ output: 'cells', fillCells: true }), CANVAS);
    expect(t.layers[0].components).toHaveLength(1);
    expect(t.layers[0].components[0].op).toBe('add');
  });

  it('结构开关：外边框 4 条 + 内竖线 3 条 + 内横线 2 条 = 9 个组件', () => {
    const t = buildTable(P({ rows: 3, cols: 4 }), CANVAS);
    expect(t.layers[0].components).toHaveLength(4 + 3 + 2);
  });

  it('关掉外边框只剩内部线', () => {
    const t = buildTable(P({ rows: 3, cols: 4, border: false }), CANVAS);
    expect(t.layers[0].components).toHaveLength(3 + 2);
  });

  it('关掉内横线 / 内竖线各自生效', () => {
    expect(buildTable(P({ hLines: false }), CANVAS).layers[0].components).toHaveLength(4 + 3);
    expect(buildTable(P({ vLines: false }), CANVAS).layers[0].components).toHaveLength(4 + 2);
  });

  it('三个结构开关全关且不填充 → 不产出任何图层', () => {
    const t = buildTable(P({ border: false, hLines: false, vLines: false }), CANVAS);
    expect(t.layers).toHaveLength(0);
  });

  it('圆角 > 0 时外框改成圆角环（add + subtract），内部线仍是直角细矩形', () => {
    const t = buildTable(P({ rows: 3, cols: 4, radius: 8 }), CANVAS);
    const ops = t.layers[0].components.map((c) => c.op);
    expect(ops.slice(0, 2)).toEqual(['add', 'subtract']);          // 外框环
    expect(ops.slice(2)).toEqual(Array(5).fill('add'));            // 3 竖 + 2 横
    expect(t.layers[0].components[0].points).toHaveLength(8);      // 圆角 → 8 点
    expect(t.layers[0].components[2].points).toHaveLength(4);      // 内线 → 直角 4 点
  });

  it('间距 > 0 时自动改用每格描边环，不再画连续表格线（需求 §24.3）', () => {
    const t = buildTable(P({ rows: 2, cols: 3, colGap: 10, rowGap: 10 }), CANVAS);
    // 6 格 × (add + subtract)
    expect(t.layers[0].components).toHaveLength(12);
    expect(t.layers[0].components.map((c) => c.op)).toEqual(
      Array(6).fill(['add', 'subtract']).flat(),
    );
  });

  it('几何被平移到定位后的绝对坐标', () => {
    const t = buildTable(P({ rows: 1, cols: 1, cellW: 100, cellH: 100, anchor: 'top-left' }), CANVAS);
    expect(t.origin).toEqual({ x: 0, y: 0 });
    expect(t.layers[0].components[0].points[0].anchor).toEqual([0, 0]);

    const c = buildTable(P({ rows: 1, cols: 1, cellW: 100, cellH: 100, anchor: 'center' }), CANVAS);
    expect(c.origin).toEqual({ x: 550, y: 400 });
    expect(c.layers[0].components[0].points[0].anchor).toEqual([550, 400]);
  });

  it('选区/画布模式用给定的左上角，不走九宫格，但仍叠加 X/Y 偏移', () => {
    const t = buildTable(
      P({ sizeSource: 'selection', totalW: 400, totalH: 200, anchor: 'center', offsetX: 5, offsetY: -3 }),
      CANVAS, { left: 120, top: 80 },
    );
    expect(t.origin).toEqual({ x: 125, y: 77 });
  });

  it('单元格数量如实返回，供性能保护判断', () => {
    expect(buildTable(P({ rows: 100, cols: 100, output: 'cells' }), CANVAS).cellCount).toBe(10000);
  });
});

describe('componentsBBox / bboxMatches', () => {
  const rect = (x, y, w, h) => ({
    op: 'add',
    points: roundRectPoints(x, y, w, h, 0),
  });

  it('单个矩形的外接框就是它自己', () => {
    expect(componentsBBox([rect(10, 20, 100, 50)]))
      .toEqual({ left: 10, top: 20, right: 110, bottom: 70 });
  });
  it('多个组件取并集', () => {
    expect(componentsBBox([rect(0, 0, 10, 10), rect(90, 80, 10, 20)]))
      .toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
  });
  it('圆角矩形的控制柄不会撑大外接框', () => {
    expect(componentsBBox([{ op: 'add', points: roundRectPoints(0, 0, 100, 60, 20) }]))
      .toEqual({ left: 0, top: 0, right: 100, bottom: 60 });
  });
  it('没有点时返回 null', () => {
    expect(componentsBBox([])).toBeNull();
    expect(componentsBBox(null)).toBeNull();
    expect(componentsBBox([{ op: 'add', points: [] }])).toBeNull();
  });

  it('容差内算一致', () => {
    const a = { left: 0, top: 0, right: 100, bottom: 60 };
    expect(bboxMatches(a, { left: 1, top: 0, right: 101, bottom: 61 }, 2)).toBe(true);
    expect(bboxMatches(a, { left: 0, top: 0, right: 100, bottom: 60 }, 2)).toBe(true);
  });
  it('铺满画布的空形状层会被判为不一致——正是要抓的那种失败', () => {
    const expected = { left: 400, top: 300, right: 700, bottom: 500 };
    const wholeCanvas = { left: 0, top: 0, right: 1920, bottom: 1080 };
    expect(bboxMatches(expected, wholeCanvas, 2)).toBe(false);
  });
  it('任一为 null 时不判失败（读不到就别误杀）', () => {
    expect(bboxMatches(null, { left: 0, top: 0, right: 1, bottom: 1 })).toBe(true);
    expect(bboxMatches({ left: 0, top: 0, right: 1, bottom: 1 }, null)).toBe(true);
  });
});

describe('独立单元格 → 实时形状矩形', () => {
  const base = {
    rows: 2, cols: 3, sizeMode: 'cell', cellW: 100, cellH: 60,
    rowGap: 0, colGap: 0, lineWidth: 2, radius: 0,
    border: true, hLines: true, vLines: true,
    output: 'cells', fillCells: false,
  };
  const canvas = { width: 1000, height: 800 };
  const origin = { left: 0, top: 0 };

  it('每格一层，都是 kind:rect', () => {
    const plan = buildTable(base, canvas, origin);
    expect(plan.layers).toHaveLength(6);
    expect(plan.layers.every((l) => l.kind === 'rect')).toBe(true);
    expect(plan.layers.map((l) => l.name)).toEqual(
      ['R1C1', 'R1C2', 'R1C3', 'R2C1', 'R2C2', 'R2C3'],
    );
  });

  it('矩形坐标 = 单元格在文档中的实际位置', () => {
    const plan = buildTable(base, canvas, { left: 50, top: 30 });
    expect(plan.layers[0].rect).toEqual({ left: 50, top: 30, right: 150, bottom: 90 });
    // 第二行第一列：往下一个格高，再减掉共用的一条边（线宽 2）
    expect(plan.layers[3].rect).toEqual({ left: 50, top: 88, right: 150, bottom: 148 });
  });

  it('间距会体现在矩形坐标上', () => {
    const plan = buildTable({ ...base, colGap: 10, rowGap: 20 }, canvas, origin);
    expect(plan.layers[1].rect.left).toBe(110);          // 100 + 10
    expect(plan.layers[3].rect.top).toBe(80);            // 60 + 20
  });

  it('描边与填充各自独立，可以同时开', () => {
    const both = buildTable({ ...base, fillCells: true, lineWidth: 3 }, canvas, origin);
    expect(both.layers[0].fill).toBe(true);
    expect(both.layers[0].stroke).toBe(true);
    expect(both.layers[0].lineWidth).toBe(3);
  });

  it('线宽 0 时不描边，只填充', () => {
    const plan = buildTable({ ...base, fillCells: true, lineWidth: 0 }, canvas, origin);
    expect(plan.layers[0].stroke).toBe(false);
    expect(plan.layers[0].fill).toBe(true);
  });

  it('圆角带到每个矩形上', () => {
    const plan = buildTable({ ...base, radius: 8 }, canvas, origin);
    expect(plan.layers.every((l) => l.radius === 8)).toBe(true);
  });

  it('仍带 components 作为后备，且外接框与 rect 一致', () => {
    const plan = buildTable(base, canvas, { left: 50, top: 30 });
    const l = plan.layers[0];
    expect(l.components.length).toBeGreaterThan(0);
    expect(componentsBBox(l.components)).toEqual(l.rect);
  });

  it('单一形状模式不产出 kind:rect', () => {
    const plan = buildTable({ ...base, output: 'single' }, canvas, origin);
    expect(plan.layers.every((l) => l.kind === undefined)).toBe(true);
  });
});

describe('独立单元格：相邻格子共用一条边', () => {
  const canvas = { width: 2000, height: 2000 };
  const at0 = { left: 0, top: 0 };
  const cfg = (o) => ({
    rows: 3, cols: 5, sizeMode: 'cell', cellW: 100, cellH: 60,
    rowGap: 0, colGap: 0, lineWidth: 1, radius: 0,
    output: 'cells', fillCells: false, ...o,
  });

  it('线宽 1、无间距：相邻矩形重叠 1px，内部线与外边框都是 1px', () => {
    const l = buildTable(cfg(), canvas, at0).layers;
    // R1C1 右描边占 [99,100]，R1C2 左描边也占 [99,100] —— 完全重合，合成 1px
    expect(l[0].rect.right).toBe(100);
    expect(l[1].rect.left).toBe(99);
    expect(l[1].rect.right - l[1].rect.left).toBe(100);   // 每格外尺寸仍是 100
  });

  it('线宽 4 时重叠 4px', () => {
    const l = buildTable(cfg({ lineWidth: 4 }), canvas, at0).layers;
    expect(l[0].rect.right).toBe(100);
    expect(l[1].rect.left).toBe(96);
  });

  it('总尺寸随共边收缩：5 列 ×100 线宽 1 → 496 而不是 500', () => {
    const plan = buildTable(cfg(), canvas, at0);
    expect(plan.size.w).toBe(496);                        // 5*100 - 4*1
    expect(plan.size.h).toBe(178);                        // 3*60  - 2*1
    // 最后一格右边缘正好落在总宽上，不多不少
    expect(plan.layers[4].rect.right).toBe(496);
  });

  it('「表格总尺寸」模式下总尺寸精确等于用户填的数', () => {
    const plan = buildTable(
      cfg({ sizeMode: 'total', totalW: 500, totalH: 300 }), canvas, at0,
    );
    expect(plan.size.w).toBe(500);
    expect(plan.size.h).toBe(300);
    expect(plan.layers[4].rect.right).toBeCloseTo(500);
    expect(plan.layers[10].rect.bottom).toBeCloseTo(300);
  });

  it('有间距时不重叠——格子本来就该分开', () => {
    const l = buildTable(cfg({ colGap: 10 }), canvas, at0).layers;
    expect(l[0].rect.right).toBe(100);
    expect(l[1].rect.left).toBe(110);                     // 100 + 10，没有重叠
  });

  it('两个方向各自判断：只有列有间距时，行仍共边', () => {
    const l = buildTable(cfg({ colGap: 10 }), canvas, at0).layers;
    expect(l[1].rect.left).toBe(110);                     // 水平：不重叠
    expect(l[5].rect.top).toBe(59);                       // 垂直：重叠 1px
  });

  it('线宽 0 时没有重叠可言', () => {
    const l = buildTable(cfg({ lineWidth: 0, fillCells: true }), canvas, at0).layers;
    expect(l[1].rect.left).toBe(100);
  });

  it('格子比线宽还小的极端参数不会把矩形算反', () => {
    const l = buildTable(cfg({ cellW: 3, cellH: 3, lineWidth: 10 }), canvas, at0).layers;
    for (const layer of l) {
      expect(layer.rect.right).toBeGreaterThan(layer.rect.left);
      expect(layer.rect.bottom).toBeGreaterThan(layer.rect.top);
    }
  });

  it('单一形状模式不受影响，总宽仍是 5×100', () => {
    const plan = buildTable(
      { ...cfg({ output: 'single' }), border: true, hLines: true, vLines: true }, canvas, at0,
    );
    expect(plan.size.w).toBe(500);
  });
});
