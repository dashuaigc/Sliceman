// PS API 封装：批量改尺寸 —— 收集文件、静默打开、按计划改尺寸、按格式另存、关掉。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测。
//    所有算式都在 src/lib/resize-core.js 里（已单测）；这里只负责把算好的整数像素
//    交给 PS 执行 —— imageSize / canvasSize 一律传绝对像素、constrainProportions 恒 false。
//
// 分工：**策略在面板，机制在这里**。命名、去重、同名怎么办、往哪个文件夹写，全由面板通过
//   job.resolve 回调决定（它要读目录、建子文件夹，天然是异步的）；本文件只管
//   「打开 → 改 → 存 → 关」这条机械流程，以及一个来源项处理失败不拖累其它项。
//
// 三个真机上必须绕开的坑：
//   1) 打开外部文件走 batchPlay 的 open + dontDisplay —— app.open() 遇到「JPEG 缺色彩配置」
//      「PSD 兼容性」这类原生弹窗会把整批任务卡死在那儿等人点确定。
//   2) 扩画布前必须先把「背景」图层转成普通图层，否则 canvasSize 扩出来的边填的是
//      背景色而不是透明。
//   3) 来源是已打开的文档时先 duplicate 再动手，原文档一个像素都不碰。

import {
  planResize, sizeCfg, anchorEnums, shouldCollect, isExcludedDir, buildRevealJsx,
  dirOfPath, fileUrlsOf,
} from '../lib/resize-core.js';
import { saveDocAs } from './save-image.js';
import { hexToRgb } from './table-maker.js';

const { app, action, core } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

const WORK_DOC = '__sliceman_resize';
const SNAP = 'sliceman_resize_base';
const REVEAL_JSX = 'sliceman-reveal.jsx';   // 写在插件临时目录里，每次覆盖
const dontDisplay = { dialogOptions: 'dontDisplay' };
const px = (v) => ({ _unit: 'pixelsUnit', _value: v });

function n(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v._value === 'number') return v._value;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : NaN;
}

const sizeOf = (doc) => ({ width: Math.round(n(doc.width)), height: Math.round(n(doc.height)) });

function msgOf(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

// ---- 描述符 ----

const imageSizeDesc = (w, h, interpolation) => ({
  _obj: 'imageSize',
  width: px(w),
  height: px(h),
  scaleStyles: true,
  constrainProportions: false,        // 比例由插件算好，绝不让 PS 自己推
  interpolation: { _enum: 'interpolationType', _value: interpolation || 'automaticInterpolation' },
  _options: dontDisplay,
});

const canvasSizeDesc = (w, h, anchor) => ({
  _obj: 'canvasSize',
  width: px(w),
  height: px(h),
  horizontal: { _enum: 'horizontalLocation', _value: anchor.horizontal },
  vertical: { _enum: 'verticalLocation', _value: anchor.vertical },
  _options: dontDisplay,
});

// 「背景图层 → 普通图层」（图层面板里双击背景层那一步）
const layerFromBackground = {
  _obj: 'set',
  _target: [{ _ref: 'layer', _property: 'background' }],
  to: {
    _obj: 'layer',
    opacity: { _unit: 'percentUnit', _value: 100 },
    mode: { _enum: 'blendMode', _value: 'normal' },
  },
  _options: dontDisplay,
};

// 满画布纯色图层（不带 shape 的 solidColorLayer 就是铺满画布）
// ⚠️ PS 的 RGBColor 里绿色分量键名就叫 grain，不是 green（与 table-maker.js 同）
const solidFillDesc = (rgb) => ({
  _obj: 'make',
  _target: [{ _ref: 'contentLayer' }],
  using: {
    _obj: 'contentLayer',
    type: { _obj: 'solidColorLayer', color: { _obj: 'RGBColor', red: rgb.r, grain: rgb.g, blue: rgb.b } },
  },
  _options: dontDisplay,
});

const makeSnapshot = {
  _obj: 'make',
  _target: [{ _ref: 'snapshotClass' }],
  from: { _ref: 'historyState', _property: 'currentHistoryState' },
  name: SNAP,
  using: { _enum: 'historyState', _value: 'fullDocument' },
  _options: dontDisplay,
};

const revertSnapshot = {
  _obj: 'select',
  _target: [{ _ref: 'snapshotClass', _name: SNAP }],
  _options: dontDisplay,
};

const openDesc = (token) => ({
  _obj: 'open',
  null: { _path: token, _kind: 'local' },
  _options: dontDisplay,
});

// ---- 文件收集 ----

/**
 * 递归收集文件夹里的图片。
 * @param {object} root UXP folder entry
 * @param {{recursive?:boolean, excludeDirs?:string[], limit?:number}} opts
 * @returns {Promise<{files:Array<{entry:object, relDir:string, name:string}>, skippedDirs:string[]}>}
 *          relDir 是相对 root 的目录路径（'/' 分隔，根目录为 ''），用于「保持原文件夹结构」
 */
export async function collectImageFiles(root, opts = {}) {
  const files = [];
  const skippedDirs = [];
  const limit = opts.limit || 5000;

  const walk = async (folder, relDir, depth) => {
    if (files.length >= limit || depth > 12) return;   // 防御超深目录 / 目录环
    let entries = [];
    try { entries = await folder.getEntries(); } catch { return; }
    for (const e of entries) {
      if (files.length >= limit) return;
      if (e.isFolder) {
        if (!opts.recursive) continue;
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        // 输出目录必须排除：否则第二次运行会把上次的产物再处理一遍，越跑越多
        if (isExcludedDir(rel, opts.excludeDirs)) { skippedDirs.push(rel); continue; }
        await walk(e, rel, depth + 1);
        continue;
      }
      if (shouldCollect(relDir, e.name, opts)) files.push({ entry: e, relDir, name: e.name });
    }
  };

  await walk(root, '', 0);
  return { files, skippedDirs };
}

/** 试一串 URL，第一个换回入口的就是它；全不行则返回每一次的原话 */
async function entryByUrls(urls) {
  const tried = [];
  for (const url of urls) {
    try {
      const e = await uxpFs.getEntryWithUrl(url);
      if (e) return { entry: e, tried };
      tried.push(`${url} 没有返回入口`);
    } catch (e) {
      tried.push(`${url} → ${msgOf(e)}`);
    }
  }
  return { entry: null, tried };
}

/**
 * 取某个文件所在的文件夹入口（「位置」没指定时就往这儿写）。
 *
 * 多选文件时插件手里只有文件入口，没有它的父目录 —— UXP 的权限是按入口授予的：
 * 用户挑了文件，就只授了这些文件。按路径反查父目录要 manifest 里的
 * `localFileSystem: "fullAccess"`，URL 形式还得挨个试（见 resize-core 的 fileUrlsOf：
 * 单斜杠 / 无斜杠 / 分隔符原样 / 三斜杠 / 转义过的，各版本认的不是同一种）。
 *
 * @returns {Promise<{folder:object|null, reason:string}>} 拿不到时 folder 为 null，
 *   reason 里是**每一次尝试的原话**，末尾再加一句「原文件自身解析得到吗」的探测结论 ——
 *   解析得到就说明 fullAccess 在生效、是目录这一层被拒；连原文件也解析不到就是权限没生效
 *   （manifest 的权限是装载插件时读的，热重载 JS 不算）。真机上就这一个反馈通道，
 *   含糊一句「定位不到」等于下一轮还得靠猜。
 */
export async function parentFolderOf(entry) {
  if (!entry) return { folder: null, reason: '没有文件入口' };
  if (typeof entry.getParent === 'function') {
    try { const p = await entry.getParent(); if (p) return { folder: p, reason: '' }; } catch { /* 换下一招 */ }
  }
  const path = entry.nativePath || '';
  const dir = dirOfPath(path);
  if (!dir) return { folder: null, reason: `文件入口没有可用的本机路径（${path || '空'}）` };
  const got = await entryByUrls(fileUrlsOf(dir));
  if (got.entry) return { folder: got.entry, reason: '' };
  const probe = await entryByUrls(fileUrlsOf(path));
  got.tried.push(probe.entry
    ? '原文件自身解析得到 → 是目录这一层被拒'
    : '原文件自身也解析不到 → 更像是 fullAccess 没生效（manifest 的权限是装载插件时读的，'
      + '在 UDT 里 Remove → Add 重装插件并重启 Photoshop 再试）');
  return { folder: null, reason: got.tried.join('；') };
}

/**
 * 在系统文件管理器里打开一个文件夹。
 *
 * ⚠️ UXP 自己办不到这件事（见 resize-core.js 的 buildRevealJsx 注释：openPath 卡扩展名、
 *    openExternal 不收 file: 协议），所以**先走 PS 的 ExtendScript 桥**：把一段
 *    `Folder(p).execute()` 写成临时 .jsx，用 batchPlay 的 `AdobeScriptAutomation Scripts`
 *    播给 PS 执行 —— 这条路不经过 UXP 的 launchProcess 关卡。
 *    脚本桥失败才退回 `shell.openPath`（Mac 上官方文档说文件夹可以，Windows 上会被拦；
 *    它失败时不抛异常，而是 resolve 出一句错误描述，所以必须看返回值）。
 *
 * @returns {Promise<{ok:boolean, why:string[]}>} why 收着每一条失败原因，面板照原样报出来
 */
export async function revealFolder(nativePath) {
  const why = [];
  const src = buildRevealJsx(nativePath);
  if (!src) return { ok: false, why: ['没有可打开的路径'] };
  try {
    const tmp = await uxpFs.getTemporaryFolder();
    const file = await tmp.createFile(REVEAL_JSX, { overwrite: true });
    await file.write(src);
    const jsxPath = file.nativePath || '';
    if (!jsxPath) throw new Error('临时脚本拿不到本机路径');
    await core.executeAsModal(async () => {
      const res = await action.batchPlay([{
        _obj: 'AdobeScriptAutomation Scripts',
        javaScriptName: jsxPath,
        javaScriptMessage: 'sliceman-reveal',
        _options: dontDisplay,
      }], {});
      // batchPlay 有时不抛，而是把错误塞在结果里（和 shell 那两个接口一个毛病）
      const bad = (res || []).find((r) => r && r.message);
      if (bad) throw new Error(bad.message);
    }, { commandName: '打开输出文件夹' });
    return { ok: true, why };
  } catch (e) {
    why.push(`PS 脚本桥: ${msgOf(e)}`);
  }
  try {
    const { shell } = require('uxp');
    if (shell && typeof shell.openPath === 'function') {
      const r = await shell.openPath(nativePath, '打开这一批图片的输出文件夹');
      if (!r) return { ok: true, why };
      why.push(`openPath: ${r}`);
    } else {
      why.push('openPath: 当前 UXP 版本没有这个接口');
    }
  } catch (e) {
    why.push(`openPath: ${msgOf(e)}`);
  }
  return { ok: false, why };
}

/** 清掉可能遗留的临时文档（上次异常退出留下的） */
export async function closeStrayResizeDocs() {
  try {
    await core.executeAsModal(async () => {
      for (const d of Array.from(app.documents)) {
        if (d.name === WORK_DOC) { try { await d.closeWithoutSaving(); } catch { /* 忽略 */ } }
      }
    }, { commandName: '清理改尺寸临时文档' });
  } catch { /* 忽略 */ }
}

// ---- 执行 ----

/** 扩画布前把背景层转普通层，否则补出来的边是背景色而不是透明 */
async function unBackground(doc) {
  const has = (doc.layers || []).some((l) => l.isBackgroundLayer);
  if (!has) return;
  try { await action.batchPlay([layerFromBackground], {}); } catch { /* 转不了就只能填背景色，不中断 */ }
}

/** 在最底下垫一层纯色（补出来的透明边要变成白/黑/自定义色时用） */
async function fillBottom(doc, rgb) {
  await action.batchPlay([solidFillDesc(rgb)], {});
  const fill = (doc.activeLayers || [])[0];
  const layers = doc.layers || [];
  const bottom = layers[layers.length - 1];
  if (fill && bottom && fill.id !== bottom.id) {
    try { await fill.moveBelow(bottom); } catch { /* 压不到底也比没有填充好 */ }
  }
}

/** 把一份尺寸计划落到当前文档上（imageSize → 必要时 canvasSize → 必要时垫底色） */
async function applyPlan(doc, plan, cfg, job) {
  const cur = sizeOf(doc);
  if (plan.image.width !== cur.width || plan.image.height !== cur.height) {
    await action.batchPlay([imageSizeDesc(plan.image.width, plan.image.height, job.interpolation)], {});
  }
  if (plan.op !== 'none') {
    await unBackground(doc);
    await action.batchPlay([canvasSizeDesc(plan.canvas.width, plan.canvas.height, anchorEnums(cfg.anchor))], {});
    // 纯裁切不会露出空白，只有补边（pad）或一轴补一轴裁（mix）才需要填充
    if (plan.op !== 'crop' && job.fillHex) {
      const rgb = hexToRgb(job.fillHex);
      if (rgb) await fillBottom(doc, rgb);
    }
  }
}

/**
 * 处理一个来源项（一个文件 / 一个已打开的文档）：打开 → 逐个目标尺寸改并存 → 关掉。
 *
 * @param {object} src  { kind:'file', entry, relDir?, name } 或 { kind:'doc', docId }
 * @param {object} job
 *   sizes    多尺寸输出的每一档：{width,height} 固定宽高 / {times} 按原图倍率 /
 *            null = 用 cfg 里的模式参数（单尺寸）。每一档怎么折成 cfg 见 resize-core 的 sizeCfg
 *   cfg      resize-core 的参数（面板已归一）
 *   interpolation  PS 的重采样枚举值
 *   fillHex  空白区域填充色；null / '' = 透明
 *   resolve  async ({src, srcSize, plan, size, index}) => {folder, fileName, save} | null
 *            返回 null 表示这一档不输出（例如同名策略选了跳过）
 *   onStep   (msg)=>void 分步回调（失败时面板能报出「最后成功的一步」）
 * @returns {Promise<{srcSize:{width,height}|null,
 *                    results:Array<{status:'ok'|'skip'|'fail', reason?:string, name?:string, plan?:object}>}>}
 */
export async function processOne(src, job) {
  const onStep = job.onStep || (() => {});
  const sizes = (job.sizes && job.sizes.length) ? job.sizes : [null];

  return core.executeAsModal(async () => {
    let doc = null;
    try {
      // 1) 拿到要动手的文档
      if (src.kind === 'file') {
        doc = await openEntry(src.entry);
        if (!doc) throw new Error('打开失败');
      } else {
        const orig = Array.from(app.documents).find((d) => d.id === src.docId);
        if (!orig) throw new Error('文档已经关闭');
        app.activeDocument = orig;
        doc = await orig.duplicate(WORK_DOC);     // 副本上动手，原文档不碰
      }
      app.activeDocument = doc;
      const srcSize = sizeOf(doc);
      if (!(srcSize.width > 0) || !(srcSize.height > 0)) throw new Error('读不到图片尺寸');
      onStep(`打开 ok ${srcSize.width}x${srcSize.height}`);

      // 2) 多尺寸：建快照，每档存完回退 —— 一个文件只打开一次
      const multi = sizes.length > 1;
      if (multi) {
        try { await action.batchPlay([makeSnapshot], {}); } catch { /* 建不了快照就按单档跑 */ }
      }

      const results = [];
      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        const cfg = sizeCfg(job.cfg, size);
        const plan = planResize(srcSize, cfg);
        if (plan.skip) {
          results.push({ status: 'skip', reason: plan.skip, plan, size });
          continue;
        }
        let dest = null;
        try {
          dest = await job.resolve({ src, srcSize, plan, size, index: i });
        } catch (e) {
          results.push({ status: 'fail', reason: msgOf(e), plan, size });
          continue;
        }
        if (!dest) {
          results.push({ status: 'skip', reason: 'exists', plan, size });
          continue;
        }
        try {
          await applyPlan(doc, plan, cfg, job);
          onStep(`改尺寸 ok ${plan.image.width}x${plan.image.height} / 画布 ${plan.canvas.width}x${plan.canvas.height}`);
          const saved = await saveDocAs(doc, dest.folder, dest.fileName, dest.save);
          onStep(`保存 ok ${saved.name}`);
          results.push({ status: 'ok', name: saved.name, plan, size });
        } catch (e) {
          results.push({ status: 'fail', reason: msgOf(e), plan, size });
        } finally {
          if (multi && i < sizes.length - 1) {
            try { await action.batchPlay([revertSnapshot], {}); } catch { /* 回退失败：下一档会基于当前状态，如实记录 */ }
          }
        }
      }
      return { srcSize, results };
    } finally {
      // 无论成功失败：把我们打开/复制出来的文档关掉，绝不留窗口（也绝不保存）
      if (doc) { try { await doc.closeWithoutSaving(); } catch { /* 忽略 */ } }
    }
  }, { commandName: '批量改尺寸' });
}

/** 静默打开一个文件（压掉原生弹窗），拿不到返回值就取当前活动文档 */
async function openEntry(entry) {
  try {
    const token = await uxpFs.createSessionToken(entry);
    await action.batchPlay([openDesc(token)], {});
    return app.activeDocument;
  } catch (e) {
    // 兜底：DOM 的 open（可能弹原生对话框，但至少能打开）
    try {
      const d = await app.open(entry);
      return d || app.activeDocument;
    } catch (e2) {
      throw new Error(`${msgOf(e2)}（静默打开也失败：${msgOf(e)}）`);
    }
  }
}
