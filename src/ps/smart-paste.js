// 直接使用 Photoshop 的图层剪贴板；不提取/覆盖 fx、不创建会话样板。
const OPTIONS = { dialogOptions: 'silent' };
const array = value => Array.from(value || []);
const number = value => Number(value?._value ?? value);
const message = error => String(error?.message || error || '未知错误');
const extension = value => /\.([^.\\/]+)$/.exec(String(value || ''))?.[1]?.toLowerCase();
const layered = value => ['psd', 'psb'].includes(extension(value));
function walk(nodes) { return array(nodes).flatMap(l => [l, ...walk(l.kind === 'group' ? l.layers : [])]); }
function newRoots(nodes, oldIds) {
  return array(nodes).flatMap(l => !oldIds.has(l.id) ? [l] : newRoots(l.kind === 'group' ? l.layers : [], oldIds));
}
function contentPath(doc) {
  const path = String(doc.path || '').replace(/\\/g, '/');
  if (!/^(?:[a-z]:\/|\/|file:)/i.test(path)) return '';
  return /^(?:[a-z]:\/|\/\/|file:\/\/\/[a-z]:)/i.test(path) ? path.toLowerCase() : path;
}

export function createSmartPasteService(photoshop) {
  const { app, action, core } = photoshop;
  const placement = photoshop.constants?.ElementPlacement || {};
  let busy = false;
  const docs = () => array(app.documents);
  const exists = d => d && docs().some(x => x.id === d.id);
  const find = (d, id) => walk(d.layers).find(l => l.id === id);
  function activate(d) {
    if (!exists(d)) throw Error('文档已关闭，请重新选择目标。');
    app.activeDocument = d;
  }
  function ref(d, id) { return [{ _ref: 'layer', _id: id }, { _ref: 'document', _id: d.id }]; }
  async function bp(commands) {
    const result = await action.batchPlay(commands, {});
    const failure = array(result).find(r => r?._obj?.toLowerCase() === 'error');
    if (failure) throw Object.assign(Error(failure.message || 'Photoshop 拒绝了操作'), { number: failure.result });
    return result;
  }
  async function select(d, ids) {
    activate(d);
    const live = ids.filter(id => find(d, id));
    if (!live.length) return;
    await bp(live.map((id, i) => ({ _obj: 'select', _target: ref(d, id), makeVisible: false,
      ...(i ? { selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' } } : {}), _options: OPTIONS })));
  }
  async function close(d) {
    if (!exists(d)) return;
    activate(d);
    if (typeof d.closeWithoutSaving === 'function') await d.closeWithoutSaving();
    else await d.close(photoshop.constants?.SaveOptions?.DONOTSAVECHANGES || 'doNotSaveChanges');
  }

  async function pasteLayers(d, cfg) {
    const originalRoots = array(d.layers), oldIds = new Set(walk(d.layers).map(l => l.id));
    // 明确选中根部层并清掉像素选区，避免把粘贴位置限制在先前的选区中。
    if (originalRoots.length) await select(d, [originalRoots[0].id]);
    await bp([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }],
      to: { _enum: 'ordinal', _value: 'none' }, _options: OPTIONS }]);
    try {
      // 不指定 as:pixel，交给 PS 保留整层剪贴板的多层、组、蒙版和自带效果。
      await bp([{ _obj: 'paste', inPlace: true, _options: OPTIONS }]);
    } catch (error) {
      if (error?.number === -128) throw error;
      throw Error(`无法粘贴，请先在 PS 图层面板复制需要的完整图层，再重试。${message(error)}`);
    }
    // paste 的返回值可能只给出其中一层，必须比较整棵树而不能用活动层兜底。
    const added = newRoots(d.layers, oldIds);
    if (!added.length) throw Error('没有粘贴出新图层，请先复制完整图层；本对象未保存。');
    const clips = added.map(l => !!l.isClippingMask);
    if (originalRoots.length) {
      const bottom = originalRoots[originalRoots.length - 1];
      let anchor = originalRoots[0], before = true;
      if (cfg.position === 'bottom') {
        anchor = bottom; before = !!bottom.isBackgroundLayer;
        if (before) {
          let i = originalRoots.length - 1;
          while (i > 0 && originalRoots[i - 1].isClippingMask) i--;
          anchor = originalRoots[i];
        }
      }
      // 同一个锚点之后插入时反向遍历，确保最终顺序与原剪贴板一致。
      for (const l of before ? added : [...added].reverse()) {
        await l.move(anchor, before ? (placement.PLACEBEFORE || 'placeBefore') : (placement.PLACEAFTER || 'placeAfter'));
      }
    }
    // 移动跨出已有组可能解除剪贴，全部落位后从底向上恢复原粘贴关系。
    for (let i = added.length - 1; i >= 0; i--) {
      if (!!added[i].isClippingMask !== clips[i]) added[i].isClippingMask = clips[i];
    }
    if (cfg.placement === 'center') {
      const bounds = added.map(l => l.boundsNoEffects || l.bounds).filter(Boolean).map(b => ({
        left: number(b.left), top: number(b.top), right: number(b.right), bottom: number(b.bottom),
      })).filter(b => Object.values(b).every(Number.isFinite) && b.right > b.left && b.bottom > b.top);
      if (bounds.length) {
        const dx = Math.round(number(d.width) / 2 - (Math.min(...bounds.map(b => b.left)) + Math.max(...bounds.map(b => b.right))) / 2);
        const dy = Math.round(number(d.height) / 2 - (Math.min(...bounds.map(b => b.top)) + Math.max(...bounds.map(b => b.bottom))) / 2);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw Error('无法读取内部画布尺寸，本对象未保存。');
        if (dx || dy) {
          await select(d, added.map(l => l.id));
          await bp([{ _obj: 'move', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            to: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: dx }, vertical: { _unit: 'pixelsUnit', _value: dy } }, _options: OPTIONS }]);
        }
      }
    }
    return added.length;
  }

  async function pasteIntoSmartObjects(settings = {}, opts = {}) {
    if (busy) throw Error('正在批量粘贴，请等待当前操作完成。');
    busy = true;
    try {
      const cfg = { position: 'top', placement: 'original', ...settings };
      if (!['top', 'bottom'].includes(cfg.position) || !['original', 'center'].includes(cfg.placement)) throw Error('添加位置设置无效。');
      const origin = app.activeDocument;
      if (!origin) throw Error('请先打开 Photoshop 文档。');
      const targets = array(origin.activeLayers).map(l => ({ id: l.id, name: l.name }));
      if (!targets.length) throw Error('请先选择需要添加图层的智能对象。');
      const result = { applied: 0, skipped: 0, failed: 0, shared: 0, stopped: false, results: [] };
      const savedIds = new Set(), savedPaths = new Set(), savedDocs = new Set();
      function skip(target, why, shared = false) {
        result.skipped++;
        if (shared) result.shared++;
        result.results.push({ name: target.name, status: 'skipped', message: why });
      }
      try {
        for (let i = 0; i < targets.length; i++) {
          if (opts.shouldStop?.()) { result.stopped = true; break; }
          const target = targets[i];
          let content, context, owned = false, saved = false, row;
          try {
            await core.executeAsModal(async ctx => {
              context = ctx;
              try {
                activate(origin);
                const layer = find(origin, target.id);
                if (!layer || layer.kind !== 'smartObject') { skip(target, '不是智能对象，已跳过'); return; }
                const [descriptor] = await bp([{ _obj: 'get', _target: [{ _property: 'smartObject' }, ...ref(origin, layer.id)], _options: OPTIONS }]);
                const so = descriptor?.smartObject;
                if (!so || typeof so.linked !== 'boolean') throw Error('无法确认智能对象来源，请重新选择。');
                if (so.linked) { skip(target, '链接智能对象暂不处理，请先嵌入内容'); return; }
                if (extension(so.fileReference) && !layered(so.fileReference)) {
                  skip(target, '内部源需为 PSD/PSB 才能保留新增图层'); return;
                }
                const contentId = (typeof so.ID === 'string' || typeof so.ID === 'number') && String(so.ID) ? String(so.ID) : null;
                if (contentId !== null && savedIds.has(contentId)) {
                  skip(target, '共享的智能对象内容已添加，本次只处理一次', true); return;
                }
                const before = new Set(docs().map(d => d.id));
                await select(origin, [target.id]);
                await bp([{ _obj: 'placedLayerEditContents', _options: OPTIONS }]);
                content = app.activeDocument;
                if (!content || content.id === origin.id) throw Error('无法打开可编辑的智能对象内容。');
                if (before.has(content.id)) { skip(target, '内部文档已经打开，请先保存并关闭后重试'); return; }
                owned = true;
                await ctx?.hostControl?.registerAutoCloseDocument?.(content.id);
                const path = contentPath(content);
                if (savedDocs.has(content.id) || (path && savedPaths.has(path))) {
                  skip(target, '共享的智能对象内容已添加，本次只处理一次', true); return;
                }
                if (!layered(content.path || content.name)) {
                  skip(target, '实际内部源不是 PSD/PSB，无法保留新增图层'); return;
                }
                const count = await pasteLayers(content, cfg);
                if (ctx?.isCancelled) throw Error('操作已取消，本对象未保存');
                activate(content);
                if (typeof content.save === 'function') await content.save();
                else await bp([{ _obj: 'save', documentID: content.id, _options: OPTIONS }]);
                saved = true;
                if (contentId !== null) savedIds.add(contentId);
                savedDocs.add(content.id); if (path) savedPaths.add(path);
                result.applied++;
                row = { name: target.name, status: 'applied', message: `已添加 ${count} 个图层/组` };
                result.results.push(row);
              } finally {
                if (owned && exists(content) && !ctx?.isCancelled) {
                  try {
                    await close(content);
                    await ctx?.hostControl?.unregisterAutoCloseDocument?.(content.id);
                  } catch (error) {
                    if (saved) { row.warning = true; row.message += `；内容已保存，但关闭失败：${message(error)}`; }
                    else { result.stopped = true; throw Error(`内部文档未保存且关闭失败，请关闭该文档时选择不保存。${message(error)}`); }
                  }
                }
                if (exists(origin) && !ctx?.isCancelled) activate(origin);
              }
            }, { commandName: `粘贴到智能对象：${target.name}` });
          } catch (error) {
            if (!saved) { result.failed++; result.results.push({ name: target.name, status: 'failed', message: message(error) }); }
            if (context?.isCancelled || error?.number === -128) result.stopped = true;
          }
          opts.onProgress?.(i + 1, targets.length, target.name);
          if (result.stopped) break;
          // 对象边界释放模态，让面板能够显示进度和响应停止。
          if (i + 1 < targets.length) await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally {
        if (exists(origin)) {
          try { await core.executeAsModal(() => select(origin, targets.map(l => l.id)), { commandName: '恢复原文档与选择' }); }
          catch (error) { result.results.push({ name: origin.name, status: 'warning', warning: true, message: `内容处理结束，但恢复选择失败：${message(error)}` }); }
        }
      }
      return result;
    } finally { busy = false; }
  }
  return { pasteIntoSmartObjects };
}

let singleton;
export function pasteIntoSmartObjects(settings, opts) {
  singleton ||= createSmartPasteService(require('photoshop'));
  return singleton.pasteIntoSmartObjects(settings, opts);
}
