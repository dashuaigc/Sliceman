// PS API 封装：参考线的读 / 建 / 清 / 显隐 / 锁定。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
// 纯几何（版面计算 / 去重 / 历史）在 src/lib/guide-core.js，有单测。
//
// 一律作用于 app.activeDocument（每次调用现读，用户切文档后自动跟着切，需求 §29）。
//
// 为什么建参考线走 batchPlay 的 make good 而不是 DOM 的 doc.guides.add()：
//   DOM 版在 PS 23.x 有两个已知缺陷——非 72PPI 文档坐标算错、返回值不是有效的 Guide
//   实例（官方发布说明里 24.0 才修）。manifest 支持到 23.3，所以主路走描述符，
//   DOM 只作兜底。读取和删除反过来——DOM 更直白，描述符作兜底。
//
// 单步撤销：与 src/ps/layouter.js 同款，优先官方 doc.suspendHistory，旧版退回
//   executeAsModal（符合「只用官方 API 合并历史」的结论，不复用快照折叠那套手法）。
//
// 坐标基准是【标尺原点】：用户若在 PS 里拖动过标尺原点，参考线位置会整体偏移。
//   这与 PS 原生「新建参考线版面」的行为一致，不额外补偿。

import { sortDedupe, guideLayoutDescriptor, sameGuides } from '../lib/guide-core.js';

const { app, action, core } = require('photoshop');

const dontDisplay = { dialogOptions: 'dontDisplay' };
const px = (v) => ({ _unit: 'pixelsUnit', _value: v });

/** 取数：PS 各版本里尺寸字段可能是 number 或 {_value} */
function n(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v._value === 'number') return v._value;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : 0;
}

/** 方向归一：DOM 返回 'horizontal'/'vertical'，描述符可能返回 {_value:'vertical'} */
function isVertical(dir) {
  const s = String(dir && dir._value != null ? dir._value : dir).toLowerCase();
  return s.indexOf('vert') >= 0;
}

/** 新建一条参考线的描述符。dir: 'vertical' | 'horizontal'，pos: 该轴上的坐标 */
const makeGuide = (dir, pos) => ({
  _obj: 'make',
  new: {
    _obj: 'good',
    position: px(pos),
    orientation: { _enum: 'orientation', _value: dir },
  },
  _options: dontDisplay,
});

/** 清除全部参考线的描述符（DOM removeAll 的兜底） */
const clearAllDesc = {
  _obj: 'delete',
  _target: [{ _ref: 'good', _enum: 'ordinal', _value: 'allEnum' }],
  _options: dontDisplay,
};

/**
 * 当前画布尺寸（px）。没有打开文档时返回 null（需求 §30）。
 * @returns {{width:number, height:number}|null}
 */
export function readCanvas() {
  const doc = app.activeDocument;
  if (!doc) return null;
  const width = n(doc.width);
  const height = n(doc.height);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/** 当前是否有打开的文档 */
export function hasDoc() {
  return !!app.activeDocument;
}

/**
 * 读当前文档已有的参考线坐标，供去重用（需求 §32）。
 * 读不到就返回空——此时最坏结果是可能出现重复参考线，不影响主流程。
 * @returns {{vertical:number[], horizontal:number[]}}
 */
export function readExistingGuides() {
  const out = { vertical: [], horizontal: [] };
  const doc = app.activeDocument;
  if (!doc) return out;
  try {
    const gs = doc.guides;
    const len = gs ? gs.length : 0;
    for (let i = 0; i < len; i++) {
      const g = gs[i];
      if (!g) continue;
      (isVertical(g.direction) ? out.vertical : out.horizontal).push(n(g.coordinate));
    }
  } catch { /* 老版本读不到集合：按「没有已有参考线」处理 */ }
  return out;
}

/**
 * 创建一批参考线。
 * @param {{vertical:number[], horizontal:number[]}} pos 目标坐标
 * @param {{clearFirst?:boolean, commandName?:string}} [opts]
 *        clearFirst=true 先清空当前文档参考线（替换模式），false 则追加（需求 §5）
 * @returns {Promise<{created:number, skipped:number, cleared:boolean}>}
 *          skipped = 因与已有参考线重合而没建的条数
 */
export async function applyGuides(pos, opts = {}) {
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 Photoshop 文档');
  const clearFirst = opts.clearFirst !== false;

  // 追加模式下与已有参考线去重；替换模式下马上要清空，无需比对
  const existing = clearFirst ? { vertical: [], horizontal: [] } : readExistingGuides();
  const v = sortDedupe(pos.vertical || [], existing.vertical);
  const h = sortDedupe(pos.horizontal || [], existing.horizontal);
  const wanted = (pos.vertical || []).length + (pos.horizontal || []).length;
  const desc = [
    ...v.map((x) => makeGuide('vertical', x)),
    ...h.map((y) => makeGuide('horizontal', y)),
  ];

  let created = 0;
  let cleared = false;
  const run = async () => {
    created = 0;
    cleared = false;
    if (clearFirst) {
      cleared = await removeAllGuides(doc);
    }
    if (!desc.length) return;
    try {
      // 整批一次下发：参考线是轻量对象，逐条调用只是多花时间
      await action.batchPlay(desc, {});
      created = desc.length;
    } catch {
      // 整批失败（某条坐标被 PS 拒绝会连累整调用）→ 退回逐条，能建多少建多少
      for (const d of desc) {
        try { await action.batchPlay([d], {}); created++; } catch { /* 跳过这一条 */ }
      }
    }
  };

  await runAsOneStep(doc, run, opts.commandName || '创建参考线');
  return { created, skipped: wanted - desc.length, cleared };
}

/**
 * 清除参考线（需求 §20 / §21）。只动当前文档，不碰插件里保存的记录。
 * @param {'all'|'h'|'v'} [which]
 * @returns {Promise<{removed:number}>}
 */
export async function clearGuides(which = 'all') {
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 Photoshop 文档');

  let removed = 0;
  const run = async () => {
    removed = 0;
    if (which === 'all') {
      const before = countGuides(doc);
      const ok = await removeAllGuides(doc);
      removed = ok ? before : 0;
      return;
    }
    const wantVertical = which === 'v';
    // 倒着删：删除会让集合就地收缩，正着遍历会跳过元素
    try {
      const gs = doc.guides;
      for (let i = (gs ? gs.length : 0) - 1; i >= 0; i--) {
        const g = gs[i];
        if (!g || isVertical(g.direction) !== wantVertical) continue;
        try { g.delete(); removed++; } catch { /* 单条删不掉不影响其余 */ }
      }
    } catch { /* 集合不可用：这一方向没法单独清，如实返回 0 */ }
  };

  await runAsOneStep(doc, run, which === 'all' ? '清除参考线'
    : (which === 'v' ? '清除纵向参考线' : '清除横向参考线'));
  return { removed };
}

/** 当前参考线条数（清除前后报数用） */
function countGuides(doc) {
  try { return doc.guides ? doc.guides.length : 0; } catch { return 0; }
}

/** 清空全部参考线：DOM removeAll 优先，失败退描述符 */
async function removeAllGuides(doc) {
  try {
    if (doc.guides && typeof doc.guides.removeAll === 'function') {
      doc.guides.removeAll();
      return true;
    }
  } catch { /* 换描述符 */ }
  try {
    await action.batchPlay([clearAllDesc], {});
    return true;
  } catch {
    return false;
  }
}

/**
 * 把一段操作合成一条历史记录。与 layouter.js 同款：
 * 优先官方 doc.suspendHistory，不可用时退回 executeAsModal。
 */
async function runAsOneStep(doc, fn, commandName) {
  if (typeof doc.suspendHistory === 'function') {
    let started = false;
    try {
      await doc.suspendHistory(async () => { started = true; await fn(); }, commandName);
      return;
    } catch (e) {
      // 回调压根没跑起来（suspendHistory 本身不可用）→ 换传统模态重试；
      // 已经开始改文档则如实上抛，避免二次执行把参考线建两遍
      if (started) throw e;
    }
  }
  await core.executeAsModal(fn, { commandName });
}

// ---- 原生「新建参考线版面」对话框（预览 / 创建两种状态的可靠实现）----
//
// 插件自己画预览有个治不好的毛病：面板被折叠时没法撤销 —— UXP 的面板 hide 回调
// 在 Photoshop 里从不触发（Adobe 已知问题 PS-57284）。原生对话框没这个问题：
// 它自带「预览」勾选框，点「确定」才创建，直接关掉弹窗则什么都不留。
//
// 用户在弹窗里填了什么，插件有【两条】独立途径拿到，谁先拿到算谁的（记录按参数
// 签名去重，重复写入只是把同一条提到最前，无副作用）：
//   1. batchPlay 的【返回值】—— 带 dialogOptions:'display' 执行时，PS 回传的就是
//      「实际执行的那份描述符」，也就是用户在弹窗里确认的参数；
//   2. newGuideLayout 的动作通知（onGuideLayoutCreated）—— 顺带把用户自己走
//      「视图 > 新建参考线版面」建的版面也记下来。
// 两条都留着：单靠通知，某些版本 / 某些路径收不到就成了「建了但没记录」。

/** 用户在对话框里按了取消 */
function isCancelErr(e) {
  if (!e) return false;
  if (e.number === 9 || e.code === 9) return true;
  return /cancel/i.test(String(e.message ?? e));
}

/** 结果里挑出像 newGuideLayout 参数的那份描述符（PS 各版本回传形状不完全一致） */
function pickLayoutDesc(res) {
  for (const d of Array.isArray(res) ? res : []) {
    if (!d || typeof d !== 'object') continue;
    if (d.guideLayout || 'colCount' in d || 'rowCount' in d
      || 'columnCount' in d || 'marginTop' in d) return d;
  }
  return null;
}

/**
 * 打开一次原生对话框。
 * @returns {Promise<{cancelled:boolean, desc:object|null}>} desc = 用户确认的参数
 */
async function playGuideLayout(desc) {
  let cancelled = false;
  let result = null;
  await core.executeAsModal(async () => {
    try {
      const res = await action.batchPlay(
        [{ ...desc, _options: { dialogOptions: 'display' } }], {},
      );
      result = pickLayoutDesc(res);
    } catch (e) {
      if (!isCancelErr(e)) throw e;
      cancelled = true;
    }
  }, { commandName: '新建参考线版面' });
  return { cancelled, desc: result };
}

/**
 * 走菜单项打开弹窗 —— 和用户自己点「视图 > 新建参考线版面」是同一条路，
 * 所以弹窗里的初值完全交给 Photoshop：首次是出厂默认，之后就是上一次确定的设置。
 * （传描述符那条路不行：PS 会拿描述符去初始化弹窗，反而把它自己记的「上次设置」顶掉。）
 */
async function playGuideLayoutMenu() {
  return playGuideLayout({ _obj: 'select', _target: menuRef('newGuideLayout') });
}

/**
 * 打开原生「新建参考线版面」对话框。
 *
 * ⚠️ 关于弹窗里的初值 —— 只能走菜单项，不能传描述符：
 * 只要给 batchPlay 传了 `newGuideLayout` 描述符（哪怕是空的 `{_obj:'newGuideLayout'}`），
 * Photoshop 就按【这份描述符】初始化弹窗，缺的键用出厂默认（装订线 20 像素、数量 2、
 * 边距 20 像素）补上，它自己记的「上次设置」反而用不上 —— 表现就是每次打开都像第一次。
 * 改成播放菜单项后，弹窗的记忆完全归 PS 管：首次出厂默认，之后自动填上一次确定的数值，
 * 和用户手动点「视图 > 新建参考线版面」一模一样。
 *
 * @param {{prefill?:object|null}} [opts] 仅在菜单项这条路走不通时用来兜底预填
 * @returns {Promise<{created:boolean, cancelled:boolean, desc:object|null, native:boolean}>}
 *          created = 文档里的参考线确实变了（= 点了确定）
 *          desc    = PS 回传的实际执行参数，拿不到则为 null
 *          native  = 是否走的菜单项（弹窗数值由 PS 自己记忆）
 */
export async function openGuideLayoutDialog(opts = {}) {
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 Photoshop 文档');
  const before = readExistingGuides();

  // 兜底顺序：菜单项（原生记忆）→ 按上一条记录预填的描述符 → 空描述符。
  // full=true：每个键都写满、没启用的写 0 —— 少给一个键 PS 就拿出厂默认顶上
  const tries = [playGuideLayoutMenu];
  if (opts.prefill) {
    tries.push(() => playGuideLayout(guideLayoutDescriptor(opts.prefill, { full: true })));
    tries.push(() => playGuideLayout(
      guideLayoutDescriptor(opts.prefill, { full: true, nested: true }),
    ));
  }
  tries.push(() => playGuideLayout({ _obj: 'newGuideLayout' }));

  let r = null;
  let used = -1;
  for (let i = 0; i < tries.length; i++) {
    try {
      r = await tries[i]();
      used = i;
      break;
    } catch (e) {
      if (isCancelErr(e)) return { created: false, cancelled: true, desc: null, native: i === 0 };
    }
  }
  if (!r) return { created: false, cancelled: true, desc: null, native: false, before, after: before };
  // 取消能靠报错认出来最好；认不出来就看文档到底变没变，别把「取消」报成「已创建」
  const after = readExistingGuides();
  const changed = !r.cancelled && !sameGuides(before, after);
  return {
    created: changed,
    cancelled: !changed,
    desc: changed ? r.desc : null,
    native: used === 0,
    before,                       // 拿不到执行参数时，靠前后对比把版面反推回来
    after,
  };
}

/**
 * 不弹窗，直接按一份配置执行 newGuideLayout —— 「应用」历史 / 收藏版面走这里。
 * 用的是 Photoshop 自己的版面引擎，所以「宽度自动」会按当前画布重算，
 * 同一条记录在 1920 和 2560 的稿子上都对得上。
 * @param {object} cfg 版面配置
 */
export async function applyGuideLayout(cfg) {
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 Photoshop 文档');
  let lastErr = null;
  for (const nested of [false, true]) {             // 先用真机抓到的平铺形状，再退嵌套形状
    const desc = { ...guideLayoutDescriptor(cfg, { nested }), _options: dontDisplay };
    try {
      await runAsOneStep(doc, () => action.batchPlay([desc], {}), '应用参考线版面');
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('newGuideLayout 执行失败');
}

/**
 * 监听 Photoshop 的「新建参考线版面」事件：不管弹窗是插件开的还是用户自己走菜单，
 * PS 执行完都会发这个通知，附带实际执行的描述符。
 *
 * 两种订阅写法都挂一遍（字符串 / {event} 对象）：UXP 各版本受哪种不完全一致，
 * 都收到也无害 —— 记录按参数签名去重，同一条只会被提到最前。
 * @param {(desc:object) => void} cb
 * @returns {Promise<boolean>} 是否至少挂上了一种
 */
export async function onGuideLayoutCreated(cb) {
  const handler = (_event, descriptor) => {
    try { cb(descriptor); } catch { /* 回调自己的错不往上抛，别影响 PS */ }
  };
  let ok = false;
  for (const events of [['newGuideLayout'], [{ event: 'newGuideLayout' }]]) {
    try {
      await action.addNotificationListener(events, handler);
      ok = true;
    } catch { /* 这种写法不受支持：试下一种 */ }
  }
  return ok;
}

/** 文档分辨率（ppi），把厘米 / 英寸之类折算成 px 要用 */
export function readResolution() {
  const doc = app.activeDocument;
  if (!doc) return 72;
  const r = n(doc.resolution);
  return r > 0 ? r : 72;
}

// ---- 显示 / 隐藏、锁定 / 解锁 ----
//
// 这两项不在 UXP DOM 里，只有菜单命令。菜单命令是【切换】而不是设值，
// 所以先 get 读 checked，再决定要不要 select。读不到状态时返回 null，
// 由界面层退回「本地记状态 + 只做翻转」。

const MENU_GUIDES = 'toggleGuides';
const MENU_LOCK = 'toggleLockGuides';

const menuRef = (id) => [{ _ref: 'menuItemClass', _enum: 'menuItemType', _value: id }];

/** 读一个菜单项的勾选状态。读不到返回 null */
async function readMenuChecked(id) {
  try {
    const r = await action.batchPlay([{ _obj: 'get', _target: menuRef(id) }], {});
    const d = r && r[0];
    if (!d) return null;
    if (typeof d.checked === 'boolean') return d.checked;
    if (d.checked && typeof d.checked._value === 'boolean') return d.checked._value;
    return null;
  } catch {
    return null;
  }
}

/** 点一次菜单项（切换） */
async function clickMenu(id, commandName) {
  await core.executeAsModal(
    () => action.batchPlay([{ _obj: 'select', _target: menuRef(id), _options: dontDisplay }], {}),
    { commandName },
  );
}

/** 参考线当前是否显示。读不到返回 null */
export function readGuidesVisible() {
  return readMenuChecked(MENU_GUIDES);
}

/** 参考线当前是否锁定。读不到返回 null */
export function readGuidesLocked() {
  return readMenuChecked(MENU_LOCK);
}

/**
 * 切换显示 / 隐藏参考线（需求 §22）。只改显示状态，不删参考线数据。
 * @returns {Promise<boolean|null>} 切换后的状态；读不到状态时返回 null
 */
export async function toggleGuidesVisible() {
  await clickMenu(MENU_GUIDES, '显示/隐藏参考线');
  return readGuidesVisible();
}

/**
 * 切换锁定 / 解锁参考线（需求 §23）。锁定后画布里拖不动参考线。
 * @returns {Promise<boolean|null>}
 */
export async function toggleGuidesLock() {
  await clickMenu(MENU_LOCK, '锁定/解锁参考线');
  return readGuidesLocked();
}
