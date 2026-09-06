// 参考线助手的纯逻辑：参数归一 → 版面几何 → 去重 → 历史记录管理。
// 不依赖 Photoshop，可在 Node 下单测（见 tests/guide-core.test.js）。
//
// PS 侧（src/ps/guides.js）只负责把这里算出的坐标数组下发成参考线，不含任何计算。
//
// 坐标系与 PS 一致：原点左上角，x 向右、y 向下增大，单位像素。
// 「竖向参考线」是一条竖线，位置是它的 x；「横向参考线」是一条横线，位置是它的 y。

/** 浮点比较容差：两条参考线相距不到 0.01px 视为同一条 */
export const EPS = 0.01;

/**
 * 出厂默认版面：全部为 0 / 空 = 什么都不建。
 * 列、行、边距【没有单独的启用开关】——填了数字就算启用，留空（= 0）就算不启用，
 * 见 normalizeCfg 里派生出来的 on 字段。
 */
export const DEFAULT_CFG = {
  unit: 'px',                 // 预留：后续版本支持 '%'，第一版只走 px
  cols: { count: 0, size: null, gutter: 0, center: false },
  rows: { count: 0, size: null, gutter: 0 },
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
  clearFirst: true,
};

/** 显示用：最多保留两位小数，且不留 415.00 这种尾零（需求 §33） */
export function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** 数字转显示串：415.333 → "415.33"，20 → "20" */
export function fmt(v) {
  return String(round2(v));
}

/** 画布尺寸摘要："1920 × 1080" */
export function formatCanvas(canvas) {
  if (!canvas) return '';
  return `${Math.round(canvas.width)} × ${Math.round(canvas.height)}`;
}

// ---- 参数归一 ----

const AUTO_WORDS = ['', 'auto', '自动'];

/**
 * 读「宽度 / 高度」这类可为“自动”的字段。
 * 空串 / 'auto' / '自动' / null → null（= 自动）；其余按数字取，负数夹到 0。
 */
export function parseSize(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (AUTO_WORDS.includes(s)) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;            // 填了看不懂的东西 → 当自动，别炸
  return Math.max(0, n);
}

/** 读非负数值（装订线 / 边距）；非法回落到默认值 */
export function parseNum(v, dflt = 0) {
  const n = parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? Math.max(0, n) : dflt;
}

/**
 * 读数量：非负整数。0 / 空 / 非法都算 0，也就是「这一项不启用」。
 * 没有单独的开关，数量本身就是开关（需求：填入数字默认开，没有数字默认关）。
 */
export function parseCount(v) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 把任意来源（界面输入 / localStorage 里的记录）的配置补齐并夹到合法范围。
 * 缺字段一律按 0 / 空补，缺的那项就自然是「不启用」。
 *
 * `on` 是【派生】出来的，不从入参里读：列 / 行看数量是否 ≥ 1，
 * 边距看四边是否有任何一边大于 0。这样界面上就不需要三个开关。
 */
export function normalizeCfg(raw) {
  const r = raw || {};
  const c = r.cols || {};
  const w = r.rows || {};
  const m = r.margins || {};

  const cols = {
    count: parseCount(c.count),
    size: parseSize(c.size),
    gutter: parseNum(c.gutter, 0),
    center: !!c.center,
  };
  cols.on = cols.count >= 1;

  const rows = {
    count: parseCount(w.count),
    size: parseSize(w.size),
    gutter: parseNum(w.gutter, 0),
  };
  rows.on = rows.count >= 1;

  const margins = {
    top: parseNum(m.top, 0),
    bottom: parseNum(m.bottom, 0),
    left: parseNum(m.left, 0),
    right: parseNum(m.right, 0),
  };
  margins.on = margins.top > 0 || margins.bottom > 0 || margins.left > 0 || margins.right > 0;

  return {
    unit: r.unit === '%' ? '%' : 'px',
    cols,
    rows,
    margins,
    clearFirst: r.clearFirst !== false,
  };
}

// ---- 版面几何 ----

/**
 * 单轴排布：把 n 个等宽轨道摆进 [offset, offset+avail] 区间，返回每条轨道的两条边线。
 * size 为 null 表示自动——此时轨道正好铺满可用区间。
 * @returns {{lines:number[]|null, size:number, total:number}} lines 为 null 表示放不下
 */
function planAxis(spec, avail, offset, center) {
  const n = spec.count;
  const gutter = spec.gutter;
  const gut = gutter * (n - 1);
  let size = spec.size;
  if (size == null) {
    size = (avail - gut) / n;                      // 自动：可用区间减掉全部装订线后均分
    if (!(size > 0)) return { lines: null, size: 0, total: 0 };
  }
  const total = n * size + gut;
  if (total > avail + EPS) return { lines: null, size, total };
  // 居中只对固定宽有意义：自动宽时 total === avail，偏移恒为 0
  const start = offset + (center ? (avail - total) / 2 : 0);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = start + i * (size + gutter);
    lines.push(round2(a), round2(a + size));
  }
  return { lines, size, total };
}

export const ERR_COLS = '当前列设置超过画布宽度，请调整列宽、装订线或边距。';
export const ERR_ROWS = '当前行设置超过画布高度，请调整行高、装订线或边距。';
export const ERR_EMPTY = '请至少填入列数、行数或边距，再点「创建参考线」。';
export const ERR_MARGIN_W = '左右边距之和超过画布宽度，请调小边距。';
export const ERR_MARGIN_H = '上下边距之和超过画布高度，请调小边距。';
export const ERR_NO_CANVAS = '读不到画布尺寸，请先打开一个 Photoshop 文档。';

/**
 * 按版面配置算出全部参考线坐标。
 * @param {object} rawCfg 见 DEFAULT_CFG
 * @param {{width:number, height:number}} canvas 当前画布尺寸（px）
 * @returns {{vertical:number[], horizontal:number[], error:string|null,
 *            colSize:number|null, rowSize:number|null}}
 *          vertical 是竖线的 x 列表，horizontal 是横线的 y 列表；error 非空时不应创建
 */
export function computeGuides(rawCfg, canvas) {
  const cfg = normalizeCfg(rawCfg);
  const W = Number(canvas?.width) || 0;
  const H = Number(canvas?.height) || 0;
  const empty = { vertical: [], horizontal: [], colSize: null, rowSize: null };

  if (!(W > 0) || !(H > 0)) return { ...empty, error: ERR_NO_CANVAS };
  if (!cfg.cols.on && !cfg.rows.on && !cfg.margins.on) {
    return { ...empty, error: ERR_EMPTY };
  }

  const m = cfg.margins.on
    ? cfg.margins
    : { top: 0, bottom: 0, left: 0, right: 0 };

  // 边距先自查：左右吃光整个画布时，后面算出来的会是画布外的负坐标，
  // 报错比默默画到画布外几千像素处好
  if (m.left + m.right >= W) return { ...empty, error: ERR_MARGIN_W };
  if (m.top + m.bottom >= H) return { ...empty, error: ERR_MARGIN_H };

  const vertical = [];
  const horizontal = [];

  // 边距本身就是四条参考线（需求 §3）：左、右、上、下
  if (cfg.margins.on) {
    vertical.push(round2(m.left), round2(W - m.right));
    horizontal.push(round2(m.top), round2(H - m.bottom));
  }

  let colSize = null;
  if (cfg.cols.on) {
    const availW = W - m.left - m.right;
    const r = planAxis(cfg.cols, availW, m.left, cfg.cols.center);
    if (!r.lines) return { ...empty, error: ERR_COLS };
    vertical.push(...r.lines);
    colSize = r.size;
  }

  let rowSize = null;
  if (cfg.rows.on) {
    const availH = H - m.top - m.bottom;
    const r = planAxis(cfg.rows, availH, m.top, false);   // 行没有「居中」选项
    if (!r.lines) return { ...empty, error: ERR_ROWS };
    horizontal.push(...r.lines);
    rowSize = r.size;
  }

  return {
    vertical: sortDedupe(vertical),
    horizontal: sortDedupe(horizontal),
    error: null,
    colSize,
    rowSize,
  };
}

/** 升序排好再去重：边距线与首末列边线常常重合，排序后相邻，去重结果才稳定可预期 */
export function sortDedupe(list, existing = [], eps = EPS) {
  return dedupe(list.slice().sort((a, b) => a - b), existing, eps);
}

/**
 * 去重（需求 §32）：丢掉与 existing 或前面已保留项距离小于 eps 的坐标，保持原顺序。
 * @param {number[]} list
 * @param {number[]} [existing] 文档中已有的同方向参考线
 */
export function dedupe(list, existing = [], eps = EPS) {
  const seen = existing.slice();
  const out = [];
  for (const v of list) {
    if (seen.some((s) => Math.abs(s - v) < eps)) continue;
    seen.push(v);
    out.push(v);
  }
  return out;
}

/**
 * 快速参考线（需求 §24）。
 * @param {'cross'|'nine'} kind
 * @param {{width:number, height:number}} canvas
 */
export function quickGuides(kind, canvas) {
  const W = Number(canvas?.width) || 0;
  const H = Number(canvas?.height) || 0;
  const v = [], h = [];
  switch (kind) {
    case 'cross':
      v.push(round2(W / 2));
      h.push(round2(H / 2));
      break;
    case 'nine':
      v.push(round2(W / 3), round2((W * 2) / 3));
      h.push(round2(H / 3), round2((H * 2) / 3));
      break;
    default:
      break;
  }
  return { vertical: sortDedupe(v), horizontal: sortDedupe(h) };
}

// ---- 历史记录 / 收藏 ----

/**
 * 去重键（需求 §10）：只含版面参数。
 * 刻意【不含】画布尺寸、时间戳，以及 clearFirst / margins.link ——
 * 后两者是操作偏好不是版面本身，算进去会让列表里出现两条长得一模一样的记录。
 */
export function signatureOf(cfg) {
  const c = normalizeCfg(cfg);
  return JSON.stringify([
    c.unit,
    c.cols.on ? [c.cols.count, c.cols.size, c.cols.gutter, c.cols.center] : 0,
    c.rows.on ? [c.rows.count, c.rows.size, c.rows.gutter] : 0,
    c.margins.on ? [c.margins.top, c.margins.bottom, c.margins.left, c.margins.right] : 0,
  ]);
}

/**
 * 写入最近使用（需求 §8 / §10）。
 * 签名命中已有记录 → 用新记录顶替它并提到第一位（画布尺寸、时间随之刷新）；
 * 未命中 → 插到第一位并截断到 limit 条。
 * @param {Array} list 现有记录（第一位最新）
 * @param {{cfg:object, canvas:object, at:number}} rec
 */
export function pushRecent(list, rec, limit = 20) {
  const sig = signatureOf(rec.cfg);
  const rest = (list || []).filter((r) => (r.sig || signatureOf(r.cfg)) !== sig);
  return [{ ...rec, sig }].concat(rest).slice(0, limit);
}

/**
 * 「收藏当前版面」时，画布上的参考线可能压根不是一套规则版面（手摆的、拼出来的）。
 * 这种记录按【原坐标】存，文案也另写一套。
 * @param {{vertical:number[],horizontal:number[]}} guides
 * @returns {{title:string, detail:string, name:string}}
 */
export function describeGuides(guides) {
  const v = (guides && guides.vertical) || [];
  const h = (guides && guides.horizontal) || [];
  const t = [];
  if (v.length) t.push(`纵 ${v.length} 条`);
  if (h.length) t.push(`横 ${h.length} 条`);
  const title = t.length ? t.join(' / ') : '空版面';
  return { title, detail: `自定参考线 · 按原坐标重放`, name: `自定版面 ${title}` };
}

/** 一条记录的文案：规则版面看参数，原样快照看坐标 */
export function describeRecord(rec) {
  const r = rec || {};
  if (r.raw && r.guides) return describeGuides(r.guides);
  return describeCfg(r.cfg);
}

/**
 * 生成界面文案。
 * @returns {{title:string, detail:string, name:string}}
 *          title 一行摘要（"4列 / 3行"）、detail 参数细节、name 收藏时的默认名称（§13）
 */
export function describeCfg(cfg) {
  const c = normalizeCfg(cfg);
  const t = [];
  if (c.cols.on) t.push(`${c.cols.count}列`);
  if (c.rows.on) t.push(`${c.rows.count}行`);
  const title = t.length ? t.join(' / ') : '仅边距';

  // 列 / 行 / 边距【三块都写出来】，没设的明写「未设置」——
  // 只列出启用的那几块，看起来就像插件把列漏掉了，分不清「没设」还是「没读到」
  const d = [];
  d.push(c.cols.on
    ? `列 ${c.cols.count} · ${c.cols.size == null ? '宽度自动' : '宽度 ' + fmt(c.cols.size) + 'px'}`
      + ` · 装订线 ${fmt(c.cols.gutter)}px` + (c.cols.center ? ' · 居中' : '')
    : '列 未设置');
  d.push(c.rows.on
    ? `行 ${c.rows.count} · ${c.rows.size == null ? '高度自动' : '高度 ' + fmt(c.rows.size) + 'px'}`
      + ` · 装订线 ${fmt(c.rows.gutter)}px`
    : '行 未设置');
  if (c.margins.on) {
    const { top, bottom, left, right } = c.margins;
    d.push(top === bottom && left === right && top === left
      ? `边距 ${fmt(top)}px`
      : `边距 上${fmt(top)} 下${fmt(bottom)} 左${fmt(left)} 右${fmt(right)}`);
  } else {
    d.push('边距 未设置');
  }

  const gutter = c.cols.on ? c.cols.gutter : (c.rows.on ? c.rows.gutter : 0);
  const name = t.length ? `${t.join('')} - ${fmt(gutter)}px` : '仅边距版面';

  return { title, detail: d.join('；'), name };
}

// ---- 重放一份版面用的 newGuideLayout 描述符 ----
//
// 用途：「最近使用 / 收藏版面」里的【应用】—— 不弹窗，直接让 Photoshop 按这份参数
// 重建一次。用 PS 自己的版面引擎，「宽度自动」会按当前画布重算，跨尺寸复用才准。
//
// 键名以【真机抓到的那份】为准（PS 执行完回传的描述符就是它认的输入形状）：
//   平铺在顶层、不套 guideLayout，列是 colCount / colWidth / colGutter，
//   行是 rowCount / rowHeight / rowGutter，边距 marginTop|Left|Bottom|Right。
//   ⚠️ 列不是与行对称的 columnCount —— 按社区资料写成 columnCount 的那版，
//   记录里的列一直是空的，别再改回去。
//
// 留空的项【整个键都不给】：不给 colCount 就等于「列」没启用，
// 不给 colWidth 就是宽度栏留空（由 PS 自己均分）—— 与「填了才启用」一致。

/**
 * @param {object} rawCfg 版面配置
 * @param {{nested?:boolean, full?:boolean}} [opts]
 *        nested=true 时参数套在 guideLayout 子对象里（老版本录制里的形状，作兜底）；
 *        full=true 时【每个键都写满】，没启用的写 0 —— 预填弹窗要用这种：
 *        少给一个键，Photoshop 就拿出厂默认（装订线 20 像素 / 数量 2 / 边距 20 像素）
 *        把它补上，「上次没设边距」下次打开就变成边距 20 了。0 在弹窗里显示为空。
 * @returns {object} batchPlay 描述符（不含 _options，是否弹窗由调用方决定）
 */
export function guideLayoutDescriptor(rawCfg, opts = {}) {
  const c = normalizeCfg(rawCfg);
  const px = (v) => ({ _unit: 'pixelsUnit', _value: round2(v) });
  const full = !!opts.full;
  const layout = {};

  if (c.cols.on || full) {
    layout.colCount = c.cols.on ? c.cols.count : 0;
    if (c.cols.size != null) layout.colWidth = px(c.cols.size);
    else if (full) layout.colWidth = px(0);              // 0 = 宽度栏留空 = 自动
    layout.colGutter = px(c.cols.on ? c.cols.gutter : 0);
  }
  if (c.rows.on || full) {
    layout.rowCount = c.rows.on ? c.rows.count : 0;
    if (c.rows.size != null) layout.rowHeight = px(c.rows.size);
    else if (full) layout.rowHeight = px(0);
    layout.rowGutter = px(c.rows.on ? c.rows.gutter : 0);
  }
  // 四边全是 0 时一个键都不给：否则「边距」会被当成启用，还多出四条 0 边距线。
  // full 模式例外——预填时必须把 0 明写出来，不然 PS 会用它的默认边距顶上
  if (c.margins.on || full) {
    layout.marginTop = px(c.margins.top);
    layout.marginLeft = px(c.margins.left);
    layout.marginBottom = px(c.margins.bottom);
    layout.marginRight = px(c.margins.right);
  }
  layout.centerColumns = !!c.cols.center;
  layout.clearExistingGuides = !!c.clearFirst;

  const desc = {
    _obj: 'newGuideLayout',
    guideTarget: { _enum: 'guideTarget', _value: 'guideTargetCanvas' },
  };
  if (opts.nested) {
    desc.presetKind = { _enum: 'presetKindType', _value: 'presetKindCustom' };
    desc.guideLayout = Object.assign({ _obj: 'guideLayout' }, layout);
    return desc;
  }
  return Object.assign(desc, layout);
}

/**
 * 两批参考线是不是一模一样（用来判断「原生弹窗被取消了 = 文档没变化」）。
 * @param {{vertical:number[], horizontal:number[]}} a
 * @param {{vertical:number[], horizontal:number[]}} b
 */
export function sameGuides(a, b, eps = EPS) {
  const cmp = (x = [], y = []) => {
    const p = sortDedupe(x, [], eps);
    const q = sortDedupe(y, [], eps);
    return p.length === q.length && p.every((v, i) => Math.abs(v - q[i]) <= eps);
  };
  return cmp(a && a.vertical, b && b.vertical) && cmp(a && a.horizontal, b && b.horizontal);
}

// ---- 反向：把 Photoshop 执行的 newGuideLayout 描述符读回成本插件的配置 ----
//
// 用途：版面由原生弹窗创建，插件通过 action 通知拿到 PS 真正执行的那份描述符，
// 于是记录里存的就是用户在弹窗里【实际填的】参数，之后「应用」能原样重放。
//
// 单位：弹窗里可以按像素 / 百分比 / 厘米等填写，描述符里带着 _unit。
// 本插件内部一律用 px，所以这里统一折算。百分比要知道该轴的画布尺寸，
// 物理单位要知道分辨率（ppi），两者都由调用方提供，缺了就按 px 处理。

const IN_PER = { distanceUnit: 1, inchesUnit: 1, millimetersUnit: 1 / 25.4, pointsUnit: 1 / 72, picasUnit: 1 / 6, centimetersUnit: 1 / 2.54 };

/**
 * 描述符里的一个数值折算成 px。
 * @param {any} u 数字，或 {_unit, _value}
 * @param {number} axis 该轴的画布尺寸（px），百分比要用
 * @param {number} [res=72] 文档分辨率（ppi），物理单位要用
 */
export function unitToPx(u, axis = 0, res = 72) {
  if (u == null) return null;
  if (typeof u === 'number') return round2(u);
  const v = Number(u._value);
  if (!Number.isFinite(v)) return null;
  const unit = String(u._unit || 'pixelsUnit');
  if (unit === 'percentUnit') return round2((v / 100) * axis);
  const inch = IN_PER[unit];
  if (inch) return round2(v * inch * (res > 0 ? res : 72));
  return round2(v);                                  // pixelsUnit 及未知单位：原样当 px
}

/**
 * @param {object} desc PS 执行的 newGuideLayout 描述符（参数可嵌在 guideLayout 里，也可平铺）
 * @param {{width:number, height:number}} [canvas] 画布尺寸，百分比折算用
 * @param {number} [res] 文档分辨率
 * @returns {object|null} 本插件的配置；描述符里一项参数都没有则返回 null
 */
export function cfgFromGuideLayout(desc, canvas, res) {
  const g = guideLayoutParams(desc);
  if (!g) return null;
  const W = canvas && canvas.width > 0 ? canvas.width : 0;
  const H = canvas && canvas.height > 0 ? canvas.height : 0;
  const num = (v) => {
    const n = typeof v === 'object' && v !== null ? Number(v._value) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  // 按别名依次找一个键；找到就返回 [键名, 值]，都没有则 [null, undefined]。
  // 值是「没有 _value 的对象」时跳过：那是别的形状（比如 columns 是个子描述符），
  // 当数字读只会读出 0，还不如让后面的别名有机会命中
  const usable = (v) => !(v !== null && typeof v === 'object' && !('_value' in v));
  const pick = (names) => {
    for (const k of names) if (k in g && usable(g[k])) return [k, g[k]];
    return [null, undefined];
  };
  const [, cCount] = pick(GL_KEYS.columnCount);
  const [cwKey, cWidth] = pick(GL_KEYS.columnWidth);
  const [, cGutter] = pick(GL_KEYS.columnGutter);
  const [, rCount] = pick(GL_KEYS.rowCount);
  const [rhKey, rHeight] = pick(GL_KEYS.rowHeight);
  const [, rGutter] = pick(GL_KEYS.rowGutter);
  const [, center] = pick(GL_KEYS.centerColumns);
  const [, clear] = pick(GL_KEYS.clearExistingGuides);

  const colCount = Math.max(0, Math.round(num(cCount)));
  const rowCount = Math.max(0, Math.round(num(rCount)));
  const margins = {
    top: unitToPx(pick(GL_KEYS.marginTop)[1], H, res) || 0,
    left: unitToPx(pick(GL_KEYS.marginLeft)[1], W, res) || 0,
    bottom: unitToPx(pick(GL_KEYS.marginBottom)[1], H, res) || 0,
    right: unitToPx(pick(GL_KEYS.marginRight)[1], W, res) || 0,
  };
  const anyMargin = margins.top || margins.left || margins.bottom || margins.right;
  if (!colCount && !rowCount && !anyMargin) return null;   // 什么都没有：不值得记一条

  return normalizeCfg({
    unit: 'px',
    cols: {
      count: colCount,
      size: cwKey ? unitToPx(cWidth, W, res) : null,       // 键不出现 = 宽度栏留空 = 自动
      gutter: unitToPx(cGutter, W, res) || 0,
      center: !!(center && center._value !== false),
    },
    rows: {
      count: rowCount,
      size: rhKey ? unitToPx(rHeight, H, res) : null,
      gutter: unitToPx(rGutter, H, res) || 0,
    },
    margins,
    clearFirst: clear !== false,
  });
}

// 键名别名表：不同 Photoshop 版本 / 不同回传路径（batchPlay 返回值 vs 动作通知）
// 用的键名不一定完全一样。列的键要是没认出来，记录里就会只剩行 —— 宁可多列几个候选。
const GL_KEYS = {
  // ⚠️ 列用的是 colCount / colWidth / colGutter（真机验证过）——不是与行对称的
  // columnCount。按 ScriptListener 资料写成 columnCount 的那版，列一直记不进去。
  columnCount: ['colCount', 'columnCount', 'columnsCount', 'numberOfColumns', 'columnNumber'],
  columnWidth: ['colWidth', 'columnWidth', 'columnsWidth'],
  columnGutter: ['colGutter', 'columnGutter', 'columnsGutter', 'gutter'],
  rowCount: ['rowCount', 'rowsCount', 'numberOfRows', 'rowNumber'],
  rowHeight: ['rowHeight', 'rowsHeight'],
  rowGutter: ['rowGutter', 'rowsGutter'],
  marginTop: ['marginTop', 'top'],
  marginLeft: ['marginLeft', 'left'],
  marginBottom: ['marginBottom', 'bottom'],
  marginRight: ['marginRight', 'right'],
  centerColumns: ['centerColumns', 'columnCenter', 'colCenter'],
  clearExistingGuides: ['clearExistingGuides', 'clearGuides', 'replace'],
};

/** 与版面无关、不必认识的键：参考线颜色（$GdCA/$GdCR/$GdCG/$GdCB）与几个元字段 */
const GL_NOISE = ['presetKind', 'guideTarget', 'guideLayoutTarget', 'using', 'documentID'];
const isNoiseKey = (k) => k.indexOf('$Gd') === 0 || GL_NOISE.indexOf(k) >= 0;

/** 参数所在的那层对象（可能嵌在 guideLayout 里，也可能平铺在顶层）。不是描述符则 null */
function guideLayoutParams(desc) {
  if (!desc || typeof desc !== 'object') return null;
  return desc.guideLayout && typeof desc.guideLayout === 'object' ? desc.guideLayout : desc;
}

/**
 * 把描述符里的参数原样摊成一行，给用户看的「Photoshop 到底回传了什么」。
 * 记录里带着它：万一某次创建的列 / 行没进记录，看这一行就知道是「本来就没设」
 * 还是「键名对不上」，不用再靠猜。
 * @returns {string} 形如 "columnCount=0 · columnGutter=0px · rowCount=5"
 */
export function formatGuideLayoutParams(desc, keys) {
  const g = guideLayoutParams(desc);
  if (!g) return '';
  const one = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? '是' : '否';
    if (typeof v === 'number') return fmt(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      if ('_value' in v) {
        const u = String(v._unit || '').replace(/Unit$/, '');
        const n = typeof v._value === 'number' ? fmt(v._value) : String(v._value);
        return u === 'pixels' ? `${n}px` : (u ? `${n}${u}` : n);
      }
      if (v._enum) return String(v._value ?? '');
      return '{…}';
    }
    return String(v);
  };
  return (keys || guideLayoutKeys(desc)).map((k) => `${k}=${one(g[k])}`).join(' · ');
}

/**
 * 描述符里【插件不认识】的参数键。列 / 行没进记录时，这里要是有东西，
 * 就说明这个 Photoshop 版本的键名和别名表对不上 —— 照着补进 GL_KEYS 即可。
 * @returns {string[]}
 */
export function unknownGuideLayoutKeys(desc) {
  const known = new Set();
  for (const names of Object.values(GL_KEYS)) for (const k of names) known.add(k);
  return guideLayoutKeys(desc).filter((k) => !known.has(k) && !isNoiseKey(k));
}

/**
 * 描述符里的参数键名列表（去掉 _obj 之类的元字段）。
 * 只用于「读不出参数」时把 PS 到底回传了什么如实告诉用户 —— 键名对不上时，
 * 这行提示就是唯一能定位问题的线索。
 * @returns {string[]}
 */
export function guideLayoutKeys(desc) {
  const g = guideLayoutParams(desc);
  if (!g) return [];
  return Object.keys(g).filter((k) => k[0] !== '_' && k !== 'null');
}

// ---- 反推：只看文档里多出来的参考线，把版面参数算回来 ----
//
// 为什么需要这条路：弹窗走的是菜单项（这样 PS 才会带出「上次设置」），
// 而菜单项那条路 batchPlay 不回传执行参数，newGuideLayout 的动作通知也不是每个版本都发。
// 于是最可靠的来源反而是【文档本身】：对比弹窗前后的参考线，多出来的那批就是这一版版面。
// 纯几何、可单测；认不出来就返回 null，绝不编一条假记录。

/** 相邻两条之间的间距 */
function diffsOf(v) {
  const d = [];
  for (let i = 1; i < v.length; i++) d.push(round2(v[i] - v[i - 1]));
  return d;
}

/**
 * 交替形状：宽 装订线 宽 装订线 … 宽（N 列 = 2N 条线）
 * @returns {{count:number, cell:number, gutter:number}|null}
 */
function readAlternating(v, eps) {
  if (v.length < 4 || v.length % 2 !== 0) return null;
  const d = diffsOf(v);
  const cell = d[0];
  const gutter = d[1];
  if (cell <= eps || gutter <= eps) return null;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i] - (i % 2 ? gutter : cell)) > eps) return null;
  }
  return { count: v.length / 2, cell, gutter };
}

/** 等分形状：装订线为 0，相邻两列共用一条线（N 列 = N+1 条线） */
function readUniform(v, eps) {
  if (v.length < 3) return null;
  const d = diffsOf(v);
  const cell = d[0];
  if (cell <= eps) return null;
  if (!d.every((x) => Math.abs(x - cell) <= eps)) return null;
  return { count: v.length - 1, cell, gutter: 0 };
}

/**
 * 反推一个方向（列或行）。
 * @param {number[]} list 该方向上新增的参考线坐标
 * @param {number} size   画布该方向的尺寸
 * @returns {{block:object, m0:number, m1:number}|null} m0/m1 = 靠前 / 靠后那一侧的边距
 */
export function inferAxis(list, size, eps = EPS) {
  const v = sortDedupe(list || [], [], eps);
  if (!v.length) return { block: { count: 0, size: null, gutter: 0 }, m0: 0, m1: 0 };

  const m0 = round2(Math.max(0, v[0]));
  const m1 = round2(Math.max(0, size - v[v.length - 1]));
  const avail = round2(size - m0 - m1);

  // 边距线可能自成两条（固定宽 + 居中时列不贴边），先按原样试，再去掉首尾试
  const shapes = [readAlternating(v, eps), readUniform(v, eps)];
  let inner = null;
  if (v.length >= 6) {
    const mid = v.slice(1, -1);
    inner = readAlternating(mid, eps) || readUniform(mid, eps);
  }
  const hit = shapes.find(Boolean) || inner;
  if (!hit) {
    // 只有两条 = 光设了边距，没有列 / 行；再多就认不出来了
    if (v.length === 2) return { block: { count: 0, size: null, gutter: 0 }, m0, m1 };
    return null;
  }

  const total = round2(hit.count * hit.cell + (hit.count - 1) * hit.gutter);
  const auto = Math.abs(total - avail) <= eps + 0.5;     // 占满可用宽度 = 弹窗里「宽度自动」
  const start = hit === inner ? v[1] : v[0];
  return {
    block: {
      count: hit.count,
      size: auto ? null : hit.cell,
      gutter: hit.gutter,
      // 固定宽且左右还留了同样的空 = 勾了「列居中」
      center: !auto && Math.abs((start - m0) - (avail - total) / 2) <= eps + 0.5,
    },
    m0,
    m1,
  };
}

/**
 * 对比弹窗前后的参考线，反推出这一版版面的配置。
 * @param {{vertical:number[],horizontal:number[]}} before 弹窗前文档里的参考线
 * @param {{vertical:number[],horizontal:number[]}} after  弹窗后文档里的参考线
 * @param {{width:number,height:number}} canvas
 * @returns {object|null} 认不出来就 null（宁可不记，也不记错）
 */
export function inferCfgFromGuides(before, after, canvas, eps = EPS) {
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) return null;
  const b = { vertical: (before && before.vertical) || [], horizontal: (before && before.horizontal) || [] };
  const a = { vertical: (after && after.vertical) || [], horizontal: (after && after.horizontal) || [] };
  if (!a.vertical.length && !a.horizontal.length) return null;

  // 旧的还在不在 → 弹窗里「清除现有的参考线」勾没勾
  const kept = (old, now) => old.every((x) => now.some((y) => Math.abs(x - y) <= eps));
  const clearFirst = !(kept(b.vertical, a.vertical) && kept(b.horizontal, a.horizontal));

  // 追加模式下，只有【新增的】那批才是这一版版面；认不出来时退回看全部
  const addedV = a.vertical.filter((x) => !b.vertical.some((y) => Math.abs(x - y) <= eps));
  const addedH = a.horizontal.filter((x) => !b.horizontal.some((y) => Math.abs(x - y) <= eps));
  const sets = clearFirst
    ? [[a.vertical, a.horizontal]]
    : [[addedV, addedH], [a.vertical, a.horizontal]];

  for (const [vs, hs] of sets) {
    const col = inferAxis(vs, canvas.width, eps);
    const row = inferAxis(hs, canvas.height, eps);
    if (!col || !row) continue;
    if (!col.block.count && !row.block.count && !vs.length && !hs.length) continue;
    return normalizeCfg({
      cols: col.block,
      rows: row.block,
      margins: { left: col.m0, right: col.m1, top: row.m0, bottom: row.m1 },
      clearFirst,
    });
  }
  return null;
}
