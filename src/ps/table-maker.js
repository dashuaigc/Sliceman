// PS API 封装：快速绘制表格 —— 把纯几何算出的路径组件建成矢量形状图层。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
// ⚠️ 本文件是全项目风险最高的一处：前面几个功能都在操作【已有】图层，这里是【凭空构造矢量路径】，
//    描述符结构复杂且各 PS 版本有差异。几何计算已全部前置到 src/lib/table-core.js（36 个单测），
//    这里只做「几何 → 描述符」的翻译，出问题基本都在描述符字段名上。
//
// 建形状图层的两步法（ScriptListener 录制「钢笔画形状」得到的同款流程）：
//   1) 把路径写进【工作路径】：set path.workPath ← pathComponents 列表
//   2) 由当前工作路径建纯色形状图层：make contentLayer + solidColorLayer
//   最后删掉工作路径，避免在「路径」面板留下残留。
//
// 为什么不用 PS 的描边（Stroke）画表格线：描边居中对齐会产生半像素，交叉点还会互相叠加。
//   改成把每条线做成细矩形子路径（几何层已完成），线宽永远是准确的整数像素。见需求 §10.2。
//
// 单步撤销：整个绘制（含建组、改名）包在 doc.suspendHistory 里，Ctrl+Z 一次撤销。

const { app, action, core } = require('photoshop');

import { viewCenterFromDescriptors, dnum } from '../lib/view-core.js';
import { componentsBBox, bboxMatches } from '../lib/table-core.js';

const dontDisplay = { dialogOptions: 'dontDisplay' };
const px = (v) => ({ _unit: 'pixelsUnit', _value: v });

/** #rrggbb / rrggbb → {r,g,b}；解析不了则返回 null */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** {r,g,b} → #rrggbb */
export function rgbToHex({ r, g, b }) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 读 PS 当前前景色，返回 #rrggbb；读不到返回 null */
export function readForegroundHex() {
  try {
    const c = app.foregroundColor.rgb;
    return rgbToHex({ r: c.red, g: c.green, b: c.blue });
  } catch { return null; }
}

// ---- 当前视图中心 ----
// PS 没有「取可见区域」的现成 API，只能拼两个描述符再做逆变换：
//   viewTransform（文档→屏幕的仿射矩阵）+ documentArea（画布窗口在屏幕上的矩形）。
// 两者在不同版本里的键名/形状不完全一致，解析和求逆全在 lib/view-core.js（有单测），
// 这里只负责把描述符取回来。任何一步失败都返回 null，调用方退回画布中心。

const getProp = (property, ref) => ({
  _obj: 'get',
  _target: { _ref: [{ _property: property }, ref] },
  _options: dontDisplay,
});
const TARGET_DOC = { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' };
const TARGET_APP = { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' };

async function getOne(descriptor, key) {
  try {
    const res = await action.batchPlay([descriptor], {});
    const d = Array.isArray(res) ? res[0] : res;
    if (!d) return null;
    return d[key] !== undefined ? d[key] : d;
  } catch { return null; }
}

/**
 * 当前画布窗口可见区域的中心，文档坐标。取不到返回 null。
 * @returns {Promise<{x:number,y:number}|null>}
 */
export async function readViewCenter() {
  const [tf, area] = await Promise.all([
    getOne(getProp('viewTransform', TARGET_DOC), 'viewTransform'),
    getOne(getProp('documentArea', TARGET_APP), 'documentArea'),
  ]);
  return viewCenterFromDescriptors(tf, area);
}

// ---- 原生拾色器 ----
// UXP 的 photoshop.app 上没有 showColorPicker（那是 ExtendScript 时代的 API），
// HTML 的 <input type="color"> 在 UXP 里也不可用。唯一能调起 Adobe 拾色器的路子是
// batchPlay 发 showColorPicker 描述符，且必须包在 executeAsModal 里（会弹模态对话框）。

// 返回结构各版本不完全一致，已知会出现 RGBFloatColor / RGBColor / color 三种壳；
// 绿色分量在描述符里叫 grain，但不排除某些返回里就叫 green，两个键都认。
function extractPickedHex(res) {
  const d = Array.isArray(res) ? res[0] : res;
  if (!d) return null;
  const c = d.RGBFloatColor || d.RGBColor || d.rgbColor || d.color;
  if (!c) return null;                              // 取消时没有颜色字段
  const r = dnum(c.red);
  const g = dnum(c.grain !== undefined ? c.grain : c.green);
  const b = dnum(c.blue);
  if (![r, g, b].every(Number.isFinite)) return null;
  return rgbToHex({ r, g, b });
}

/**
 * 弹出 Photoshop 原生拾色器。
 * @param {string} seedHex 打开时的初始颜色 #rrggbb
 * @returns {Promise<string|null>} 选定的 #rrggbb；用户取消或调不起来返回 null
 */
export async function pickColor(seedHex) {
  const seed = hexToRgb(seedHex) || { r: 0, g: 0, b: 0 };
  let res = null;
  const run = async () => {
    res = await action.batchPlay([{
      _obj: 'showColorPicker',
      application: { _class: 'null' },
      value: true,
      // 用当前色做初始值，点开时停在原来的颜色上而不是黑色
      color: { _obj: 'RGBColor', red: seed.r, grain: seed.g, blue: seed.b },
      _options: { dialogOptions: 'display' },       // 不显式要求显示，对话框可能被跳过
    }], {});
  };
  try {
    await core.executeAsModal(run, { commandName: '选择颜色' });
  } catch {
    return null;                                    // 取消会以异常形式回来；进不了模态也走这里
  }
  return extractPickedHex(res);
}

// ---- 描述符构造 ----

const paint = ([x, y]) => ({ _obj: 'paint', horizontal: px(x), vertical: px(y) });

/** 几何层的一个点 → pathPoint 描述符 */
const pathPoint = (p) => ({
  _obj: 'pathPoint',
  anchor: paint(p.anchor),
  forward: paint(p.forward),
  backward: paint(p.backward),
  smooth: false,
});

/** 几何层的一个组件（一条闭合子路径 + 布尔运算）→ pathComponent 描述符 */
const pathComponent = (c) => ({
  _obj: 'pathComponent',
  shapeOperation: { _enum: 'shapeOperation', _value: c.op === 'subtract' ? 'subtract' : 'add' },
  subpathListKey: [{
    _obj: 'subpathsList',
    closedSubpath: true,
    points: c.points.map(pathPoint),
  }],
});

/** 路径内容描述符（官方类型定义里的 PathContentsDescriptor，类名固定是 pathClass） */
const pathContents = (components) => ({
  _obj: 'pathClass',
  pathComponents: components.map(pathComponent),
});

// 把路径写进工作路径（备用方案用）
const setWorkPath = (components) => ({
  _obj: 'set',
  _target: [{ _ref: 'path', _property: 'workPath' }],
  to: pathContents(components),
  _options: dontDisplay,
});

/**
 * 建纯色形状图层。
 * components 非空时把路径【直接写进 make 描述符】，一次调用建好，不依赖工作路径；
 * 传 null 则由当前工作路径来建（备用方案）。
 */
const makeShapeLayer = (rgb, components) => {
  const using = {
    _obj: 'contentLayer',
    type: {
      _obj: 'solidColorLayer',
      // ⚠️ PS 的 RGBColor 里绿色分量键名就叫 grain，不是 green
      color: { _obj: 'RGBColor', red: rgb.r, grain: rgb.g, blue: rgb.b },
    },
  };
  if (components) using.shape = pathContents(components);
  return { _obj: 'make', _target: [{ _ref: 'contentLayer' }], using, _options: dontDisplay };
};

const deleteLayer = (id) => ({
  _obj: 'delete', _target: [{ _ref: 'layer', _id: id }], _options: dontDisplay,
});

// ---- 实时形状矩形（独立单元格模式用）----
// 用 _obj:'rectangle' 而不是路径来建形状层，PS 会给它挂上 keyOriginType 元数据，
// 于是属性面板里能直接改 W/H/X/Y、四角圆角、描边宽度与颜色——就是矩形工具画出来的那种。
// 路径形状层没有这些，只能进节点编辑，改起来费劲。

const rgbDesc = (rgb) => ({ _obj: 'RGBColor', red: rgb.r, grain: rgb.g, blue: rgb.b });

/**
 * 描边样式。
 * 对齐方式固定为【内侧】：描边完全落在矩形内，图层外接框正好等于单元格尺寸，
 * 相邻单元格不会因为描边外扩而互相压盖——这也让下面的外接框校验能真正生效。
 * 线宽用 pixelsUnit——真机 dump 里 PS 自己就是这么记的（不是类型定义暗示的 pointsUnit）。
 */
const strokeStyleDesc = (spec, lineRgb) => ({
  _obj: 'strokeStyle',
  strokeStyleVersion: 2,
  strokeEnabled: !!spec.stroke,
  fillEnabled: !!spec.fill,
  strokeStyleLineWidth: px(spec.lineWidth || 0),
  strokeStyleLineDashOffset: { _unit: 'pointsUnit', _value: 0 },
  strokeStyleMiterLimit: 100,
  strokeStyleLineCapType: { _enum: 'strokeStyleLineCapType', _value: 'strokeStyleButtCap' },
  strokeStyleLineJoinType: { _enum: 'strokeStyleLineJoinType', _value: 'strokeStyleMiterJoin' },
  strokeStyleLineAlignment: { _enum: 'strokeStyleLineAlignment', _value: 'strokeStyleAlignInside' },
  strokeStyleScaleLock: false,
  strokeStyleStrokeAdjust: false,
  strokeStyleLineDashSet: [],
  strokeStyleBlendMode: { _enum: 'blendMode', _value: 'normal' },
  strokeStyleOpacity: { _unit: 'percentUnit', _value: 100 },
  strokeStyleContent: { _obj: 'solidColorLayer', color: rgbDesc(lineRgb) },
  strokeStyleResolution: 72,
});

// ---- 实时形状元数据 ----
// 光有 _obj:'rectangle' 的几何，未必能让 PS 认它是「实时形状」——属性面板里那些
// W/H/X/Y、四角圆角字段是由图层上的 keyOriginType【列表】驱动的：
//   keyOriginType(1=矩形 2=圆角矩形) + keyOriginRRectRadii(四角半径)
//   + keyOriginShapeBBox(几何范围) + keyOriginResolution + keyOriginBoxCorners + transform
// 用矩形工具手画时 PS 自己生成这份元数据；脚本建的形状层则不一定有，得自己补。
//
// ⚠️ 先读后写：PS 已经生成了就别动它——写一份不对的进去，反而会把本来好用的实时形状弄坏。

const KEY_ORIGIN_RECT = 1;
const KEY_ORIGIN_ROUNDED = 2;
// keyOrigin* 这组键【对脚本只读】：真机实测四种写法（建层时带、set 整层带类名、
// set 指向属性、set 整层不带类名）全部失败，写进去的六个子键被 PS 悉数丢弃，
// 只有 keyActionMode 存活。所以不再尝试事后补写——想要实时形状，只能让 PS 用它
// 自己的 rectangle 几何来建层（见 nativeRectShape）。这里只保留读取与判定。

/** 读图层的实时形状元数据首项；不是实时形状则返回 null */
async function readLiveShapeMeta(id) {
  const d = await getOne(getProp('keyOriginType', { _ref: 'layer', _id: id }), 'keyOriginType');
  const first = Array.isArray(d) ? d[0] : d;
  return first || null;
}

/**
 * 元数据到底写进去没有：类型对得上，且有圆角时半径也对得上。
 * 上一轮的教训——只有 keyActionMode 活下来也会被读成「有元数据」，必须核到具体字段。
 */
function metaLooksApplied(meta, radius) {
  if (!meta) return false;
  const t = dnum(meta.keyOriginType);
  const want = radius > 0 ? KEY_ORIGIN_ROUNDED : KEY_ORIGIN_RECT;
  if (t !== want) return false;
  if (radius > 0) {
    const got = dnum(meta.keyOriginRRectRadii?.topLeft);
    if (!Number.isFinite(got) || Math.abs(got - radius) > 0.51) return false;
  }
  return true;
}

/**
 * @param {'native'|'path'} geom native=PS 自己的矩形几何（能成实时形状）；
 *                               path=我们自己算的圆角贝塞尔路径（圆角一定对）
 */
const makeRectLayer = (spec, lineRgb, fillRgb, geom) => {
  const using = {
    _obj: 'contentLayer',
    // 填充色即使关了填充也要给——fillEnabled 决定画不画，颜色只是备着
    type: { _obj: 'solidColorLayer', color: rgbDesc(fillRgb) },
    shape: geom === 'native' ? nativeRectShape(spec.rect, spec.radius) : pathContents(spec.solid),
    strokeStyle: strokeStyleDesc(spec, lineRgb),
  };
  return { _obj: 'make', _target: [{ _ref: 'contentLayer' }], using, _options: dontDisplay };
};

/**
 * PS 原生矩形几何。只有它能让 PS 把图层认成「实时形状」（属性面板可改圆角）——
 * keyOrigin* 那组元数据实测对脚本只读，事后 set 进不去，只能靠 PS 自己在建层时生成。
 *
 * ⚠️ 写成最简形式：只给四条边和四角半径。上一版还塞了 width/height 和
 *    unitValueQuadVersion，PS 疑似因此走了「普通矩形」的分支，把圆角吞了。
 */
const nativeRectShape = (rect, radius) => {
  const d = {
    _obj: 'rectangle',
    top: px(rect.top), left: px(rect.left), bottom: px(rect.bottom), right: px(rect.right),
  };
  if (radius > 0) {
    const rr = px(radius);
    Object.assign(d, { topLeft: rr, topRight: rr, bottomLeft: rr, bottomRight: rr });
  }
  return d;
};

/**
 * 读当前目标路径首条子路径的锚点数。
 * 圆角矩形 8 个点、直角矩形 4 个点——用来确认 PS 真的按圆角画了，
 * 而不是「元数据说是圆角、画出来却是直角」。读不到返回 null。
 */
async function readPathPointCount() {
  const d = await getOne({
    _obj: 'get',
    _target: { _ref: [{ _property: 'pathContents' }, { _ref: 'path', _enum: 'ordinal', _value: 'targetEnum' }] },
    _options: dontDisplay,
  }, 'pathContents');
  const pts = d?.pathComponents?.[0]?.subpathListKey?.[0]?.points;
  return Array.isArray(pts) ? pts.length : null;
}

/** 读回描边样式，确认 PS 真的按我们说的画了（描边/填充开关、线宽） */
async function readStrokeInfo(id) {
  const d = await getOne(getProp('AGMStrokeStyleInfo', { _ref: 'layer', _id: id }), 'AGMStrokeStyleInfo');
  if (!d) return null;
  return {
    stroke: !!d.strokeEnabled,
    fill: !!d.fillEnabled,
    width: dnum(d.strokeStyleLineWidth),
  };
}

const deleteWorkPath = () => ({
  _obj: 'delete', _target: [{ _ref: 'path', _property: 'workPath' }], _options: dontDisplay,
});

const setName = (id, name) => ({
  _obj: 'set', _target: [{ _ref: 'layer', _id: id }], to: { _obj: 'layer', name }, _options: dontDisplay,
});

const selectOne = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false, _options: dontDisplay,
});
const addToSel = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false,
  selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
  _options: dontDisplay,
});
const makeGroup = (name) => ({
  _obj: 'make', _target: [{ _ref: 'layerSection' }],
  from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
  using: { _obj: 'layerSection', name },
  _options: dontDisplay,
});

// batchPlay 不总是 reject —— 有时把错误塞进结果描述符里返回，静默走过去。
// 所有会改文档的调用都走这里，把那种「假成功」揪出来。
async function bp(descriptors) {
  const res = await action.batchPlay(descriptors, {});
  const list = Array.isArray(res) ? res : [res];
  const bad = list.find((d) => d && (d._obj === 'error' || typeof d.message === 'string'));
  if (bad) throw new Error(bad.message || 'batchPlay 返回了错误描述符');
  return res;
}

/** 当前选中的最后一个图层（刚建出来的那个） */
function newestSelected() {
  const sel = Array.from(app.activeDocument.activeLayers || []);
  return sel.length ? sel[sel.length - 1] : null;
}

/** 读图层外接矩形；读不到返回 null */
function layerBBox(layer) {
  try {
    const b = layer.bounds;
    const r = {
      left: dnum(b.left), top: dnum(b.top), right: dnum(b.right), bottom: dnum(b.bottom),
    };
    return Object.values(r).every(Number.isFinite) ? r : null;
  } catch { return null; }
}

// 建形状层的几条路子，按顺序试；哪条真跑通就记下来，后续图层直接用。
//
// path —— 几何用我们自己算的圆角贝塞尔路径（roundRectPoints，单测盯着，单一形状模式
//   一直用它、圆角一直是对的）；边框交给 PS 的描边样式；实时形状元数据事后照真机 dump
//   的结构补上。三者都由我们说了算，不指望 PS 推断。
//
//   ⚠️ 这里【不】用 PS 自己的 _obj:'rectangle' 几何。实测它会忽略四角半径画成直角，
//      偏偏又把 keyOriginType 记成「圆角矩形」——属性面板说是圆角、画面却是直角，
//      靠读回元数据根本分辨不出来。既然自己的路径几何是准的，就没有用它的理由。
//
// inline / workPath —— 后备，纯路径描边环，不依赖描边样式也不依赖元数据。
//   workPath 那条「由工作路径建形状」在脚本回放时有已知 bug（会建出空形状层），故排最后。
const RECT_STRATEGIES = [
  {
    // PS 原生矩形几何：唯一能拿到「实时形状」的路子（属性面板可改圆角/W/H）。
    // 但它有把圆角画成直角的前科，所以验收极严——元数据和真实锚点数都得对上，
    // 有一项验不过（含读不到）就删层退到下面的 path，宁可不可编辑也不能画错。
    name: 'native',
    rectLayer: true,
    requireLiveShape: true,
    run: (spec, l, f) => bp([makeRectLayer(spec, l, f, 'native')]),
  },
  {
    // 自己算的圆角贝塞尔路径：几何一定对，就是属性面板改不了圆角
    name: 'path',
    rectLayer: true,
    run: (spec, l, f) => bp([makeRectLayer(spec, l, f, 'path')]),
  },
];

const PATH_STRATEGIES = [
  {
    name: 'inline',
    run: (spec, lineRgb, fillRgb) => bp([
      makeShapeLayer(spec.role === 'fill' ? fillRgb : lineRgb, spec.components),
    ]),
  },
  {
    name: 'workPath',
    run: async (spec, lineRgb, fillRgb) => {
      await bp([setWorkPath(spec.components)]);
      await bp([makeShapeLayer(spec.role === 'fill' ? fillRgb : lineRgb, null)]);
      try { await bp([deleteWorkPath()]); } catch { /* 残留工作路径不影响结果 */ }
    },
  },
];

// 两类图层各记各的：矩形走通了不代表路径也走得通，反之亦然
const shapeStrategy = { rect: null, path: null };

let liveShapeType = null;                        // 首格探到的实时形状类型，供状态栏回报

/**
 * 在第一个矩形上判定这条策略到底成不成，并决定后续格子要不要补元数据。
 *
 * 唯一的硬关卡是描边样式：必须真的按我们说的设上了（描边/填充开关、线宽）。
 * 这条尤其重要——填充关不掉的话，本该空心的格子会变成实心色块，比不圆角严重得多。
 * 关卡没过就退到老的描边环写法（不依赖描边样式，一定空心）。
 *
 * 圆角不在这里校验：几何是自己算的路径，画出来必对。元数据（keyOriginType）补不上
 * 也只是属性面板不可编辑，不影响画面，所以尽力而为、失败只记日志。
 *
 * @returns {Promise<number|null>} 实时形状类型：1=矩形 2=圆角矩形 null=不是实时形状
 * @throws 关卡没过时抛出，由调用方换下一条策略
 */
async function probeRectLayer(layer, spec, strat) {
  const si = await readStrokeInfo(layer.id);
  if (si) {
    if (si.stroke !== !!spec.stroke || si.fill !== !!spec.fill) {
      throw new Error(
        `${strat.name}：描边/填充开关没设上（期望 描边${spec.stroke}/填充${spec.fill}，`
        + `实得 描边${si.stroke}/填充${si.fill}）`,
      );
    }
    if (spec.stroke && Math.abs(si.width - spec.lineWidth) > 0.51) {
      throw new Error(`${strat.name}：线宽不对（期望 ${spec.lineWidth}，实得 ${si.width}）`);
    }
  }

  const meta = await readLiveShapeMeta(layer.id);
  const isLive = metaLooksApplied(meta, spec.radius);

  if (strat.requireLiveShape) {
    if (!isLive) {
      throw new Error(
        `${strat.name}：PS 没把它建成实时形状（读回 ${JSON.stringify(meta)}）`,
      );
    }
    // 元数据说是圆角还不够——必须确认路径真的是圆角。圆角矩形 8 个锚点、直角 4 个。
    // 读不到锚点数也算验不过：宁可退到 path（画面一定对），也不冒画成直角的险。
    if (spec.radius > 0) {
      const n = await readPathPointCount();
      if (n !== 8) {
        throw new Error(`${strat.name}：元数据说是圆角，但路径锚点数为 ${n ?? '读不到'}（圆角应为 8）`);
      }
    }
  }
  return isLive ? dnum(meta.keyOriginType) : null;
}

/**
 * 建一个形状图层，并核对它的外接矩形确实等于期望的几何范围。
 * 对不上说明 PS 没按描述符来（典型是建成了铺满画布的空形状层），
 * 删掉这个废层换下一种策略。
 * @throws 所有策略都不成时抛出最后一次的错误
 */
async function createShapeLayer(spec, lineRgb, fillRgb) {
  const isRect = spec.kind === 'rect';
  // 实时矩形优先；建不出来就退回路径写法，至少画面是对的，只是不能在属性面板里改
  const all = isRect ? [...RECT_STRATEGIES, ...PATH_STRATEGIES] : PATH_STRATEGIES;
  const remembered = isRect ? shapeStrategy.rect : shapeStrategy.path;
  const list = remembered ? all.filter((s) => s.name === remembered) : all;

  const expected = isRect
    ? { left: spec.rect.left, top: spec.rect.top, right: spec.rect.right, bottom: spec.rect.bottom }
    : componentsBBox(spec.components);
  let lastErr = null;

  for (const strat of list) {
    let layer = null;
    try {
      await strat.run(spec, lineRgb, fillRgb);
      layer = newestSelected();
      if (!layer) throw new Error(`${strat.name}：没有建出图层`);
      // 外接框校验：抓「建成了铺满画布的空形状层」这类彻底跑偏的情况。
      // 容差要把描边算进去——真机 dump 证实 layer.bounds 是含描边的栅格范围，
      // 描边居中对齐时会比路径本身向外胀半个线宽（再向外取整）。
      const actual = layerBBox(layer);
      const tol = 2 + (spec.lineWidth || 0);
      if (!bboxMatches(expected, actual, tol)) {
        throw new Error(
          `${strat.name}：建出的图层位置尺寸不对（期望 ${fmtBox(expected)}，实得 ${fmtBox(actual)}）`,
        );
      }
      // 矩形层的深度校验只在【第一个】格子上做一次，之后沿用结论，不再逐格往返
      if (isRect && strat.rectLayer && !remembered) {
        liveShapeType = await probeRectLayer(layer, spec, strat);
      }
      // 按图层种类记住走通的那条（矩形退回路径写法时也记下，别每格都重试一遍矩形）
      if (isRect) shapeStrategy.rect = strat.name;
      else shapeStrategy.path = strat.name;
      return layer;
    } catch (e) {
      lastErr = e;
      console.error('[Sliceman] 建形状层失败：', strat.name, e);
      // 建了个不对的层就删掉，免得在图层面板留一堆垃圾
      if (layer) { try { await bp([deleteLayer(layer.id)]); } catch { /* 删不掉就算了 */ } }
    }
  }
  throw lastErr || new Error('无法建立形状图层');
}

const fmtBox = (b) => (b ? `${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}` : '读不到');

/**
 * 绘制表格。
 * @param {{layers:Array<{name:string, role:'line'|'fill', components:Array}>, groupName:string|null}} plan
 *        由 lib/table-core.js 的 buildTable 产出
 * @param {{lineColor:string, fillColor:string}} colors #rrggbb
 * @param {{onProgress?:(done:number,total:number)=>void}} opts
 * @returns {Promise<{created:number, failed:number, groupId:number|null}>}
 */
export async function drawTable(plan, colors, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 Photoshop 文档。');
  if (!plan.layers?.length) return { created: 0, failed: 0, groupId: null };

  const lineRgb = hexToRgb(colors.lineColor) || { r: 0, g: 0, b: 0 };
  const fillRgb = hexToRgb(colors.fillColor) || { r: 128, g: 128, b: 128 };

  // 倒序创建：PS 每次把新图层建在当前层【之上】，倒着建出来图层面板才是 R1C1 在最上
  const queue = plan.layers.slice().reverse();
  const madeIds = [];
  let created = 0, failed = 0, firstErr = null;

  const doDraw = async () => {
    created = 0; failed = 0; madeIds.length = 0; firstErr = null;
    for (const spec of queue) {
      try {
        const layer = await createShapeLayer(spec, lineRgb, fillRgb);
        madeIds.push(layer.id);
        if (layer.name !== spec.name) {
          try { await bp([setName(layer.id, spec.name)]); } catch { /* 名字不对不算失败 */ }
        }
        created++;
      } catch (e) {
        failed++;                                // 单层失败只计数，其余继续
        if (!firstErr) firstErr = e;             // 第一条错误往上报，别再让它无声无息
        // 一层都建不成时没必要把整张表都试一遍，早点收工把错误交出去
        if (created === 0 && failed >= 2) break;
      }
      onProgress(created + failed, queue.length);
    }

    // 建组：把刚建的所有图层选上再编组（多选编组 = 原生 Ctrl+G）
    if (plan.groupName && madeIds.length > 1) {
      try {
        await bp(madeIds.map((id, i) => (i === 0 ? selectOne(id) : addToSel(id))));
        await bp([makeGroup(plan.groupName)]);
      } catch (e) { console.error('[Sliceman] 建组失败：', e); }
    } else if (madeIds.length === 1) {
      try { await bp([selectOne(madeIds[0])]); } catch { /* 忽略 */ }
    }
  };

  // 单步撤销：整批绘制合并成一条「快速绘制表格」历史
  if (typeof doc.suspendHistory === 'function') {
    try {
      await doc.suspendHistory(doDraw, '快速绘制表格');
      return { created, failed, error: firstErr, strategy: shapeStrategy.rect || shapeStrategy.path, liveShape: liveShapeType };
    } catch (e) {
      if (created > 0 || failed > 0) throw e;   // 已经画过就如实上抛，避免二次执行画出两套
      console.error('[Sliceman] suspendHistory 不可用，改用 executeAsModal：', e);
    }
  }
  await core.executeAsModal(doDraw, { commandName: '快速绘制表格' });
  return { created, failed, error: firstErr, strategy: shapeStrategy.rect || shapeStrategy.path, liveShape: liveShapeType };
}
