// 纯逻辑：批量改尺寸的全部算式。
//
// 设计前提：PS 侧只执行【已经算好的整数像素值】—— imageSize / canvasSize 一律传绝对像素，
//   `constrainProportions` 恒为 false，绝不把比例计算交给 Photoshop。这样结果可预测、
//   可在 Node 下单测，真机上也不用反复猜 PS 的取整口径。
//
// 坐标/尺寸约定：全部是正整数像素。
//   image  = 缩放后的图像尺寸（imageSize 的目标）
//   canvas = 最终画布尺寸（canvasSize 的目标；等于 image 时不需要这一步）
//
// 「小图处理」的统一规则（这是本文件里唯一需要动脑的地方）：
//   先按模式算出理想缩放因子 sc。若 sc > 1（意味着要放大）且策略是「不放大」，
//   就把【图像和目标框一起】乘上 k = 1/sc —— 图像因此正好保持原尺寸，
//   目标框按同一因子缩小，比例关系完全不变。
//   例：512×512 配「固定宽高 1024×1024 + 等比适应」→ sc=2、k=0.5 → 输出 512×512（原文 §16）。
//       800×400 配同样设置 → sc=1.28 → 图像 800×400、画布 800×800（按目标比例补边，但不放大）。
//   想要「小图也补边到完整的目标画布」（图标集常用）就开 padSmall，画布不跟着缩。

export const MODES = ['wh', 'w', 'h', 'long', 'short', 'percent', 'times', 'max'];
export const FITS = ['contain', 'cover', 'stretch', 'scale'];   // 仅 mode==='wh' 有意义
export const SMALL = ['keep', 'up', 'skip'];
export const ANCHORS = ['lt', 'ct', 'rt', 'lm', 'cm', 'rm', 'lb', 'cb', 'rb'];

// 面板允许的单边上限。PS 自己能到 300000，但那种尺寸批量处理没有实际意义，
// 夹在 30000 既够用又能挡住「百分比填 99999」这类误操作。
export const MAX_PX = 30000;

// 「小图处理」只对【目标尺寸型】模式生效。百分比 / 倍数是用户直接指定的放大意图，
// 再去拦「不放大」会让「200%」变成什么都不做。
const SMALL_APPLIES = ['wh', 'w', 'h', 'long', 'short', 'max'];

const clampPx = (v) => Math.max(1, Math.min(MAX_PX, Math.round(v)));

function num(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v._value === 'number') return v._value;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : NaN;
}

/** 等比缩放：先定一个统一因子再两边一起取整 —— 两边各自取整会让比例漂移 */
const scaled = (s, sc) => ({ width: clampPx(s.width * sc), height: clampPx(s.height * sc) });

const same = (a, b) => a.width === b.width && a.height === b.height;

/** 画布相对图像是补边、裁切、两者都有、还是不用动 */
function opOf(image, canvas) {
  if (same(image, canvas)) return 'none';
  const dw = canvas.width - image.width;
  const dh = canvas.height - image.height;
  if (dw >= 0 && dh >= 0) return 'pad';
  if (dw <= 0 && dh <= 0) return 'crop';
  return 'mix';                    // 一轴补一轴裁（canvasSize 一次就能同时做掉）
}

/** 该模式下的理想缩放因子（拉伸取放大得更多的那一轴，供「不放大」夹紧用） */
function idealScale(s, c) {
  const sx = c.width / s.width;
  const sy = c.height / s.height;
  switch (c.mode) {
    case 'wh':
      if (c.fit === 'stretch') return Math.max(sx, sy);
      return c.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    case 'w': return sx;
    case 'h': return sy;
    case 'long': return c.edge / Math.max(s.width, s.height);
    case 'short': return c.edge / Math.min(s.width, s.height);
    case 'percent': return c.percent / 100;
    case 'times': return c.times;
    // 最大尺寸限制：没超限就原样（因子 1），超了才等比缩进框内 —— 天然不放大
    case 'max': return Math.min(1, c.maxW / s.width, c.maxH / s.height);
    default: return 1;
  }
}

/**
 * 算一张图的目标尺寸。
 * @param {{width:number,height:number}} src 原始像素尺寸
 * @param {object} cfg
 *   mode    'wh'|'w'|'h'|'long'|'short'|'percent'|'times'|'max'
 *   width/height  固定宽高（mode='w' 只用 width，'h' 只用 height）
 *   edge    最长边 / 最短边的目标值
 *   percent 百分比（100 = 原样）
 *   times   倍数（1 = 原样）
 *   maxW/maxH 最大尺寸限制
 *   fit     'contain'|'cover'|'stretch'|'scale'（仅 mode='wh'）
 *   small   'keep'|'up'|'skip'  小图（需要放大）时怎么办，默认 keep
 *   padSmall  被 keep 夹住时，画布是否仍撑到完整的目标框，默认 false
 *   skipSame  尺寸没有任何变化时是否跳过不输出，默认 false（仍输出，可用于纯格式转换）
 * @returns {{image:{width,height}, canvas:{width,height}, op:'none'|'pad'|'crop'|'mix',
 *            scale:number, changed:boolean, skip:false|'small'|'same'|'invalid'}}
 */
export function planResize(src, cfg) {
  const s = { width: num(src && src.width), height: num(src && src.height) };
  const c = normalizeResizeCfg(cfg);
  const dead = { image: s, canvas: s, op: 'none', scale: 1, changed: false };
  if (!(s.width > 0) || !(s.height > 0)) return { ...dead, image: { width: 1, height: 1 }, canvas: { width: 1, height: 1 }, skip: 'invalid' };

  const sc = idealScale(s, c);
  if (!Number.isFinite(sc) || sc <= 0) return { ...dead, skip: 'invalid' };

  // 小图处理：要放大时按策略拦一下
  const upscaling = sc > 1;
  const guard = SMALL_APPLIES.indexOf(c.mode) >= 0;
  if (upscaling && guard && c.small === 'skip') return { ...dead, skip: 'small' };
  const k = (upscaling && guard && c.small === 'keep') ? 1 / sc : 1;
  const eff = sc * k;
  const box = { width: clampPx(c.width * k), height: clampPx(c.height * k) };

  let image;
  let canvas;
  if (c.mode === 'wh') {
    if (c.fit === 'stretch') {
      image = box;                    // 强行拉到目标框（不保比例）
      canvas = box;
    } else {
      image = scaled(s, eff);
      // contain/cover 要固定画布；scale 只改图像、画布跟着图像走
      canvas = c.fit === 'scale' ? image
        : (k < 1 && c.padSmall ? { width: clampPx(c.width), height: clampPx(c.height) } : box);
    }
  } else {
    image = scaled(s, eff);
    canvas = image;                   // 其余模式都不产生固定画布
  }

  const changed = !same(image, s) || !same(canvas, s);
  const skip = (!changed && c.skipSame) ? 'same' : false;
  return { image, canvas, op: opOf(image, canvas), scale: eff, changed, skip };
}

/** 参数归一：补默认值、夹取值范围（面板传进来的都是字符串，这里统一收口） */
export function normalizeResizeCfg(raw) {
  const r = raw || {};
  const pos = (v, dflt) => {
    const n = num(v);
    return Number.isFinite(n) && n > 0 ? Math.min(MAX_PX, n) : dflt;
  };
  return {
    mode: MODES.indexOf(r.mode) >= 0 ? r.mode : 'wh',
    fit: FITS.indexOf(r.fit) >= 0 ? r.fit : 'contain',
    small: SMALL.indexOf(r.small) >= 0 ? r.small : 'keep',
    anchor: ANCHORS.indexOf(r.anchor) >= 0 ? r.anchor : 'cm',
    width: pos(r.width, 1920),
    height: pos(r.height, 1080),
    edge: pos(r.edge, 2048),
    percent: pos(r.percent, 100),
    times: pos(r.times, 1),
    maxW: pos(r.maxW, 2048),
    maxH: pos(r.maxH, 2048),
    padSmall: !!r.padSmall,
    skipSame: !!r.skipSame,
  };
}

/** 某个模式实际用到哪些参数（面板据此决定显示哪几个输入框，也用于校验） */
export function fieldsOfMode(mode) {
  switch (mode) {
    case 'wh': return ['width', 'height'];
    case 'w': return ['width'];
    case 'h': return ['height'];
    case 'long': case 'short': return ['edge'];
    case 'percent': return ['percent'];
    case 'times': return ['times'];
    case 'max': return ['maxW', 'maxH'];
    default: return [];
  }
}

// 多尺寸输出的「按倍率添加」：一次最多 8 档、单档最多 20 倍。
// 不是为了省内存 —— 每一档都要重新缩放 + 存一次盘，档数一多就是把一次批处理拖成半小时。
const MAX_SCALE = 20;
const MAX_SCALE_COUNT = 8;

/**
 * 倍率输入框 → 一串倍数。用户填的是「1,2,3」这种，中英文逗号 / 分号 / 空格都当分隔符，
 * 「2x」这种带单位的也认（parseFloat 会把 x 丢掉）。
 * 非数字、≤0、超过 20 倍的一律丢掉，重复的去重，从小到大排。
 */
export function parseScaleList(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split(/[,;\s、，；]+/)) {
    if (!raw) continue;
    const k = num(raw);
    if (!Number.isFinite(k) || k <= 0 || k > MAX_SCALE) continue;
    const v = Math.round(k * 1000) / 1000;
    if (out.indexOf(v) < 0) out.push(v);
  }
  return out.sort((a, b) => a - b).slice(0, MAX_SCALE_COUNT);
}

/**
 * 多尺寸列表的一档 → 这一档实际用的 cfg。列表里有两种档：
 *   {width, height} 固定宽高档 —— 覆盖主尺寸，适应方式 / 锚点 / 填充照旧生效；
 *   {times: k}      倍率档 —— 基准是**每张原图自己的尺寸**，不是面板上填的宽高。
 *                   所以同一档对横图竖图各出各的尺寸（@2x 就该是这个意思），
 *                   等比缩放、不产生固定画布，也就谈不上补边和锚点。
 */
export function sizeCfg(cfg, size) {
  const t = size ? num(size.times) : NaN;
  if (Number.isFinite(t) && t > 0) return { ...cfg, mode: 'times', times: t };
  const w = size ? num(size.width) : NaN;
  const h = size ? num(size.height) : NaN;
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return { ...cfg, mode: 'wh', width: w, height: h };
  return cfg;                     // null / 认不出的档 = 单尺寸，按主尺寸参数走
}

/** 一档在列表里怎么写给人看 */
export function sizeLabel(size) {
  const t = size ? num(size.times) : NaN;
  if (Number.isFinite(t) && t > 0) return `原图 × ${Math.round(t * 1000) / 1000}`;
  const w = size ? num(size.width) : NaN;
  const h = size ? num(size.height) : NaN;
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return `${Math.round(w)} × ${Math.round(h)}`;
  return '';
}

/**
 * 多尺寸列表归一：丢掉坏档、夹取值范围、去重（顺序保持用户添加的顺序）。
 * 也用来读**上个版本存下来的列表** —— 那会儿只有固定宽高档，形状一样，原样收下。
 */
export function normalizeSizeList(raw) {
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || typeof s !== 'object') continue;
    const t = num(s.times);
    if (Number.isFinite(t) && t > 0 && t <= MAX_SCALE) {
      const v = Math.round(t * 1000) / 1000;
      if (!out.some((x) => x.times === v)) out.push({ times: v });
      continue;
    }
    const w = num(s.width);
    const h = num(s.height);
    if (!(w > 0) || !(h > 0)) continue;
    const cw = clampPx(w);
    const ch = clampPx(h);
    if (!out.some((x) => x.width === cw && x.height === ch)) out.push({ width: cw, height: ch });
  }
  return out;
}

/** 锚点 → PS canvasSize 的两个枚举值 */
export function anchorEnums(anchor) {
  const a = ANCHORS.indexOf(anchor) >= 0 ? anchor : 'cm';
  const H = { l: 'left', c: 'center', r: 'right' };
  const V = { t: 'top', m: 'center', b: 'bottom' };
  return { horizontal: H[a[0]], vertical: V[a[1]] };
}

// ---- 命名 ----

/** 缩放因子写成人看的倍数：2 → '2x'，0.5 → '0.5x'，1.333 → '1.33x' */
export function formatScale(n) {
  const v = num(n);
  if (!Number.isFinite(v)) return '1x';
  return `${Math.round(v * 100) / 100}x`;
}

/**
 * 命名模板 → 文件名（不含扩展名）。支持 {name} {width} {height} {scale} {index}；
 * 不认识的变量原样留着（用户能一眼看出自己写错了，而不是被静默吞掉）。
 */
export function buildOutName(tpl, vars) {
  const v = vars || {};
  return String(tpl == null || tpl === '' ? '{name}' : tpl)
    .replace(/\{(\w+)\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(v, key) ? String(v[key]) : m));
}

/** 文件名合法化：Windows 非法字符、控制字符、结尾的点与空格、保留名、长度 */
export function sanitizeFileName(name, max = 120) {
  let s = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')      // 控制字符：一律写转义，别写字面量（编辑时会被吃掉）
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `_${s}`;
  if (s.length > max) s = s.slice(0, max).replace(/[\s.]+$/, '');
  return s || 'image';
}

/**
 * 长文件名压成「头…尾」。面板只有 300 px 宽，整名铺开要占七八行；
 * 掐头去尾只留一半的话又全是同一个前缀（都是 Modify_xxx_2026…），分不出是哪张 ——
 * 所以中间省略，头尾都留。
 */
export function ellipsizeName(name, max = 26) {
  const s = String(name == null ? '' : name);
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

/**
 * 生成一段「在资源管理器 / Finder 里打开这个文件夹」的 ExtendScript 源码。
 *
 * UXP 自己**打不开文件夹**（官方文档写明的两道限制，真机也都撞过）：
 *   - `shell.openPath` 拿路径的扩展名去对 manifest 的 launchProcess.extensions，
 *     文件夹没有扩展名，白名单里放空串照样被拦：`Extension "" is not accepted`；
 *   - `shell.openExternal` 干脆不收 `file:` 协议：`URI scheme "file" is not accepted`
 *     （文档原话：file scheme is not allowed for openExternal，叫人改用 openPath）。
 * 但 Photoshop 自带的 ExtendScript 引擎有 `Folder.execute()` —— 把这段源码写成临时
 * .jsx，用 batchPlay 的 `AdobeScriptAutomation Scripts` 播给 PS 执行，就绕过了这一层。
 *
 * 路径用 JSON.stringify 嵌进去（反斜杠、引号、换行都转好，不会拼出坏语法）；
 * execute() 万一返回 false，Windows 上再兜一层 explorer。
 */
export function buildRevealJsx(nativePath) {
  const p = String(nativePath == null ? '' : nativePath);
  if (!p) return '';
  const lit = JSON.stringify(p);
  return [
    `var p = ${lit};`,
    'var ok = false;',
    'try { ok = new Folder(p).execute(); } catch (e) { ok = false; }',
    'if (!ok && String($.os).indexOf("Windows") >= 0) {',
    '  try { app.system(\'explorer "\' + p + \'"\'); ok = true; } catch (e2) { ok = false; }',
    '}',
  ].join('\n');
}

/** 本机路径的父目录（两种分隔符都认；再往上没有了就返回空串） */
export function dirOfPath(nativePath) {
  const p = String(nativePath == null ? '' : nativePath).replace(/[\\/]+$/, '');
  const at = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  if (at <= 0) return '';
  return p.slice(0, at);
}

/**
 * 本机路径 → `getEntryWithUrl` 能吃的一串 file: URL 候选（调用方**依次试**）。
 *
 * ⚠️ 这个接口对 URL 的写法极其挑剔，而且各版本表现不一致，所以只能挨个试：
 *   - 官方示例是**单斜杠**：`file:/Users/x/Documents`（mac 路径本身以 / 开头）；
 *   - Windows 上有人报告分隔符**原样不转**的 `file:/D:\a\b` 才认；
 *   - 也有写法一个斜杠都不加：`file:D:/a/b`；
 *   - 双斜杠的 `file://D:/a/b` 是最常见的错法（`//` 后那段被当成主机名），故不列入。
 * 路径带空格 / 中文时再补一份 encodeURI 的（只对正斜杠那两种编码 —— encodeURI 会把
 * 反斜杠转成 %5C，那就把「分隔符原样」这一手给废了）。
 */
export function fileUrlsOf(nativePath) {
  const raw = String(nativePath == null ? '' : nativePath).replace(/[\\/]+$/, '');
  if (!raw) return [];
  const fwd = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const list = [`file:/${fwd}`, `file:${fwd}`, `file:/${raw.replace(/^[\\/]+/, '')}`, `file:///${fwd}`];
  for (const u of [`file:/${fwd}`, `file:${fwd}`, `file:///${fwd}`]) {
    let enc = u;
    try { enc = encodeURI(u); } catch { enc = u; }
    if (enc !== u) list.push(enc);
  }
  return list.filter((u, i) => list.indexOf(u) === i);
}

// ---- 文件收集 ----

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'psd', 'psb', 'tif', 'tiff', 'bmp'];

/** 拆出主名与扩展名（扩展名统一小写，不含点） */
export function splitName(fileName) {
  const s = String(fileName == null ? '' : fileName);
  const at = s.lastIndexOf('.');
  if (at <= 0) return { base: s, ext: '' };
  return { base: s.slice(0, at), ext: s.slice(at + 1).toLowerCase() };
}

export function isSupportedImage(fileName) {
  return IMAGE_EXTS.indexOf(splitName(fileName).ext) >= 0;
}

/**
 * 这个目录该不该进（递归时用）。
 * @param {string} relDir 相对所选根目录的路径（'/' 分隔）
 * @param {string[]} [excludeDirs] 要排除的目录名（不分大小写，任一层命中即排除）
 */
export function isExcludedDir(relDir, excludeDirs) {
  const dir = String(relDir == null ? '' : relDir).replace(/^\/+|\/+$/g, '');
  if (!dir) return false;
  const bad = (excludeDirs || []).filter(Boolean).map((d) => String(d).toLowerCase());
  return dir.split('/').some((sg) => bad.indexOf(sg.toLowerCase()) >= 0);
}

/**
 * 递归收集时要不要这个文件。
 *
 * ⚠️ excludeDirs 是刚需而不是优化：默认输出到「原目录下新建 Resized」，而「包含子文件夹」
 *    是递归扫描 —— 不排除输出目录的话，第二次运行会把上次的产物再处理一遍，越跑越多。
 *
 * @param {string} relDir  相对所选根目录的目录路径（用 '/' 分隔，根目录为 ''）
 * @param {string} fileName 文件名（含扩展名）
 * @param {{recursive?:boolean, excludeDirs?:string[]}} [opts]
 */
export function shouldCollect(relDir, fileName, opts = {}) {
  const nm = String(fileName == null ? '' : fileName);
  if (!nm || nm.charAt(0) === '.') return false;          // 隐藏文件 / macOS 的 ._ 残留
  if (!isSupportedImage(nm)) return false;
  const dir = String(relDir == null ? '' : relDir).replace(/^\/+|\/+$/g, '');
  if (dir && !opts.recursive) return false;
  return !isExcludedDir(dir, opts.excludeDirs);
}
