// PS API 封装：把一个导出任务（单图层 / 蓝色组 / 同层蓝色图层合并）导出为紧贴像素的 PNG。
//
// ⚠️ 本文件是整个插件最依赖 Photoshop 运行时的部分，无法在 Node 下单测。
//    必须在 UXP Developer Tool 里对真实 PSD 逐项验证（见 plan Task 6 Step 2）；
//    若某条 batchPlay 描述符在你的 PS 版本报错，用 UDT 控制台逐步定位微调。
//
// 隔离策略（稳健且非破坏）：
//   1) 复制整个文档到临时文档（保留结构与图层样式）
//   2) 先把所有图层设为不可见
//   3) 只显示目标路径：目标（及其祖先组）可见；合并组则显示其非红、且原本可见
//      （或 includeHidden 开启）的后代，红色后代保持隐藏 → 实现「红色从合并中排除」；
//      同层蓝色图层合并则把 task.members 里那几层一起点亮
//   4) fullBleed 开 → 先 Reveal All 让画布包含超出原画布的像素；关 → 保持原画布裁掉溢出
//      ⚠️ 顺序不能反：PS 合并图层时会丢弃画布外的像素，合并之后再扩画布就没得救了
//   5) 合并可见图层为一层（mergeVisible），图层样式在此被渲染
//   6) 按透明度 trim；全透明则判为空、跳过
//   7) 存 PNG，关闭临时文档

import { computeSymbolFrame } from '../lib/symbols.js';
import { computeBleedRect } from '../lib/export-core.js';
import { saveDocAs } from './save-image.js';

const { app, action, core } = require('photoshop');

/**
 * 按所选格式与倍率把当前临时文档导出到目标文件夹。
 * 统一 exportTask / exportSymbol 的保存出口：format ∈ png|jpg|webp，scale 为放大倍数。
 * @param {object} tempDoc 已裁好的临时文档（当前活动文档）
 * @param {object} folder  UXP folder entry
 * @param {string} fileName 不含扩展名的最终文件名
 * @param {string} format  'png' | 'jpg' | 'webp'（缺省按 png）
 * @param {number} scale   导出倍率（1 时不缩放）
 */
async function saveExport(tempDoc, folder, fileName, format, scale) {
  // 倍率缩放（放大或缩小，=1 时跳过）：用 imageSize 描述符 + 明确像素单位（规避 DOM resizeImage 的标尺单位坑）
  if (scale && scale !== 1) {
    const w = Math.max(1, Math.round(tempDoc.width * scale));
    const h = Math.max(1, Math.round(tempDoc.height * scale));
    await action.batchPlay([{
      _obj: 'imageSize',
      width: { _unit: 'pixelsUnit', _value: w },
      height: { _unit: 'pixelsUnit', _value: h },
      scaleStyles: true,
      constrainProportions: true,
      interpolation: { _enum: 'interpolationType', _value: 'automaticInterpolation' }, // 自动：放大/缩小都合适
      _options: { dialogOptions: 'dontDisplay' },
    }], {});
  }

  // 各格式的保存细节收在 save-image.js（与批量改尺寸共用同一个出口）。
  // 切图这边一直是「JPG 最高质量 + WebP 无损」，这里显式传原值，行为不变。
  await saveDocAs(tempDoc, folder, fileName, {
    format, jpgQuality: 100, webpLossless: true, overwrite: true,
  });
}

/** 递归收集文档内所有图层（含嵌套）。 */
function allLayers(container, out = []) {
  for (const l of container.layers ?? []) {
    out.push(l);
    if (l.layers) allLayers(l, out);
  }
  return out;
}

/** 在容器内按 id 递归查找活动图层。 */
function findLayerById(container, id) {
  for (const l of container.layers ?? []) {
    if (l.id === id) return l;
    if (l.layers) {
      const found = findLayerById(l, id);
      if (found) return found;
    }
  }
  return null;
}

const SNAPSHOT_NAME = 'sliceman_base';   // 回退用快照名

// ---- 整批共享的工作文档：整批只复制一次原文档并建快照；每张导出后回退到快照复用，
//      避免"每张都整篇复制"这一最大开销，显著加快切图速度。----
export async function beginExport(ps) {
  return core.executeAsModal(async () => {
    const srcDoc = Array.from(app.documents).find((d) => d.id === ps.docId) || app.activeDocument;
    const workDoc = await srcDoc.duplicate('__sliceman_work');
    // 建快照作为回退点：不受历史记录条数限制，回退比整篇复制快得多
    await action.batchPlay([{
      _obj: 'make',
      _target: [{ _ref: 'snapshotClass' }],
      from: { _ref: 'historyState', _property: 'currentHistoryState' },
      name: SNAPSHOT_NAME,
      using: { _enum: 'historyState', _value: 'fullDocument' },
      _options: { dialogOptions: 'dontDisplay' },
    }], {});
    return { workId: workDoc.id };
  }, { commandName: '准备切图' });
}

export async function endExport(ps) {
  if (ps.workId == null) return;
  try {
    await core.executeAsModal(async () => {
      const d = Array.from(app.documents).find((x) => x.id === ps.workId);
      if (d) await d.closeWithoutSaving();
    }, { commandName: '结束切图' });
  } catch { /* 忽略 */ }
}

// 把共享工作文档回退到快照（在 executeAsModal 内调用）
async function revertToBase() {
  await action.batchPlay([{
    _obj: 'select',
    _target: [{ _ref: 'snapshotClass', _name: SNAPSHOT_NAME }],
    _options: { dialogOptions: 'dontDisplay' },
  }], {});
}

/**
 * 导出单个任务到 PNG。
 * @param {object} task {type:'layer'|'merged', node, members?, pathSegments}
 *        merged 带 members = 同层蓝色图层合并（合并这几层）；不带 = 蓝色组（合并整组）
 * @param {object} ps   {docId, workId}
 * @param {object} folder UXP folder entry（用户选的目标文件夹）
 * @param {string} fileName 已去重的最终文件名（不含扩展名）
 * @param {{fullBleed:boolean, includeHidden:boolean, format?:string, scale?:number}} opts
 * @returns {Promise<'ok'|'empty'>}
 */
export async function exportTask(task, ps, folder, fileName, opts) {
  return core.executeAsModal(async () => {
    // 复用整批共享的工作文档（beginExport 已复制一次），导出后回退到快照
    const tempDoc = Array.from(app.documents).find((d) => d.id === ps.workId);
    if (!tempDoc) return 'empty';
    try {
      const target = findLayerById(tempDoc, task.node.id);
      if (!target) return 'empty';

      // 2) 全部隐藏
      for (const l of allLayers(tempDoc)) l.visible = false;

      // 3) 显示目标祖先组
      let p = target.parent;
      while (p && p.id !== tempDoc.id && p.layers) {
        p.visible = true;
        p = p.parent;
      }

      // 顺带记下这一轮真正参与合并的层，第 4 步算扩画布范围要用（省一次全量遍历）
      const shown = [];
      if (task.type === 'layer') {
        target.visible = true;
        shown.push(target);
      } else if (task.members) {
        // 同层蓝色图层合并：把这几层一起点亮，合并成一张。它们是同一个容器下的兄弟层，
        // 祖先组上面已经显示过了；红色 / 隐藏的在 walk 里就没进 members，这里不用再筛。
        for (const m of task.members) {
          const live = findLayerById(tempDoc, m.id);
          if (!live) continue;
          live.visible = true;
          shown.push(live);
        }
      } else {
        // 合并组：显示非红、原本可见（或 includeHidden）的后代。
        // 遇到红色节点直接停止下探（不进入其子树），使排除不依赖 PS 的组可见性门控。
        target.visible = true;
        const prune = (n) => {
          if (n.id !== task.node.id) {               // 组本身已在上面置为可见
            const live = findLayerById(tempDoc, n.id);
            if (!live) return;
            if (n.label === 'red') { live.visible = false; return; }  // 红色排除，且不下探
            if (n.visible || opts.includeHidden) { live.visible = true; shown.push(live); }
          }
          for (const c of n.children ?? []) prune(c);
        };
        prune(task.node);
      }

      // 4) 超出画布处理 —— 必须在合并【之前】做：Photoshop 合并图层时会把画布外的
      //    像素直接丢掉，合并完再扩画布已经晚了，数据没了。
      //    ⚠️ 但不能用 revealAll：它连【隐藏】图层也算进去。真机实测——200×200 的画布里
      //    放一个被挪到 (3000,3000) 且【已隐藏】的层，revealAll 把画布撑到 3080×3080。
      //    而这里的工作文档装着整个 PSD 的图层（只是被隐藏），于是每导出一张都会把画布
      //    撑到覆盖全 PSD，后面的 mergeVisible 与 trim 全在这张巨图上做 —— 切图奇慢的真因。
      //    改成只按【这一轮真会合并的那些层】的并集扩：crop 到超出画布的矩形会补透明，
      //    等价于一次「只针对目标」的 Reveal All，画布始终是紧的。
      if (opts.fullBleed) {
        const rect = bleedRect(tempDoc, shown);
        if (rect) await tempDoc.crop(rect);
      }
      // fullBleed 关：不扩画布，保持原尺寸，溢出像素被合并裁掉

      // 5) 合并可见图层为一层（渲染图层样式）
      await action.batchPlay([{ _obj: 'mergeVisible' }], {});

      // 6) 空图层判断：合并结果无像素则跳过
      const merged = tempDoc.activeLayers[0];
      const b = merged?.bounds;
      if (!b || b.right - b.left <= 0 || b.bottom - b.top <= 0) {
        return 'empty';
      }

      // 按透明度 trim
      await action.batchPlay([{
        _obj: 'trim',
        trimBasedOn: { _enum: 'trimBasedOn', _value: 'transparency' },
        top: true, bottom: true, left: true, right: true,
      }], {});

      // 7) 按所选格式与倍率导出
      await saveExport(tempDoc, folder, fileName, opts.format, opts.scale);
      return 'ok';
    } finally {
      await revertToBase();   // 回退到快照，供下一张复用（不再关闭/重建文档）
    }
  }, { commandName: `导出 ${fileName}` });
}

/**
 * 从 DOM 读出这一轮参与合并的层的边界，交给纯逻辑算扩画布的目标矩形。
 * 组容器不参与：组的 bounds 会把隐藏子层也算进来，会把框撑歪。
 * @param {object} doc 工作文档
 * @param {Array<object>} shown 这一轮被置为可见的层（可能混着组容器）
 * @returns {?{left:number, top:number, right:number, bottom:number}} 不需要扩时为 null
 */
function bleedRect(doc, shown) {
  const rects = [];
  for (const l of shown) {
    if (!l || l.layers) continue;                    // 组容器跳过
    const b = l.bounds;
    if (!b) continue;
    rects.push({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
  }
  return computeBleedRect(rects, doc.width, doc.height);
}

/** 取多个矩形的并集。 */
function unionBounds(a, b) {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/**
 * 导出单个 Symbol 到 PNG（以「定位格」为基准框，四边对称外扩最大超出量）。
 * @param {object} task {type:'symbol', node, dinweigeIds, pathSegments}
 *        node 为 symbol 范围节点：组节点（有 id）或根伪节点（id 为空 → 整张画布）。
 * @param {object} ps   {docId, workId}
 * @param {object} folder UXP folder entry
 * @param {string} fileName 已去重的最终文件名（不含扩展名）
 * @param {{includeHidden:boolean, format?:string, scale?:number}} opts
 * @returns {Promise<'ok'|'empty'>}
 */
export async function exportSymbol(task, ps, folder, fileName, opts) {
  return core.executeAsModal(async () => {
    // 复用整批共享的工作文档（beginExport 已复制一次），导出后回退到快照
    const tempDoc = Array.from(app.documents).find((d) => d.id === ps.workId);
    if (!tempDoc) return 'empty';
    try {
      const dinweige = new Set(task.dinweigeIds);

      // 1) 读定位格边界 G（可见性无关；多个定位格取并集）
      let G = null;
      for (const id of task.dinweigeIds) {
        const dl = findLayerById(tempDoc, id);
        if (!dl) continue;
        const b = dl.bounds;
        const r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
        G = G ? unionBounds(G, r) : r;
      }
      if (!G) return 'empty';                       // 找不到定位格（异常），跳过

      // 2) 全部隐藏
      for (const l of allLayers(tempDoc)) l.visible = false;

      // 3) 组范围：先显示范围组及其祖先；根范围无需（根恒可见）
      if (task.node.id != null) {
        const scope = findLayerById(tempDoc, task.node.id);
        if (scope) {
          scope.visible = true;
          let p = scope.parent;
          while (p && p.id !== tempDoc.id && p.layers) { p.visible = true; p = p.parent; }
        }
      }

      // 4) 显示内容：范围内除定位格外，遵守 红=排除、隐藏跳过（除非 includeHidden）
      const prune = (n) => {
        if (dinweige.has(n.id)) return;             // 定位格：永远不显示、不合并
        if (n.label === 'red') return;              // 红色：排除且不下探
        if (!(n.visible || opts.includeHidden)) return; // 隐藏跳过
        const live = findLayerById(tempDoc, n.id);
        if (live) live.visible = true;
        for (const c of n.children ?? []) prune(c);
      };
      for (const c of task.node.children ?? []) prune(c);

      // 5) 合并可见内容为一层
      await action.batchPlay([{ _obj: 'mergeVisible' }], {});

      // 6) 读内容边界 C = 合并后"仍可见的像素图层"的并集（跳过组容器）。
      //    不用 activeLayers[0]：它可能取到隐藏的其它组，导致 C 落到别处、裁框错乱。
      //    跳过组容器：组的 bounds 可能含隐藏子层（如定位格/辅助层），会污染 C。
      let C = null;
      for (const l of allLayers(tempDoc)) {
        if (!l.visible) continue;
        if (l.layers) continue;                      // 组容器不算，只取像素图层（合并结果）
        const b = l.bounds;
        if (!b) continue;
        const r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
        if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue;
        C = C ? unionBounds(C, r) : r;
      }
      if (!C) return 'empty';                        // 无可见内容，跳过

      // 7) 以定位格为基准算导出框（E=0 时即定位格原尺寸），裁到该固定框（补透明、不 trim）
      const f = computeSymbolFrame(G, C);
      const rect = {
        left: Math.round(f.left),
        top: Math.round(f.top),
        right: Math.round(f.right),
        bottom: Math.round(f.bottom),
      };
      await tempDoc.crop(rect);   // DOM 裁切：超出画布处补透明

      // 8) 按所选格式与倍率导出
      await saveExport(tempDoc, folder, fileName, opts.format, opts.scale);
      return 'ok';
    } finally {
      await revertToBase();   // 回退到快照，供下一张复用（不再关闭/重建文档）
    }
  }, { commandName: `导出 Symbol ${fileName}` });
}
