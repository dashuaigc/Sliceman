import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CFG, normalizeCfg, parseSize, parseCount, parseNum,
  computeGuides, dedupe, quickGuides, round2,
  signatureOf, pushRecent, describeCfg,
  ERR_COLS, ERR_ROWS, ERR_EMPTY,
  guideLayoutDescriptor, sameGuides, cfgFromGuideLayout, unitToPx,
  guideLayoutKeys, unknownGuideLayoutKeys, formatGuideLayoutParams, inferCfgFromGuides,
  describeRecord,
} from '../src/lib/guide-core.js';

const CANVAS = { width: 1920, height: 1080 };

// 出厂默认是「全 0 = 什么都不建」，直接拿它当测试基线每条都得写满参数，
// 所以这里另起一个常用基线：4 列 3 行 / 自动 / 装订线 20 / 四边边距 40。
const BASE = {
  unit: 'px',
  cols: { count: 4, size: null, gutter: 20, center: false },
  rows: { count: 3, size: null, gutter: 20 },
  margins: { top: 40, bottom: 40, left: 40, right: 40 },
  clearFirst: true,
};
const cfg = (o = {}) => ({
  ...BASE,
  ...o,
  cols: { ...BASE.cols, ...(o.cols || {}) },
  rows: { ...BASE.rows, ...(o.rows || {}) },
  margins: { ...BASE.margins, ...(o.margins || {}) },
});
// 「不启用」= 把数字填成 0，没有单独的开关
const NO_COLS = { count: 0 };
const NO_ROWS = { count: 0 };
const NO_MARGINS = { top: 0, bottom: 0, left: 0, right: 0 };

describe('参数归一', () => {
  it('出厂默认是全 0：什么都不建', () => {
    const c = normalizeCfg(DEFAULT_CFG);
    expect(c.cols.on).toBe(false);
    expect(c.rows.on).toBe(false);
    expect(c.margins.on).toBe(false);
    expect(c.clearFirst).toBe(true);
  });

  it('填了数字就启用，没填（0）就不启用 —— on 是派生的，不从入参读', () => {
    expect(normalizeCfg({ cols: { count: 4 } }).cols.on).toBe(true);
    expect(normalizeCfg({ cols: { count: 0 } }).cols.on).toBe(false);
    expect(normalizeCfg({ cols: { count: '' } }).cols.on).toBe(false);
    expect(normalizeCfg({ rows: { count: 1 } }).rows.on).toBe(true);
    expect(normalizeCfg({ margins: { left: 40 } }).margins.on).toBe(true);
    expect(normalizeCfg({ margins: { top: 0, left: 0 } }).margins.on).toBe(false);
    // 入参里写了 on 也不算数：一律以数字为准
    expect(normalizeCfg({ cols: { on: true, count: 0 } }).cols.on).toBe(false);
    expect(normalizeCfg({ cols: { on: false, count: 3 } }).cols.on).toBe(true);
  });

  it('宽度：空 / auto / 自动 都识别为「自动」', () => {
    expect(parseSize('')).toBe(null);
    expect(parseSize('自动')).toBe(null);
    expect(parseSize('AUTO')).toBe(null);
    expect(parseSize(null)).toBe(null);
    expect(parseSize('300')).toBe(300);
    expect(parseSize('300px')).toBe(300);      // 带单位也认（需求 §17）
  });

  it('数量非正即 0（= 不启用），装订线 / 边距至少为 0（需求 §19）', () => {
    expect(parseCount('0')).toBe(0);
    expect(parseCount('-3')).toBe(0);
    expect(parseCount('abc')).toBe(0);
    expect(parseCount('')).toBe(0);
    expect(parseCount('12')).toBe(12);
    expect(parseNum('-5', 20)).toBe(0);
    expect(parseNum('x', 20)).toBe(20);
    expect(parseSize('-8')).toBe(0);
  });

  it('缺字段一律按 0 补，老记录应用时不会崩', () => {
    const c = normalizeCfg({ cols: { count: 6 } });
    expect(c.cols.count).toBe(6);
    expect(c.cols.gutter).toBe(0);
    expect(c.rows.count).toBe(0);
    expect(c.margins.left).toBe(0);
    expect(c.unit).toBe('px');
  });
});

describe('computeGuides 列版面', () => {
  it('需求 §2.1 的算例：1920 画布 / 左右边距 100 / 4 列 / 装订线 20 → 每列 415px', () => {
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 4, size: null, gutter: 20 },
      margins: { top: 0, bottom: 0, left: 100, right: 100 },
    }), CANVAS);
    expect(r.error).toBe(null);
    expect(r.colSize).toBe(415);
    // 边距两条(100 / 1820) 与首末列边线重合 → 去重后仍是 8 条
    expect(r.vertical).toEqual([
      100, 515,        // 第 1 列
      535, 950,        // 第 2 列
      970, 1385,       // 第 3 列
      1405, 1820,      // 第 4 列
    ]);
  });

  it('固定列宽未占满时，关闭列居中 → 从左边距开始排', () => {
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 4, size: 300, gutter: 20, center: false },
      margins: { top: 0, bottom: 0, left: 40, right: 40 },
    }), CANVAS);
    expect(r.error).toBe(null);
    expect(r.vertical.slice(0, 4)).toEqual([40, 340, 360, 660]);
  });

  it('开启列居中 → 整套列布局在可用区间内水平居中（需求 §4）', () => {
    // 可用宽 1920-80=1840，总宽 4*300+3*20=1260，两侧各留 (1840-1260)/2=290
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 4, size: 300, gutter: 20, center: true },
      margins: { top: 0, bottom: 0, left: 40, right: 40 },
    }), CANVAS);
    expect(r.error).toBe(null);
    expect(r.vertical).toContain(330);          // 40 + 290
    expect(r.vertical).toContain(1590);         // 330 + 1260
  });

  it('列数为 1 时没有装订线', () => {
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 1, size: null, gutter: 20 },
      margins: { top: 0, bottom: 0, left: 100, right: 100 },
    }), CANVAS);
    expect(r.colSize).toBe(1720);
    expect(r.vertical).toEqual([100, 1820]);
  });
});

describe('computeGuides 行版面', () => {
  it('3 行自动 + 上下边距 40 / 装订线 20 → 每行 320px', () => {
    const r = computeGuides(cfg({
      cols: NO_COLS,
      rows: { count: 3, size: null, gutter: 20 },
      margins: { top: 40, bottom: 40, left: 0, right: 0 },
    }), CANVAS);
    // (1080-80) - 20*2 = 960，/3 = 320
    expect(r.rowSize).toBe(320);
    expect(r.horizontal).toEqual([40, 360, 380, 700, 720, 1040]);
  });

  it('列和行可以同时填，各自生成（需求 §2.3）', () => {
    const r = computeGuides(cfg({}), CANVAS);
    expect(r.error).toBe(null);
    expect(r.vertical).toHaveLength(8);
    expect(r.horizontal).toHaveLength(6);
  });
});

describe('computeGuides 边距与校验', () => {
  it('只填边距时生成四条边线，四边可各不相同（需求 §3）', () => {
    const r = computeGuides(cfg({
      cols: NO_COLS,
      rows: NO_ROWS,
      margins: { top: 100, bottom: 200, left: 40, right: 60 },
    }), CANVAS);
    expect(r.vertical).toEqual([40, 1860]);
    expect(r.horizontal).toEqual([100, 880]);
  });

  it('边距留空（0）时列铺满整个画布宽度，也不画边线', () => {
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 2, size: null, gutter: 0 },
      margins: NO_MARGINS,
    }), CANVAS);
    expect(r.vertical).toEqual([0, 960, 1920]);
    expect(r.colSize).toBe(960);
  });

  it('列宽 + 装订线 + 边距超过画布宽度 → 报错且不出坐标（需求 §19）', () => {
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 4, size: 500, gutter: 20 },
      margins: { top: 0, bottom: 0, left: 40, right: 40 },
    }), CANVAS);
    expect(r.error).toBe(ERR_COLS);
    expect(r.vertical).toEqual([]);
  });

  it('装订线吃光可用宽度（自动列宽算出 <= 0）也报同一条错', () => {
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 4, size: null, gutter: 700 },
      margins: { top: 0, bottom: 0, left: 40, right: 40 },
    }), CANVAS);
    expect(r.error).toBe(ERR_COLS);
  });

  it('行高超过画布高度 → 报行的错', () => {
    const r = computeGuides(cfg({
      cols: NO_COLS,
      rows: { count: 5, size: 400, gutter: 0 },
      margins: NO_MARGINS,
    }), CANVAS);
    expect(r.error).toBe(ERR_ROWS);
  });

  it('三项都没填 → 明确提示，不静默生成空版面', () => {
    const r = computeGuides(cfg({ cols: NO_COLS, rows: NO_ROWS, margins: NO_MARGINS }), CANVAS);
    expect(r.error).toBe(ERR_EMPTY);
  });
});

describe('数值精度（需求 §33）', () => {
  it('除不尽时保留两位小数，不取整', () => {
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 3, size: null, gutter: 0 },
      margins: NO_MARGINS,
    }), { width: 1000, height: 500 });
    expect(round2(r.colSize)).toBe(333.33);
    expect(r.vertical).toEqual([0, 333.33, 666.67, 1000]);
  });

  it('最后一列的右边线仍贴齐可用区间右端，不因取整跑偏', () => {
    const r = computeGuides(cfg({
      rows: NO_ROWS,
      cols: { count: 7, size: null, gutter: 13 },
      margins: { top: 0, bottom: 0, left: 17, right: 23 },
    }), CANVAS);
    expect(r.vertical[r.vertical.length - 1]).toBe(1897);   // 1920 - 23
  });
});

describe('dedupe 重复参考线（需求 §32）', () => {
  it('同一位置只保留一条', () => {
    expect(dedupe([100, 200, 100, 300])).toEqual([100, 200, 300]);
  });

  it('与文档中已有的参考线重合时不再创建', () => {
    expect(dedupe([100, 200, 300], [200])).toEqual([100, 300]);
  });

  it('相差不到 0.01px 视为同一条', () => {
    expect(dedupe([100, 100.004])).toEqual([100]);
    expect(dedupe([100, 100.02])).toEqual([100, 100.02]);
  });
});

describe('quickGuides 快速参考线（需求 §24）', () => {
  it('十字中心', () => {
    expect(quickGuides('cross', CANVAS)).toEqual({ vertical: [960], horizontal: [540] });
  });

  it('认不出来的类型 → 一条都不建', () => {
    expect(quickGuides('thirdsV', CANVAS)).toEqual({ vertical: [], horizontal: [] });
  });

  it('九宫格 = 横竖三等分同时创建', () => {
    const r = quickGuides('nine', CANVAS);
    expect(r.vertical).toEqual([640, 1280]);
    expect(r.horizontal).toEqual([360, 720]);
  });
});

describe('历史记录（需求 §10）', () => {
  const rec = (c, canvas = CANVAS, at = 1) => ({ cfg: cfg(c), canvas, at });

  it('参数完全相同时不产生重复记录，而是提到第一位', () => {
    const a = rec({ cols: { count: 4 } });
    const b = rec({ cols: { count: 12 } });
    let list = pushRecent([], a);
    list = pushRecent(list, b);
    expect(list).toHaveLength(2);
    // 再来一次 a：仍是两条，且 a 回到第一位
    list = pushRecent(list, rec({ cols: { count: 4 } }, CANVAS, 999));
    expect(list).toHaveLength(2);
    expect(list[0].cfg.cols.count).toBe(4);
    expect(list[0].at).toBe(999);
  });

  it('任一关键参数不同即视为新记录', () => {
    let list = pushRecent([], rec({ cols: { gutter: 20 } }));
    list = pushRecent(list, rec({ cols: { gutter: 16 } }));
    expect(list).toHaveLength(2);
  });

  it('画布尺寸不同但参数相同 → 仍是同一条，画布尺寸被刷新（§16）', () => {
    let list = pushRecent([], rec({}, { width: 1920, height: 1080 }));
    list = pushRecent(list, rec({}, { width: 2560, height: 1440 }));
    expect(list).toHaveLength(1);
    expect(list[0].canvas.width).toBe(2560);
  });

  it('「清除现有的参考线」不参与去重：它是操作偏好，不是版面本身', () => {
    expect(signatureOf(cfg({ clearFirst: true }))).toBe(signatureOf(cfg({ clearFirst: false })));
  });

  it('最多保留 20 条，最旧的被挤掉（需求 §8）', () => {
    let list = [];
    for (let i = 1; i <= 25; i++) list = pushRecent(list, rec({ cols: { count: i } }));
    expect(list).toHaveLength(20);
    expect(list[0].cfg.cols.count).toBe(25);
    expect(list[19].cfg.cols.count).toBe(6);
  });
});

describe('describeCfg 列表文案', () => {
  it('列 + 行 + 四边相同的边距', () => {
    const d = describeCfg(cfg({}));
    expect(d.title).toBe('4列 / 3行');
    expect(d.detail).toBe('列 4 · 宽度自动 · 装订线 20px；行 3 · 高度自动 · 装订线 20px；边距 40px');
    expect(d.name).toBe('4列3行 - 20px');       // 收藏默认名（需求 §13）
  });

  it('只有列 + 固定宽度', () => {
    const d = describeCfg(cfg({
      rows: NO_ROWS,
      cols: { count: 12, size: 120, gutter: 16 },
      margins: NO_MARGINS,
    }));
    expect(d.title).toBe('12列');
    // 没设的那两块也要明写出来，不然看着像插件把它们漏了
    expect(d.detail).toBe('列 12 · 宽度 120px · 装订线 16px；行 未设置；边距 未设置');
    expect(d.name).toBe('12列 - 16px');
  });

  it('四边不同的边距逐边列出', () => {
    const d = describeCfg(cfg({
      cols: NO_COLS, rows: NO_ROWS,
      margins: { top: 100, bottom: 200, left: 40, right: 40 },
    }));
    expect(d.title).toBe('仅边距');
    expect(d.detail).toBe('列 未设置；行 未设置；边距 上100 下200 左40 右40');
  });
});

// ---- 重放一份版面用的描述符（键名以真机抓到的那份为准）----
describe('guideLayoutDescriptor', () => {
  const px = (v) => ({ _unit: 'pixelsUnit', _value: v });

  it('默认平铺在顶层，列用 colCount / colGutter（不是 columnCount）', () => {
    const d = guideLayoutDescriptor(BASE);
    expect(d._obj).toBe('newGuideLayout');
    expect(d.guideTarget).toEqual({ _enum: 'guideTarget', _value: 'guideTargetCanvas' });
    expect(d.guideLayout).toBeUndefined();
    expect(d.colCount).toBe(4);
    expect(d.colGutter).toEqual(px(20));
    expect(d.rowCount).toBe(3);
    expect(d.rowGutter).toEqual(px(20));
    expect(d.marginTop).toEqual(px(40));
    expect(d.marginRight).toEqual(px(40));
    expect(d.centerColumns).toBe(false);
    expect(d.clearExistingGuides).toBe(true);
  });

  it('宽度 / 高度留空就不给那个键：宽度栏留空 = 由 PS 均分', () => {
    const d = guideLayoutDescriptor(BASE);
    expect('colWidth' in d).toBe(false);
    expect('rowHeight' in d).toBe(false);
    const fixed = guideLayoutDescriptor(cfg({
      cols: { count: 3, size: 200, gutter: 10, center: true },
    }));
    expect(fixed.colWidth).toEqual(px(200));
    expect(fixed.centerColumns).toBe(true);
  });

  it('没填的整块一个键都不给：留空 = 那一项不启用', () => {
    const onlyCols = guideLayoutDescriptor(cfg({
      rows: { count: 0 }, margins: { top: 0, bottom: 0, left: 0, right: 0 },
    }));
    expect(onlyCols.colCount).toBe(4);
    expect('rowCount' in onlyCols).toBe(false);
    expect('marginTop' in onlyCols).toBe(false);
  });

  it('「清除现有的参考线」映射成 clearExistingGuides', () => {
    expect(guideLayoutDescriptor(cfg({ clearFirst: false })).clearExistingGuides).toBe(false);
  });

  it('full 模式：每个键都写满，没启用的写 0（预填弹窗用）', () => {
    const d = guideLayoutDescriptor(cfg({
      rows: { count: 5, gutter: 0 },
      cols: { count: 0 },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    }), { full: true });
    expect(d.rowCount).toBe(5);
    expect(d.colCount).toBe(0);                       // 没启用也要明写 0
    expect(d.colWidth).toEqual(px(0));                // 0 = 宽度栏留空 = 自动
    expect(d.colGutter).toEqual(px(0));
    expect(d.marginTop).toEqual(px(0));
    expect(d.marginRight).toEqual(px(0));
  });

  it('嵌套形状（兜底）：参数套进 guideLayout 子对象', () => {
    const d = guideLayoutDescriptor(BASE, { nested: true });
    expect(d.presetKind).toEqual({ _enum: 'presetKindType', _value: 'presetKindCustom' });
    expect(d.guideLayout.colCount).toBe(4);
    expect(d.guideLayout.marginRight).toEqual(px(40));
    expect(d.colCount).toBeUndefined();
  });
});

describe('sameGuides（判断原生弹窗到底有没有改文档）', () => {
  it('顺序不同、有重复也算一样', () => {
    expect(sameGuides(
      { vertical: [100, 200, 200], horizontal: [] },
      { vertical: [200, 100], horizontal: [] },
    )).toBe(true);
  });
  it('多一条 / 少一条 / 位置差得多就算变了', () => {
    expect(sameGuides({ vertical: [100], horizontal: [] }, { vertical: [100, 300], horizontal: [] }))
      .toBe(false);
    expect(sameGuides({ vertical: [100], horizontal: [] }, { vertical: [101], horizontal: [] }))
      .toBe(false);
    expect(sameGuides({ vertical: [], horizontal: [50] }, { vertical: [], horizontal: [] }))
      .toBe(false);
  });
  it('0.01 以内的抖动不算变（与去重同一个容差）', () => {
    expect(sameGuides({ vertical: [100], horizontal: [] }, { vertical: [100.005], horizontal: [] }))
      .toBe(true);
  });
});

// ---- 把 PS 执行的 newGuideLayout 描述符读回成插件配置（记录功能的入口）----
describe('cfgFromGuideLayout', () => {
  const px = (v) => ({ _unit: 'pixelsUnit', _value: v });
  const CV = { width: 1000, height: 500 };
  const nested = (over = {}) => ({
    _obj: 'newGuideLayout',
    guideLayout: Object.assign({
      _obj: 'guideLayout',
      columnCount: 4, columnGutter: px(20),
      rowCount: 3, rowGutter: px(10),
      marginTop: px(40), marginLeft: px(30), marginBottom: px(40), marginRight: px(30),
      centerColumns: false, clearExistingGuides: true,
    }, over),
  });

  it('嵌套形状：列 / 行 / 边距原样读回，宽高没给就是「自动」', () => {
    const c = cfgFromGuideLayout(nested(), CV);
    expect(c.cols).toEqual({ on: true, count: 4, size: null, gutter: 20, center: false });
    expect(c.rows).toEqual({ on: true, count: 3, size: null, gutter: 10 });
    expect(c.margins).toEqual({ on: true, top: 40, left: 30, bottom: 40, right: 30 });
    expect(c.clearFirst).toBe(true);
  });

  it('平铺形状（参数直接在顶层）一样能读', () => {
    const flat = { _obj: 'newGuideLayout', columnCount: 2, columnGutter: px(8) };
    const c = cfgFromGuideLayout(flat, CV);
    expect(c.cols.count).toBe(2);
    expect(c.cols.gutter).toBe(8);
    expect(c.rows.on).toBe(false);
  });

  it('给了固定宽 / 高就不是「自动」，列居中也读回来', () => {
    const c = cfgFromGuideLayout(nested({
      columnWidth: px(200), rowHeight: px(100), centerColumns: true,
    }), CV);
    expect(c.cols.size).toBe(200);
    expect(c.cols.center).toBe(true);
    expect(c.rows.size).toBe(100);
  });

  it('百分比按对应轴的画布尺寸折算成 px', () => {
    const c = cfgFromGuideLayout(nested({
      columnGutter: { _unit: 'percentUnit', _value: 10 },        // 1000 的 10%
      marginTop: { _unit: 'percentUnit', _value: 20 },           // 500 的 20%
    }), CV);
    expect(c.cols.gutter).toBe(100);
    expect(c.margins.top).toBe(100);
  });

  it('厘米 / 英寸按分辨率折算成 px', () => {
    const c = cfgFromGuideLayout(nested({
      columnGutter: { _unit: 'millimetersUnit', _value: 25.4 },   // 1 英寸
      marginLeft: { _unit: 'distanceUnit', _value: 2 },           // 2 英寸
    }), CV, 300);
    expect(c.cols.gutter).toBe(300);
    expect(c.margins.left).toBe(600);
  });

  it('「清除现有的参考线」没勾就是 false', () => {
    expect(cfgFromGuideLayout(nested({ clearExistingGuides: false }), CV).clearFirst).toBe(false);
  });

  it('一项参数都没有 / 不是描述符 → null，不记脏数据', () => {
    expect(cfgFromGuideLayout({ _obj: 'newGuideLayout' }, CV)).toBe(null);
    expect(cfgFromGuideLayout(nested({
      columnCount: 0, rowCount: 0,
      marginTop: px(0), marginLeft: px(0), marginBottom: px(0), marginRight: px(0),
    }), CV)).toBe(null);
    expect(cfgFromGuideLayout(null, CV)).toBe(null);
    expect(cfgFromGuideLayout('nope', CV)).toBe(null);
  });

  it('读回来的配置能原样再拼成描述符（记录 → 重放 的往返）', () => {
    const c = cfgFromGuideLayout(nested(), CV);
    const d = guideLayoutDescriptor(c);
    expect(d.colCount).toBe(4);
    expect(d.colGutter).toEqual(px(20));
    expect(d.rowCount).toBe(3);
    expect(d.marginLeft).toEqual(px(30));
    expect(d.clearExistingGuides).toBe(true);
  });

  it('真机抓到的那一份（平铺 + colCount + 颜色键）读得出列与行', () => {
    const real = {
      _obj: 'newGuideLayout',
      colCount: 5, rowCount: 2,
      $GdCA: 0, $GdCR: 74, $GdCG: 255, $GdCB: 255,
    };
    const c = cfgFromGuideLayout(real, { width: 1151, height: 1002 });
    expect(c.cols.count).toBe(5);
    expect(c.rows.count).toBe(2);
    expect(describeCfg(c).title).toBe('5列 / 2行');
    // 颜色键与元字段不该被当成「没认出来的参数」
    expect(unknownGuideLayoutKeys(real)).toEqual([]);
  });
});

describe('unitToPx', () => {
  it('像素与裸数字原样返回；未知单位当像素', () => {
    expect(unitToPx(12)).toBe(12);
    expect(unitToPx({ _unit: 'pixelsUnit', _value: 12.345 })).toBe(12.35);
    expect(unitToPx({ _unit: 'someNewUnit', _value: 7 })).toBe(7);
  });
  it('读不出数字就返回 null', () => {
    expect(unitToPx(null)).toBe(null);
    expect(unitToPx({ _unit: 'pixelsUnit', _value: 'abc' })).toBe(null);
  });
  it('分辨率缺省按 72ppi', () => {
    expect(unitToPx({ _unit: 'distanceUnit', _value: 1 })).toBe(72);
  });
});

describe('cfgFromGuideLayout：键名别名与诊断', () => {
  const px = (v) => ({ _unit: 'pixelsUnit', _value: v });
  const CV = { width: 1000, height: 500 };

  it('换用别名的键也能读出来（列没认出来 = 记录里只剩行，宁可多备候选）', () => {
    const c = cfgFromGuideLayout({
      _obj: 'newGuideLayout',
      guideLayout: {
        _obj: 'guideLayout',
        numberOfColumns: 4, gutter: px(20),
        numberOfRows: 2, rowGutter: px(10),
        top: px(30), left: px(30), bottom: px(30), right: px(30),
      },
    }, CV);
    expect(c.cols.count).toBe(4);
    expect(c.cols.gutter).toBe(20);
    expect(c.rows.count).toBe(2);
    expect(c.rows.gutter).toBe(10);
    expect(c.margins.top).toBe(30);
  });

  it('只填了列也照样记成一条（摘要是「4列」）', () => {
    const c = cfgFromGuideLayout({
      _obj: 'newGuideLayout',
      guideLayout: { _obj: 'guideLayout', columnCount: 4, columnGutter: px(20) },
    }, CV);
    expect(c.cols.on).toBe(true);
    expect(c.rows.on).toBe(false);
    expect(describeCfg(c).title).toBe('4列');
  });

  it('别名的值是子描述符时跳过它，不把对象当成 0', () => {
    const c = cfgFromGuideLayout({
      _obj: 'newGuideLayout',
      guideLayout: {
        _obj: 'guideLayout',
        columns: { _obj: 'somethingElse' },      // 不是数字：跳过
        columnCount: 3,
      },
    }, CV);
    expect(c.cols.count).toBe(3);
  });

  it('formatGuideLayoutParams 把参数摊成一行（状态栏报「没认出来的参数」用）', () => {
    const desc = { _obj: 'newGuideLayout', colCnt: 4, rowCount: 2, $GdCR: 74 };
    expect(formatGuideLayoutParams(desc, unknownGuideLayoutKeys(desc))).toBe('colCnt=4');
    expect(formatGuideLayoutParams({
      _obj: 'newGuideLayout', colGutter: { _unit: 'pixelsUnit', _value: 20 }, centerColumns: true,
    })).toBe('colGutter=20px · centerColumns=是');
  });

  it('guideLayoutKeys 列出实际收到的参数键（读不出参数时用来定位问题）', () => {
    expect(guideLayoutKeys({
      _obj: 'newGuideLayout',
      guideLayout: { _obj: 'guideLayout', columnCount: 4, marginTop: px(10) },
    })).toEqual(['columnCount', 'marginTop']);
    expect(guideLayoutKeys({ _obj: 'newGuideLayout', rowCount: 2, null: {} })).toEqual(['rowCount']);
    expect(guideLayoutKeys(null)).toEqual([]);
  });
});

describe('inferCfgFromGuides：只看参考线，把版面参数反推回来', () => {
  const canvas = { width: 1920, height: 1080 };
  const none = { vertical: [], horizontal: [] };

  it('4 列 / 自动宽 / 装订线 20 / 左右边距 100', () => {
    const after = { vertical: [100, 515, 535, 950, 970, 1385, 1405, 1820], horizontal: [] };
    const cfg = inferCfgFromGuides(none, after, canvas);
    expect(cfg.cols).toMatchObject({ on: true, count: 4, size: null, gutter: 20 });
    expect(cfg.margins).toMatchObject({ on: true, left: 100, right: 100 });
    expect(cfg.rows.on).toBe(false);
  });

  it('反推出来的配置再算一遍，坐标和原来一样', () => {
    const after = { vertical: [100, 515, 535, 950, 970, 1385, 1405, 1820], horizontal: [] };
    const cfg = inferCfgFromGuides(none, after, canvas);
    const plan = computeGuides(cfg, canvas);
    expect(plan.error).toBe(null);
    expect(plan.vertical).toEqual(after.vertical);
  });

  it('装订线 0 时相邻列共用一条线，也能认出列数', () => {
    const after = { vertical: [0, 480, 960, 1440, 1920], horizontal: [] };
    const cfg = inferCfgFromGuides(none, after, canvas);
    expect(cfg.cols).toMatchObject({ count: 4, gutter: 0, size: null });
    expect(cfg.margins.on).toBe(false);
  });

  it('行和列一起建：两个方向分别反推，边距四边都读出来', () => {
    const after = {
      vertical: [40, 940, 980, 1880],
      horizontal: [40, 520, 560, 1040],
    };
    const cfg = inferCfgFromGuides(none, after, canvas);
    expect(cfg.cols).toMatchObject({ count: 2, gutter: 40, size: null });
    expect(cfg.rows).toMatchObject({ count: 2, gutter: 40, size: null });
    expect(cfg.margins).toMatchObject({ top: 40, bottom: 40, left: 40, right: 40 });
  });

  it('只设了边距：不认成 1 列，只记边距', () => {
    const after = { vertical: [60, 1860], horizontal: [80, 1000] };
    const cfg = inferCfgFromGuides(none, after, canvas);
    expect(cfg.cols.on).toBe(false);
    expect(cfg.rows.on).toBe(false);
    expect(cfg.margins).toMatchObject({ left: 60, right: 60, top: 80, bottom: 80 });
  });

  it('旧参考线还在 = 追加模式：只看新增的那批，clearFirst 记为 false', () => {
    const before = { vertical: [7], horizontal: [] };
    const after = { vertical: [7, 0, 480, 960, 1440, 1920], horizontal: [] };
    const cfg = inferCfgFromGuides(before, after, canvas);
    expect(cfg.clearFirst).toBe(false);
    expect(cfg.cols).toMatchObject({ count: 4, gutter: 0 });
  });

  it('旧参考线没了 = 清除现有，clearFirst 记为 true', () => {
    const before = { vertical: [7], horizontal: [] };
    const after = { vertical: [0, 480, 960, 1440, 1920], horizontal: [] };
    expect(inferCfgFromGuides(before, after, canvas).clearFirst).toBe(true);
  });

  it('边距线单独存在（固定宽 + 列居中）：去掉首尾两条再认，记成固定宽并勾上居中', () => {
    // 左右边距 100，3 列固定宽 300、装订线 40，居中后从 470 开始
    const after = { vertical: [100, 470, 770, 810, 1110, 1150, 1450, 1820], horizontal: [] };
    const cfg = inferCfgFromGuides(none, after, canvas);
    expect(cfg.cols).toMatchObject({ count: 3, size: 300, gutter: 40, center: true });
    expect(cfg.margins).toMatchObject({ left: 100, right: 100 });
    expect(computeGuides(cfg, canvas).vertical).toEqual(after.vertical);
  });

  it('列不贴边但没有单独的边距线：按等效的「边距 + 自动宽」记，坐标一模一样', () => {
    // 几何上区分不了「边距 460 + 自动宽」和「无边距 + 固定宽居中」，
    // 取前者：重放出来的线完全一致，跨画布时还能自动重算
    const after = { vertical: [460, 760, 800, 1100, 1140, 1440], horizontal: [] };
    const cfg = inferCfgFromGuides(none, after, canvas);
    expect(cfg.cols).toMatchObject({ count: 3, size: null, gutter: 40 });
    expect(cfg.margins).toMatchObject({ left: 460, right: 480 });
    expect(computeGuides(cfg, canvas).vertical).toEqual(after.vertical);
  });

  it('认不出来的形状 → null，宁可不记也不记错', () => {
    const after = { vertical: [13, 500, 777], horizontal: [] };
    expect(inferCfgFromGuides(none, after, canvas)).toBe(null);
  });

  it('一条都没有 / 画布无效 → null', () => {
    expect(inferCfgFromGuides(none, none, canvas)).toBe(null);
    expect(inferCfgFromGuides(none, { vertical: [0, 960, 1920] }, null)).toBe(null);
  });
});

describe('describeRecord：原样快照另写一套文案', () => {
  it('规则版面的记录仍按参数描述', () => {
    const cfg = normalizeCfg({ cols: { count: 4, gutter: 20 } });
    expect(describeRecord({ cfg }).title).toBe(describeCfg(cfg).title);
  });

  it('快照按条数描述，默认名字也带上条数', () => {
    const d = describeRecord({ raw: true, guides: { vertical: [13, 500], horizontal: [777] } });
    expect(d.title).toBe('纵 2 条 / 横 1 条');
    expect(d.detail).toMatch(/按原坐标重放/);
    expect(d.name).toBe('自定版面 纵 2 条 / 横 1 条');
  });

  it('一条线都没有的快照也有文案，不报错', () => {
    expect(describeRecord({ raw: true, guides: {} }).title).toBe('空版面');
  });
});
