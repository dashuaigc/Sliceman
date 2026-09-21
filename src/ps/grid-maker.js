// PS API 封装：创建定位格 —— 扩画布 → 建一批矩形形状图层 → 配套参考线。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
// 全部几何在 src/lib/gridcell-core.js（有单测），这里只做「几何 → 描述符」的翻译。
//
// 建形状层的写法与 src/ps/table-maker.js 的「独立单元格」同源：
//   用 _obj:'rectangle' 几何让 PS 把图层认成【实时形状】（属性面板能直接改 W/H/X/Y），
//   PS 不买账时退回自己算的四点路径 —— 画面一定对，只是属性面板改不了。
//   两条路子都显式给一份 strokeStyle 并把描边关掉：不给的话 PS 会沿用形状工具
//   上一次的描边设置，用户画过描边就会给每个定位格镶一圈边（需求 §3 要求无描边）。
//
// 顺序上有一处必须守住：**先扩画布，再算参考线**。
//   画布尺寸变了，格子坐标跟着变；已有参考线在扩画布时也会被 PS 挪位置。
//   所以已有参考线一律在扩完之后现读，去重才对得上。
//
// 关于「背景」图层：这里【不】把它转成普通图层。扩画布时 PS 会用背景色填新增区域，
//   这正是原生「图像 > 画布大小」的行为，对白底稿子来说无缝；而擅自转普通图层会把
//   用户的「背景」变成「图层 0」，是个不该由本功能引入的副作用。
//   （批量改尺寸那边要的是透明边，所以它反过来会转 —— 见 src/ps/resizer.js）
//
// 单步撤销：扩画布 + 全部图层 + 全部参考线包在一次 doc.suspendHistory 里，Ctrl+Z 一次回到原样。

import { roundRectPoints } from '../lib/table-core.js';
import { guidesOf } from '../lib/gridcell-core.js';
import { hexToRgb } from './table-maker.js';
import { readExistingGuides } from './guides.js';

const photoshop = require('photoshop');

const { app, action, core } = photoshop;
// constants 是较新版本才有的枚举表；取不到就不传 mode/fill，让 PS 用它的默认值
const K = photoshop.constants || {};

const dontDisplay = { dialogOptions: 'dontDisplay' };
const px = (v) => ({ _unit: 'pixelsUnit', _value: v });

/** ⚠️ PS 的 RGBColor 里绿色分量键名就叫 grain，不是 green */
const rgbDesc = (rgb) => ({ _obj: 'RGBColor', red: rgb.r, grain: rgb.g, blue: rgb.b });

// ---- 描述符 ----

/** 从中心向四周扩画布（§16）：原有内容在画布里的相对位置保持不变 */
const setCanvas = (w, h) => ({
  _obj: 'canvasSize',
  width: px(w),
  height: px(h),
  horizontal: { _enum: 'horizontalLocation', _value: 'center' },
  vertical: { _enum: 'verticalLocation', _value: 'center' },
  _options: dontDisplay,
});

/**
 * 描边样式：本功能恒定「关描边、开填充」。
 * 字段照着 table-maker.js 真机验证过的那份写全 —— 少给键 PS 会拿工具的当前设置顶上。
 */
const noStrokeStyle = (rgb) => ({
  _obj: 'strokeStyle',
  strokeStyleVersion: 2,
  strokeEnabled: false,
  fillEnabled: true,
  strokeStyleLineWidth: px(0),
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
  strokeStyleContent: { _obj: 'solidColorLayer', color: rgbDesc(rgb) },
  strokeStyleResolution: 72,
});

/** PS 原生矩形几何：唯一能让图层成为「实时形状」的写法。圆角恒为 0，只给四条边 */
const nativeRect = (c) => ({
  _obj: 'rectangle', top: px(c.top), left: px(c.left), bottom: px(c.bottom), right: px(c.right),
});

const paint = ([x, y]) => ({ _obj: 'paint', horizontal: px(x), vertical: px(y) });

/** 自己算的四点闭合路径（备用几何：PS 不给实时形状时至少画面是对的） */
const pathRect = (c) => ({
  _obj: 'pathClass',
  pathComponents: [{
    _obj: 'pathComponent',
    shapeOperation: { _enum: 'shapeOperation', _value: 'add' },
    subpathListKey: [{
      _obj: 'subpathsList',
      closedSubpath: true,
      points: roundRectPoints(c.left, c.top, c.right - c.left, c.bottom - c.top, 0).map((p) => ({
        _obj: 'pathPoint',
        anchor: paint(p.anchor),
        forward: paint(p.forward),
        backward: paint(p.backward),
        smooth: false,
      })),
    }],
  }],
});

const makeCellLayer = (cell, rgb, geom) => ({
  _obj: 'make',
  _target: [{ _ref: 'contentLayer' }],
  using: {
    _obj: 'contentLayer',
    type: { _obj: 'solidColorLayer', color: rgbDesc(rgb) },
    shape: geom === 'native' ? nativeRect(cell) : pathRect(cell),
    strokeStyle: noStrokeStyle(rgb),
  },
  _options: dontDisplay,
});

const setName = (id, name) => ({
  _obj: 'set', _target: [{ _ref: 'layer', _id: id }], to: { _obj: 'layer', name }, _options: dontDisplay,
});
const deleteLayer = (id) => ({
  _obj: 'delete', _target: [{ _ref: 'layer', _id: id }], _options: dontDisplay,
});
const selectOne = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false, _options: dontDisplay,
});
const addToSel = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false,
  selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
  _options: dontDisplay,
});
const makeGuide = (dir, pos) => ({
  _obj: 'make',
  new: { _obj: 'good', position: px(pos), orientation: { _enum: 'orientation', _value: dir } },
  _options: dontDisplay,
});
/** 新建一个空白普通图层（建在当前层之上，并成为选中层） */
const makeLayer = { _obj: 'make', _target: [{ _ref: 'layer' }], _options: dontDisplay };
/** 把当前选中的图层挪到图层面板最底下 */
const moveToBack = {
  _obj: 'move',
  _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
  to: { _ref: 'layer', _enum: 'ordinal', _value: 'back' },
  _options: dontDisplay,
};

// ---- 工具 ----

/** 取数：PS 各版本里尺寸字段可能是 number 或 {_value} */
function n(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v._value === 'number') return v._value;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : 0;
}

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

/** 顶层图层里还有没有这个 id（读不到就当「没有」，宁可少删也别去删不存在的层） */
function layerExists(id) {
  try {
    return Array.from(app.activeDocument.layers || []).some((l) => l.id === id);
  } catch { return false; }
}

/** 图层外接矩形；读不到返回 null */
function layerBBox(layer) {
  try {
    const b = layer.bounds;
    const r = { left: n(b.left), top: n(b.top), right: n(b.right), bottom: n(b.bottom) };
    return Object.values(r).every(Number.isFinite) ? r : null;
  } catch { return null; }
}

/** 建出来的东西是不是真在我们要的位置上（抓「建成了铺满画布的空形状层」这类跑偏） */
function bboxOk(want, got, tol = 2) {
  if (!got) return true;                       // 读不到就不判，别把能用的策略误杀
  return ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(want[k] - got[k]) <= tol);
}

// 两条建层路子，按顺序试；哪条真跑通就记下来，后续格子直接用，不再逐格重试。
const STRATEGIES = ['native', 'path'];
let cellStrategy = null;

/**
 * 建一个定位格形状层，并核对外接框。
 * @throws 两条路子都不成时抛出最后一次的错误
 */
async function createCellLayer(cell, rgb) {
  const list = cellStrategy ? [cellStrategy] : STRATEGIES;
  let lastErr = null;
  for (const geom of list) {
    let layer = null;
    try {
      await bp([makeCellLayer(cell, rgb, geom)]);
      layer = newestSelected();
      if (!layer) throw new Error(`${geom}：没有建出图层`);
      if (!bboxOk(cell, layerBBox(layer))) {
        throw new Error(`${geom}：建出的图层位置尺寸不对（期望 ${fmtBox(cell)}，实得 ${fmtBox(layerBBox(layer))}）`);
      }
      cellStrategy = geom;
      return layer;
    } catch (e) {
      lastErr = e;
      console.error('[Sliceman] 建定位格失败：', geom, e);
      if (layer) { try { await bp([deleteLayer(layer.id)]); } catch { /* 删不掉就算了 */ } }
    }
  }
  throw lastErr || new Error('无法建立形状图层');
}

const fmtBox = (b) => (b ? `${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}` : '读不到');

/**
 * 补一个【透明的】「背景」层，沉到图层面板最底下（只有「在新 PSD 中创建」会用）。
 *
 * 为什么放在定位格都建完之后：新文档自带的那个空图层会被第一个形状层顶替掉
 * （真机实测，连 id 都换新），先改名是留不住的。等形状层都落位了再补，才稳。
 *
 * 通常此时文档里只剩下 N 个定位格（自带的空层已被吞），直接新建一层挪到底即可。
 * 但万一 PS 换了行为、那个空层还在，就【直接拿它当背景】—— 不然会平白多出一个空层。
 *
 * @param {string} name 背景层名字
 * @param {number[]} madeIds 刚建出来的定位格图层 id
 * @returns {Promise<number|null>} 背景层 id；建不出来返回 null
 */
async function addBackgroundLayer(name, madeIds) {
  const doc = app.activeDocument;
  const made = new Set(madeIds);
  let spare = null;
  try {
    spare = Array.from(doc.layers || []).filter((l) => !made.has(l.id));
  } catch { spare = []; }

  if (spare.length === 1) {
    await bp([setName(spare[0].id, name)]);
    return spare[0].id;
  }
  await bp([makeLayer]);
  const layer = newestSelected();
  if (!layer) return null;
  await bp([moveToBack, setName(layer.id, name)]);
  return layer.id;
}

// ---- 新建文档 ----
//
// 「在新 PSD 中创建」用的。画布尺寸由定位格反推（外框 + 四周一个间距），传进来就是最终值。
//
// 两条路：DOM 的 documents.add 传的是干净的像素数，优先走它；老版本上没有 / 抛错
//   再退回 batchPlay 的 make document。后者的 width/height 用 distanceUnit——
//   分辨率固定 72ppi 时它与像素等值，所以两条路给出的画布一模一样。
//
// 填充用透明：定位格常配合「Symbols 切图」用，导出要的就是透明底。
//
// ⚠️ 透明文档自带的那个空图层【会被第一个形状层顶替掉】（PS 27.7 实测：
//   1 层「图层 1#2」→ 建一个形状后仍是 1 层，变成「矩形 1#3」，连 id 都换了新的）。
//   所以「背景」层不能靠给它改名来留住 —— 改完照样会被吞。
//   正确做法是【等定位格都建完，再补一个空图层并移到最底】，见 addBackgroundLayer。

// ⚠️ 这份描述符是在 PS 27.7 上逐键试出来的，别凭「ScriptListener 一般都这么录」再加回去：
//   · `preset: 'Custom'` 【必须没有】—— 带上它整条命令直接被拒（「命令"建立"的参数无效」）。
//     预设名是本地化的，中文版里根本没有叫 Custom 的预设。这是当初唯一的报错原因。
//   · width / height / resolution / mode / fill 是【最小必需集】，少任何一个同样被拒。
//   · pixelsUnit 与 distanceUnit 在 72ppi 下实测等价，这里用 pixelsUnit（语义更直白）。
//   · 填充用透明，建出来是 1 个普通空图层（会被第一个形状层顶替，见上）。
const makeDocDesc = (w, h, name) => ({
  _obj: 'make',
  new: {
    _obj: 'document',
    name,
    width: { _unit: 'pixelsUnit', _value: w },
    height: { _unit: 'pixelsUnit', _value: h },
    resolution: { _unit: 'densityUnit', _value: 72 },
    mode: { _class: 'RGBColorMode' },
    fill: { _enum: 'fill', _value: 'transparent' },
  },
  _options: dontDisplay,
});

/**
 * 新建一个文档并切过去。
 * @param {number} width  画布宽（px）
 * @param {number} height 画布高（px）
 * @param {string} name   文档名
 * @returns {Promise<object>} 新文档（就是 app.activeDocument）
 */
export async function createDocument(width, height, name) {
  const run = async () => {
    let ok = false;
    try {
      if (app.documents && typeof app.documents.add === 'function') {
        const opts = { width, height, resolution: 72, name };
        if (K.NewDocumentMode) opts.mode = K.NewDocumentMode.RGB;
        if (K.DocumentFill) opts.fill = K.DocumentFill.TRANSPARENT;
        ok = !!(await app.documents.add(opts));
      }
    } catch (e) {
      console.error('[Sliceman] documents.add 不可用，改走 batchPlay：', e);
    }
    if (!ok) await bp([makeDocDesc(width, height, name)]);
  };
  await core.executeAsModal(run, { commandName: '新建定位格文档' });

  const doc = app.activeDocument;
  if (!doc) throw new Error('新建文档失败：Photoshop 没有返回可用的文档。');
  // 建出来的尺寸对不上就如实报错 —— 后面的坐标全按这个画布算，尺寸错了整套都会偏
  const gotW = Math.round(n(doc.width));
  const gotH = Math.round(n(doc.height));
  if (Math.abs(gotW - width) > 1 || Math.abs(gotH - height) > 1) {
    throw new Error(`新建文档的尺寸不对（要 ${width}×${height}，实得 ${gotW}×${gotH}）`);
  }
  return doc;
}

/**
 * 创建一批定位格。
 * @param {object} plan  由 lib/gridcell-core.js 的 buildGrid 产出
 * @param {string} color #rrggbb
 * @param {{guides?:boolean, onProgress?:(done:number,total:number)=>void}} [opts]
 *        guides=false 则只建形状层，不加参考线
 * @returns {Promise<{created:number, failed:number, error:Error|null, strategy:string|null,
 *                    resized:boolean, guides:number}>}
 */
export async function createGridCells(plan, color, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 Photoshop 文档。');
  if (!plan.cells?.length) return { created: 0, failed: 0, error: null, strategy: null, resized: false, guides: 0 };

  const rgb = hexToRgb(color) || { r: 153, g: 153, b: 153 };
  // 倒序创建：PS 每次把新图层建在当前层【之上】，倒着建出来图层面板才是「定位格 01」在最上
  const queue = plan.cells.slice().reverse();

  let created = 0;
  let failed = 0;
  let firstErr = null;
  let resized = false;
  let guidesMade = 0;
  let bgMade = false;
  const madeIds = [];

  const run = async () => {
    created = 0; failed = 0; firstErr = null; resized = false; guidesMade = 0;
    bgMade = false; madeIds.length = 0;

    // 1) 扩画布（必须最先做：后面的坐标都是按新画布算的）
    if (plan.canvas.expanded) {
      await bp([setCanvas(plan.canvas.width, plan.canvas.height)]);
      resized = true;
    }

    // 2) 先垫一个空图层再开建。
    //
    // ⚠️ 这一步是必需的，别当成多余：PS 会用第一个形状层把【当前选中的空图层】
    //    整个顶替掉（真机实测，层数不增、id 换新）。用户刚新建一张透明画布就来建
    //    定位格时，被顶掉的正是他那个空图层 —— 画布看着就「背景图层不见了」。
    //    垫这一层就是让它去挨这一下，用户自己的图层原封不动。
    //    垫层随后要么被吃掉（正常），要么还在（PS 换了行为）→ 下面按 id 删掉。
    let scratchId = null;
    try {
      await bp([makeLayer]);
      const s = newestSelected();
      scratchId = s ? s.id : null;
    } catch (e) {
      console.error('[Sliceman] 垫层建不出来，沿用 PS 的顶替行为：', e);
    }

    // 3) 逐个建形状层并改名
    for (const cell of queue) {
      try {
        const layer = await createCellLayer(cell, rgb);
        madeIds.push(layer.id);
        if (layer.name !== cell.name) {
          try { await bp([setName(layer.id, cell.name)]); } catch { /* 名字不对不算失败 */ }
        }
        created++;
      } catch (e) {
        failed++;                                  // 单个失败只计数，其余继续
        if (!firstErr) firstErr = e;
        // 一个都建不成时没必要把整批都试一遍，早点收工把错误交出去
        if (created === 0 && failed >= 2) break;
      }
      onProgress(created + failed, queue.length);
    }

    // 4) 垫层没被吃掉（第一个形状另起了一层）就删了它，别在图层面板留个空层。
    //
    // ⚠️ 判断「有没有被吃」只能看【文档里还有没有这个 id】，不能拿 madeIds 比对：
    //    被顶替时 PS 给新形状层发的是【全新 id】（真机实测 图层 2#3 → 矩形 1#4），
    //    垫层的 id 直接消失，所以 madeIds 里永远找不到它 —— 那样每次都会去删一个
    //    已经不存在的图层，报「命令"删除"当前不可用」。
    if (scratchId !== null && layerExists(scratchId)) {
      try { await bp([deleteLayer(scratchId)]); } catch { /* 删不掉只是多一个空层 */ }
    }

    // 5) 参考线：扩完画布再读已有的，去重才对得上（§22）
    if (opts.guides !== false && created > 0) {
      const g = guidesOf(plan.cells, readExistingGuides());
      const desc = [
        ...g.vertical.map((x) => makeGuide('vertical', x)),
        ...g.horizontal.map((y) => makeGuide('horizontal', y)),
      ];
      if (desc.length) {
        try {
          await action.batchPlay(desc, {});        // 整批一次下发，参考线是轻量对象
          guidesMade = desc.length;
        } catch {
          // 整批失败（某条坐标被 PS 拒绝会连累整调用）→ 退回逐条，能建多少建多少
          for (const d of desc) {
            try { await action.batchPlay([d], {}); guidesMade++; } catch { /* 跳过这一条 */ }
          }
        }
      }
    }

    // 6) 补一个透明的「背景」层沉到最底（只有「在新 PSD 中创建」会传 bgLayerName）。
    //    建不出来只是少一层，不该让整批定位格白做，所以失败只记日志。
    if (opts.bgLayerName && created > 0) {
      try {
        bgMade = !!(await addBackgroundLayer(opts.bgLayerName, madeIds));
      } catch (e) {
        console.error('[Sliceman] 背景图层创建失败：', e);
      }
    }

    // 7) 让刚建的定位格留在选中状态，方便接着编组 / 移动
    if (madeIds.length) {
      try {
        // 倒序建的，这里正过来选，选中顺序与编号一致
        const ids = madeIds.slice().reverse();
        await bp(ids.map((id, i) => (i === 0 ? selectOne(id) : addToSel(id))));
      } catch { /* 选择恢复失败不影响结果 */ }
    }
  };

  const result = () => ({
    created, failed, error: firstErr, strategy: cellStrategy, resized, guides: guidesMade,
    background: bgMade,
  });

  // 单步撤销：整批合并成一条「创建定位格」历史
  if (typeof doc.suspendHistory === 'function') {
    let started = false;
    try {
      await doc.suspendHistory(async () => { started = true; await run(); }, '创建定位格');
      return result();
    } catch (e) {
      // 回调压根没跑起来（suspendHistory 本身不可用）→ 换传统模态重试；
      // 已经开始改文档则如实上抛，避免二次执行建出两套
      if (started) throw e;
    }
  }
  await core.executeAsModal(run, { commandName: '创建定位格' });
  return result();
}
