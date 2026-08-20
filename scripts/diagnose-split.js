// 智能分割分步诊断：在 UXP Developer Tool 控制台里整段粘贴运行。
// 先在你的 PSD 里选中要分割的那个像素图层，再运行。会把每一步结果打到控制台。
const { app, action, core, imaging } = require('photoshop');

(async () => {
  const log = (...a) => console.log('[分割诊断]', ...a);
  try {
    const srcDoc = app.activeDocument;
    if (!srcDoc) return log('❌ 没有打开的文档');
    const sel = Array.from(srcDoc.activeLayers || []);
    log('选中图层:', sel.map(l => `${l.name}(${l.kind}, id=${l.id})`));
    if (!sel.length) return log('❌ 请先选中一个像素图层');
    const srcLayer = sel[0];
    if (srcLayer.kind === 'group') return log('❌ 选中的是组，请选像素图层');

    await core.executeAsModal(async () => {
      // 1) 复制工作文档
      const workDoc = await srcDoc.duplicate('__diag_split');
      app.activeDocument = workDoc;
      log('✅ 1 复制工作文档 ok, 活动文档 =', app.activeDocument.name);

      // 2) 找到目标图层
      const find = (c, id) => { for (const l of c.layers ?? []) { if (l.id === id) return l; if (l.layers) { const f = find(l, id); if (f) return f; } } return null; };
      const target = find(workDoc, srcLayer.id);
      log(target ? '✅ 2 找到目标图层' : '❌ 2 工作文档里找不到目标图层 id=' + srcLayer.id);
      if (!target) return;

      // 3) 隐藏其它、拍平
      const all = []; const walk = c => { for (const l of c.layers ?? []) { all.push(l); if (l.layers) walk(l); } };
      walk(workDoc);
      for (const l of all) l.visible = false;
      target.visible = true;
      await action.batchPlay([{ _obj: 'mergeVisible' }], {});
      const flat = workDoc.layers[0];
      log('✅ 3 拍平 ok, 拍平层 =', flat && flat.name, 'bounds=', JSON.stringify(flat && flat.bounds));

      // 4) 读像素
      const b = flat.bounds;
      const w = b.right - b.left, h = b.bottom - b.top;
      log('图层尺寸', w, 'x', h);
      if (w <= 0 || h <= 0) return log('❌ 4 图层为空');
      const px = await imaging.getPixels({ layerID: flat.id, sourceBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } });
      const data = await px.imageData.getData();
      await px.imageData.dispose();
      log('✅ 4 读像素 ok, 字节数 =', data.length, '预期~', w * h * 4);

      // 5) 测一次选区 + copy + paste
      try {
        await action.batchPlay([
          { _obj: 'select', _target: [{ _ref: 'layer', _id: flat.id }], makeVisible: false, _options: { dialogOptions: 'dontDisplay' } },
          { _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }],
            to: { _obj: 'rectangle',
              top: { _unit: 'pixelsUnit', _value: b.top }, left: { _unit: 'pixelsUnit', _value: b.left },
              bottom: { _unit: 'pixelsUnit', _value: Math.min(b.top + 50, b.bottom) }, right: { _unit: 'pixelsUnit', _value: Math.min(b.left + 50, b.right) } },
            _options: { dialogOptions: 'dontDisplay' } },
        ], {});
        log('✅ 5a 建选区 ok');
        await action.batchPlay([{ _obj: 'copyEvent' }], {});
        log('✅ 5b copyEvent ok');
        const pasted = await action.batchPlay([{ _obj: 'paste' }], {});
        log('✅ 5c paste ok, 返回 =', JSON.stringify(pasted && pasted[0]));
        const newLayer = workDoc.activeLayers[0];
        log('   粘贴后活动图层 =', newLayer && newLayer.name, 'id=', newLayer && newLayer.id);

        // 6) 测跨文档 duplicate 回原文档
        try {
          const copied = await newLayer.duplicate(srcLayer, 'placeBefore');
          log('✅ 6 跨文档 duplicate ok, 新层 =', copied && copied.name);
        } catch (e6) {
          log('❌ 6 跨文档 duplicate 失败:', e6.message);
        }
      } catch (e5) {
        log('❌ 5 选区/copy/paste 失败:', e5.message);
      }
    }, { commandName: '分割诊断' });

    log('—— 诊断结束（临时文档 __diag_split 仍在，可手动关闭）——');
  } catch (e) {
    console.log('[分割诊断] ❌ 顶层异常:', e.message, e.stack);
  }
})();
