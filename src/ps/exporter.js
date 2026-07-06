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

const { app, action, core } = require('photoshop');
const uxpFs = require('uxp').storage.localFileSystem;

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

/** 遍历纯数据节点子树。 */
function eachNode(node, fn) {
  fn(node);
  for (const c of node.children ?? []) eachNode(c, fn);
}

/**
 * 导出单个任务到 PNG。
 * @param {object} task {type:'layer'|'merged', node, pathSegments}
 * @param {object} ps   {docId, fileName}
 * @param {object} folder UXP folder entry（用户选的目标文件夹）
 * @param {string} fileName 已去重的最终文件名（不含扩展名）
 * @param {{fullBleed:boolean, includeHidden:boolean}} opts
 * @returns {Promise<'ok'|'empty'>}
 */
export async function exportTask(task, ps, folder, fileName, opts) {
  return core.executeAsModal(async () => {
    const srcDoc = app.activeDocument;

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
        // 合并组：显示非红、原本可见（或 includeHidden）的后代
        target.visible = true;
        eachNode(task.node, (n) => {
          if (n.id === task.node.id) return;         // 组本身已处理
          const live = findLayerById(tempDoc, n.id);
          if (!live) return;
          if (n.label === 'red') { live.visible = false; return; }  // 红色排除
          if (n.visible || opts.includeHidden) live.visible = true;
        });
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

      // 7) 存 PNG
      const file = await folder.createFile(`${fileName}.png`, { overwrite: true });
      await tempDoc.saveAs.png(file, {}, true);   // asCopy=true
      return 'ok';
    } finally {
      await tempDoc.closeWithoutSaving();
    }
  }, { commandName: `导出 ${fileName}` });
}
