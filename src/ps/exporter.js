// PS API 封装：把一个导出任务（单图层或蓝色合并组）导出为紧贴像素的 PNG。
//
// ⚠️ 本文件是整个插件最依赖 Photoshop 运行时的部分，无法在 Node 下单测。
//    必须在 UXP Developer Tool 里对真实 PSD 逐项验证（见 plan Task 6 Step 2）；
//    若某条 batchPlay 描述符在你的 PS 版本报错，用 UDT 控制台逐步定位微调。
//
// 隔离策略（稳健且非破坏）：
//   1) 复制整个文档到临时文档（保留结构与图层样式）
//   2) 先把所有图层设为不可见
//   3) 只显示目标路径：目标（及其祖先组）可见；合并组则显示其非红、且原本可见
//      （或 includeHidden 开启）的后代，红色后代保持隐藏 → 实现「红色从合并中排除」
//   4) 合并可见图层为一层（mergeVisible），图层样式在此被渲染
//   5) fullBleed 开 → Reveal All 让画布包含超出原画布的像素；关 → 保持原画布裁掉溢出
//   6) 按透明度 trim；全透明则判为空、跳过
//   7) 存 PNG，关闭临时文档

import { computeSymbolFrame } from '../lib/symbols.js';

const { app, action, core } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

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
  // 倍率放大：用 imageSize 描述符 + 明确像素单位（规避 DOM resizeImage 的标尺单位坑）
  if (scale && scale > 1) {
    const w = Math.max(1, Math.round(tempDoc.width * scale));
    const h = Math.max(1, Math.round(tempDoc.height * scale));
    await action.batchPlay([{
      _obj: 'imageSize',
      width: { _unit: 'pixelsUnit', _value: w },
      height: { _unit: 'pixelsUnit', _value: h },
      scaleStyles: true,
      constrainProportions: true,
      interpolation: { _enum: 'interpolationType', _value: 'bicubicSmoother' },
      _options: { dialogOptions: 'dontDisplay' },
    }], {});
  }

  const ext = format === 'jpg' ? 'jpg' : format === 'webp' ? 'webp' : 'png';
  const file = await folder.createFile(`${fileName}.${ext}`, { overwrite: true });

  if (format === 'jpg') {
    // JPG 无透明通道，PS 会以白底合并（选 JPG 视为可接受）
    await tempDoc.saveAs.jpg(file, { quality: 12 }, true);   // quality 0-12，取最高
  } else if (format === 'webp') {
    // DOM saveAs 不支持 WebP，用 batchPlay save；先建好精确文件名再传 sessionToken，避免 PS 追加 "copy"
    const token = await uxpFs.createSessionToken(file);
    await action.batchPlay([{
      _obj: 'save',
      as: {
        _obj: 'WebPFormat',
        compression: { _enum: 'WebPCompression', _value: 'compressionLossless' }, // 无损，保留透明
        includeXMPData: false, includeEXIFData: false, includePsExtras: false,
      },
      in: { _path: token, _kind: 'local' },
      documentID: tempDoc.id,
      copy: true,
      lowerCase: true,
      saveStage: { _enum: 'saveStageType', _value: 'saveBegin' },
      _options: { dialogOptions: 'dontDisplay' },
    }], {});
  } else {
    await tempDoc.saveAs.png(file, {}, true);   // asCopy=true
  }
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

/**
 * 导出单个任务到 PNG。
 * @param {object} task {type:'layer'|'merged', node, pathSegments}
 * @param {object} ps   {docId, fileName}
 * @param {object} folder UXP folder entry（用户选的目标文件夹）
 * @param {string} fileName 已去重的最终文件名（不含扩展名）
 * @param {{fullBleed:boolean, includeHidden:boolean, format?:string, scale?:number}} opts
 * @returns {Promise<'ok'|'empty'>}
 */
export async function exportTask(task, ps, folder, fileName, opts) {
  return core.executeAsModal(async () => {
    // 按原文档 id 精确取源，避免误取到遗留的临时文档
    const srcDoc = Array.from(app.documents).find((d) => d.id === ps.docId) || app.activeDocument;

    // 1) 复制整个文档
    const tempDoc = await srcDoc.duplicate(`__sliceman_${fileName}`);
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

      if (task.type === 'layer') {
        target.visible = true;
      } else {
        // 合并组：显示非红、原本可见（或 includeHidden）的后代。
        // 遇到红色节点直接停止下探（不进入其子树），使排除不依赖 PS 的组可见性门控。
        target.visible = true;
        const prune = (n) => {
          if (n.id !== task.node.id) {               // 组本身已在上面置为可见
            const live = findLayerById(tempDoc, n.id);
            if (!live) return;
            if (n.label === 'red') { live.visible = false; return; }  // 红色排除，且不下探
            if (n.visible || opts.includeHidden) live.visible = true;
          }
          for (const c of n.children ?? []) prune(c);
        };
        prune(task.node);
      }

      // 4) 合并可见图层为一层（渲染图层样式）
      await action.batchPlay([{ _obj: 'mergeVisible' }], {});

      // 5) 超出画布处理
      if (opts.fullBleed) {
        // Reveal All：扩展画布以包含所有像素（含画布外）
        await action.batchPlay([{ _obj: 'revealAll' }], {});
      }
      // fullBleed 关：不 Reveal All，画布保持原尺寸，溢出像素被裁掉

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
      await tempDoc.closeWithoutSaving();
    }
  }, { commandName: `导出 ${fileName}` });
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
 * @param {object} ps   {docId, fileName}
 * @param {object} folder UXP folder entry
 * @param {string} fileName 已去重的最终文件名（不含扩展名）
 * @param {{includeHidden:boolean, format?:string, scale?:number}} opts
 * @returns {Promise<'ok'|'empty'>}
 */
export async function exportSymbol(task, ps, folder, fileName, opts) {
  return core.executeAsModal(async () => {
    // 按原文档 id 精确取源，避免误取到遗留的临时文档
    const srcDoc = Array.from(app.documents).find((d) => d.id === ps.docId) || app.activeDocument;
    const tempDoc = await srcDoc.duplicate(`__sliceman_${fileName}`);
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
      await tempDoc.closeWithoutSaving();
    }
  }, { commandName: `导出 Symbol ${fileName}` });
}
