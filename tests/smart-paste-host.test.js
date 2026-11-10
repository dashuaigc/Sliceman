import { describe, it, expect } from 'vitest';
import { createSmartPasteService } from '../src/ps/smart-paste.js';

// Photoshop is injected at its native boundary; layer trees, selection and saved files
// behave independently of the service, including nested insertions and discarded edits.
function fixture() {
  let seq = 100;
  const events = [], app = { documents: [], activeDocument: null };
  const walk = nodes => nodes.flatMap(l => [l, ...walk(l.layers || [])]);
  const find = (d, id) => walk(d.layers).find(l => l.id === id);
  function remove(nodes, l) {
    const at = nodes.indexOf(l);
    if (at >= 0) nodes.splice(at, 1);
    else nodes.forEach(n => remove(n.layers || [], l));
  }
  function containing(nodes, l) {
    if (nodes.includes(l)) return nodes;
    for (const n of nodes) { const found = containing(n.layers || [], l); if (found) return found; }
  }
  function layer(d, spec = {}) {
    const l = { id: ++seq, kind: 'pixel', name: '内容', visible: true,
      bounds: { left: 20, top: 30, right: 60, bottom: 70 }, ...spec };
    l.layers = (spec.layers || []).map(s => layer(d, s));
    l.move = async (anchor, where) => {
      events.push(['reorder', l.name, anchor.name, where]);
      if (ps.failMove) throw Error('无法移动图层');
      remove(d.layers, l);
      const list = containing(d.layers, anchor), at = list.indexOf(anchor);
      list.splice(at + (where === 'placeAfter' ? 1 : 0), 0, l);
      l.isClippingMask = false; // PS can release a clip when moving across groups.
    };
    return l;
  }
  function doc(spec = {}) {
    const d = { id: ++seq, name: '测试.psd', width: 400, height: 300, ...spec };
    d.layers = (spec.layers || []).map(s => layer(d, s));
    d.activeLayers = d.layers.slice(0, 1);
    d.save = async () => {
      if (d.failSave) throw Error('写入失败');
      events.push(['save', d.id]); d.saved = true;
    };
    d.closeWithoutSaving = async () => {
      if (d.failClose) throw Error('关闭失败');
      events.push(['close', d.id]); d.closed = true;
      app.documents = app.documents.filter(x => x.id !== d.id);
      if (app.activeDocument === d) app.activeDocument = app.documents[0] || null;
    };
    app.documents.push(d);
    return d;
  }
  const ps = { app, clipboard: [
    { name: '高光', isClippingMask: true, opacity: 50, fx: { shadow: 10 } },
    { name: '纹理', bounds: { left: 80, top: 50, right: 120, bottom: 90 } },
  ], constants: { ElementPlacement: { PLACEBEFORE: 'placeBefore', PLACEAFTER: 'placeAfter' } },
    core: { executeAsModal: async fn => {
      const autoClose = new Set();
      const ctx = { isCancelled: false, hostControl: {
        registerAutoCloseDocument: async id => autoClose.add(id),
        unregisterAutoCloseDocument: async id => autoClose.delete(id),
      } };
      ps.context = ctx;
      try { return await fn(ctx); }
      finally { if (ctx.isCancelled) for (const id of autoClose) await app.documents.find(d => d.id === id)?.closeWithoutSaving(); }
    } },
    action: { batchPlay: async commands => {
      const results = [];
      for (const c of commands) {
        events.push(['bp', c]);
        const refs = Array.isArray(c._target) ? c._target : [];
        const dr = refs.find(r => r._ref === 'document'), lr = refs.find(r => r._ref === 'layer');
        const d = dr?._id ? app.documents.find(x => x.id === dr._id) : app.activeDocument;
        const l = lr?._id ? find(d, lr._id) : d?.activeLayers[0];
        if (c._obj === 'get') {
          if (l?.failRead) throw Error('读取对象失败');
          results.push({ smartObject: l?._smart });
        } else if (c._obj === 'select' && lr) {
          d.activeLayers = c.selectionModifier ? [...d.activeLayers, l] : [l]; results.push({});
        } else if (c._obj === 'placedLayerEditContents') {
          if (l.failOpen) throw Error('打开失败');
          if (!app.documents.includes(l._content)) app.documents.push(l._content);
          app.activeDocument = l._content; results.push({});
        } else if (c._obj === 'paste') {
          if (ps.cancelPaste) { ps.context.isCancelled = true; throw Error('已取消'); }
          if (ps.pasteError || d.pasteError) { results.push({ _obj: 'error', message: '粘贴不可用', result: -25920 }); continue; }
          if (ps.noNewLayers) { results.push({}); continue; }
          const added = ps.clipboard.map(s => layer(d, s));
          const into = ps.pasteNested ? d.layers.find(l => l.kind === 'group').layers : d.layers;
          into.unshift(...added); d.activeLayers = added;
          results.push({ ID: added[0]?.id });
        } else if (c._obj === 'move' && c.to?._obj === 'offset') {
          const dx = c.to.horizontal._value, dy = c.to.vertical._value;
          events.push(['offset', d.activeLayers.map(l => l.name), dx, dy]);
          for (const l of walk(d.activeLayers)) {
            const b = l.bounds;
            l.bounds = { left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy };
          }
          results.push({});
        } else results.push({});
      }
      return results;
    } },
  };
  function smart(parent, name, id, spec = {}) {
    const inner = doc({ name: name + '.psb', layers: [{ name: '原有内容' }], ...spec });
    app.documents = app.documents.filter(x => x !== inner);
    const l = layer(parent, { name, kind: 'smartObject', _smart: { linked: false, ID: id, fileReference: name + '.psb' }, _content: inner });
    parent.layers.push(l); return l;
  }
  const parent = doc({ name: '父文档.psd' });
  const a = smart(parent, 'A', 'a'), b = smart(parent, 'B', 'b');
  parent.activeLayers = [a, b]; app.activeDocument = parent;
  return { ps, app, events, parent, a, b, doc, layer, smart, service: createSmartPasteService(ps) };
}

describe('直接粘贴到智能对象内部', () => {
  it('默认原位粘贴多层、保留属性，不套新组，保存关闭并恢复选择', async () => {
    const h = fixture();
    const result = await h.service.pasteIntoSmartObjects();
    expect(result).toMatchObject({ applied: 2, failed: 0, skipped: 0 });
    expect(h.a._content.layers.map(l => l.name)).toEqual(['高光', '纹理', '原有内容']);
    expect(h.a._content.layers[0]).toMatchObject({ opacity: 50, isClippingMask: true, fx: { shadow: 10 } });
    expect(h.a._content.layers[0].bounds).toEqual(h.ps.clipboard[0].bounds || { left: 20, top: 30, right: 60, bottom: 70 });
    const pasted = h.events.filter(e => e[0] === 'bp' && e[1]._obj === 'paste');
    expect(pasted).toHaveLength(2);
    expect(pasted.every(e => e[1].inPlace === true && !e[1].as)).toBe(true);
    expect(h.events.some(e => ['copyEvent', 'set'].includes(e[1]?._obj) && e[1]?.to?._obj === 'layerEffects')).toBe(false);
    expect(h.a._content.saved && h.a._content.closed).toBe(true);
    expect(h.app.activeDocument).toBe(h.parent);
    expect(h.parent.activeLayers.map(l => l.id)).toEqual([h.a.id, h.b.id]);
  });
  it('居中时按所有新增层联合边界平移一次、保持相对位置', async () => {
    const h = fixture(); h.parent.activeLayers = [h.a];
    await h.service.pasteIntoSmartObjects({ placement: 'center' });
    expect(h.events.filter(e => e[0] === 'offset')).toEqual([['offset', ['高光', '纹理'], 130, 90]]);
    expect(h.a._content.layers[1].bounds.left - h.a._content.layers[0].bounds.left).toBe(60);
  });
  it('原位模式不调用位移或缩放', async () => {
    const h = fixture(); await h.service.pasteIntoSmartObjects({ placement: 'original' });
    expect(h.events.some(e => e[0] === 'offset' || e[1]?._obj === 'transform')).toBe(false);
  });
  it('粘贴进入已有组时提升新增根层而不移动或移除原有组内容', async () => {
    const h = fixture(); h.ps.pasteNested = true;
    for (const l of [h.a, h.b]) l._content.layers = [h.layer(l._content, { name: '原有组', kind: 'group', layers: [{ name: '保留' }] })];
    await h.service.pasteIntoSmartObjects();
    expect(h.a._content.layers.map(l => l.name)).toEqual(['高光', '纹理', '原有组']);
    expect(h.a._content.layers[2].layers.map(l => l.name)).toEqual(['保留']);
  });
  it('粘贴组保留嵌套结构和顺序', async () => {
    const h = fixture(); h.ps.clipboard = [{ name: '效果组', kind: 'group', layers: [{ name: '高光' }, { name: '纹理' }] }];
    await h.service.pasteIntoSmartObjects();
    expect(h.a._content.layers.map(l => l.name)).toEqual(['效果组', '原有内容']);
    expect(h.a._content.layers[0].layers.map(l => l.name)).toEqual(['高光', '纹理']);
  });
  it('置底保持多层顺序', async () => {
    const h = fixture(); await h.service.pasteIntoSmartObjects({ position: 'bottom' });
    expect(h.a._content.layers.map(l => l.name)).toEqual(['原有内容', '高光', '纹理']);
    expect(h.a._content.layers[1].isClippingMask).toBe(true);
  });
  it('置底不插进背景层及其剪贴链之间', async () => {
    const h = fixture(); h.parent.activeLayers = [h.a];
    h.a._content.layers = [{ name: '顶层' }, { name: '背景剪贴', isClippingMask: true }, { name: '背景', isBackgroundLayer: true }].map(s => h.layer(h.a._content, s));
    await h.service.pasteIntoSmartObjects({ position: 'bottom' });
    expect(h.a._content.layers.map(l => l.name)).toEqual(['顶层', '高光', '纹理', '背景剪贴', '背景']);
  });
  it('重复执行只追加、不删除前次新增层', async () => {
    const h = fixture(); h.parent.activeLayers = [h.a];
    await h.service.pasteIntoSmartObjects(); await h.service.pasteIntoSmartObjects();
    expect(h.a._content.layers.map(l => l.name)).toEqual(['高光', '纹理', '高光', '纹理', '原有内容']);
  });
  it('不按同名文件去重，但确定的同源内容只处理一次', async () => {
    const h = fixture(); h.b._smart.ID = h.a._smart.ID;
    const r = await h.service.pasteIntoSmartObjects();
    expect(r).toMatchObject({ applied: 1, skipped: 1, shared: 1 });
    expect(h.events.filter(e => e[0] === 'save')).toHaveLength(1);
  });
  it('不同 ID 实际打开同一完整内容路径时也只粘贴一次', async () => {
    const h = fixture(); delete h.a._smart.ID; delete h.b._smart.ID;
    h.a._content.path = 'C:\\Temp\\shared.psb'; h.b._content.path = 'c:/temp/shared.psb';
    expect(await h.service.pasteIntoSmartObjects()).toMatchObject({ applied: 1, shared: 1, skipped: 1 });
  });
  it('相同文件名但路径不同不能合并', async () => {
    const h = fixture(); delete h.a._smart.ID; delete h.b._smart.ID;
    h.a._content.path = 'C:/Temp/1/name.psb'; h.b._content.path = 'C:/Temp/2/name.psb';
    expect(await h.service.pasteIntoSmartObjects()).toMatchObject({ applied: 2, shared: 0 });
  });
  it('普通图层、链接对象、无法保留分层的源文件明确跳过', async () => {
    const h = fixture(); h.a._smart.linked = true; h.b._smart.fileReference = '原始.jpg';
    const plain = h.layer(h.parent); h.parent.layers.push(plain); h.parent.activeLayers.push(plain);
    const r = await h.service.pasteIntoSmartObjects();
    expect(r).toMatchObject({ applied: 0, skipped: 3 });
    expect(h.events.some(e => e[1]?._obj === 'paste')).toBe(false);
  });
  it('打开后发现 JPEG 内部源也不写入', async () => {
    const h = fixture(); h.parent.activeLayers = [h.a]; h.a._content.name = '原始.jpg';
    expect(await h.service.pasteIntoSmartObjects()).toMatchObject({ applied: 0, skipped: 1 });
    expect(h.a._content.saved).toBeUndefined(); expect(h.a._content.closed).toBe(true);
  });
  it('用户已经打开的内部文档不修改也不关闭', async () => {
    const h = fixture(); h.app.documents.push(h.a._content);
    expect(await h.service.pasteIntoSmartObjects()).toMatchObject({ applied: 1, skipped: 1 });
    expect(h.a._content.closed).toBeUndefined(); expect(h.a._content.saved).toBeUndefined();
  });
  it('粘贴命令错误不保存空结果，其余对象继续，原因提示先复制图层', async () => {
    const h = fixture(); h.a._content.pasteError = true;
    const r = await h.service.pasteIntoSmartObjects();
    expect(r).toMatchObject({ applied: 1, failed: 1 });
    expect(r.results.find(x => x.status === 'failed').message).toContain('复制');
    expect(h.a._content.saved).toBeUndefined(); expect(h.a._content.closed).toBe(true);
  });
  it('粘贴未新增图层时不能把原有活动层当作新增内容', async () => {
    const h = fixture(); h.ps.noNewLayers = true;
    expect(await h.service.pasteIntoSmartObjects()).toMatchObject({ applied: 0, failed: 2 });
    expect(h.events.some(e => e[0] === 'save' || e[0] === 'reorder')).toBe(false);
  });
  it('位移或层序失败则不保存部分粘贴', async () => {
    const h = fixture(); h.ps.failMove = true;
    expect(await h.service.pasteIntoSmartObjects()).toMatchObject({ applied: 0, failed: 2 });
    expect(h.events.some(e => e[0] === 'save')).toBe(false);
  });
  it('保存失败关闭本对象并继续下一项', async () => {
    const h = fixture(); h.a._content.failSave = true;
    expect(await h.service.pasteIntoSmartObjects()).toMatchObject({ applied: 1, failed: 1 });
    expect(h.a._content.closed).toBe(true);
  });
  it('保存成功关闭失败仍如实算成功并说明关闭异常', async () => {
    const h = fixture(); h.a._content.failClose = true;
    const r = await h.service.pasteIntoSmartObjects();
    expect(r).toMatchObject({ applied: 2, failed: 0 });
    expect(r.results[0].message).toContain('关闭');
  });
  it('停止在对象边界生效并恢复原选择', async () => {
    const h = fixture(); let stop = false;
    const r = await h.service.pasteIntoSmartObjects({}, { shouldStop: () => stop, onProgress: () => { stop = true; } });
    expect(r).toMatchObject({ applied: 1, stopped: true });
    expect(h.b._content.saved).toBeUndefined();
    expect(h.parent.activeLayers).toEqual([h.a, h.b]);
  });
  it('Escape 取消自动关闭本次打开的内容且不保存', async () => {
    const h = fixture(); h.ps.cancelPaste = true;
    expect(await h.service.pasteIntoSmartObjects()).toMatchObject({ applied: 0, failed: 1, stopped: true });
    expect(h.a._content.saved).toBeUndefined(); expect(h.a._content.closed).toBe(true);
    expect(h.app.activeDocument).toBe(h.parent);
  });
  it('没有文档、没有选择或无效配置时不开始处理', async () => {
    const h = fixture(); h.app.activeDocument = null;
    await expect(h.service.pasteIntoSmartObjects()).rejects.toThrow('文档');
    h.app.activeDocument = h.parent; h.parent.activeLayers = [];
    await expect(h.service.pasteIntoSmartObjects()).rejects.toThrow('选择');
    h.parent.activeLayers = [h.a];
    await expect(h.service.pasteIntoSmartObjects({ position: 'middle' })).rejects.toThrow('位置');
  });
  it('正在执行时拒绝第二次并发调用', async () => {
    const h = fixture();
    const first = h.service.pasteIntoSmartObjects();
    first.catch(() => {});
    await expect(h.service.pasteIntoSmartObjects()).rejects.toThrow('正在');
    await first;
  });
  it('复制内容是纯空层时居中无需变换仍允许添加', async () => {
    const h = fixture(); h.ps.clipboard = [{ name: '空层', bounds: { left: 0, top: 0, right: 0, bottom: 0 } }];
    expect(await h.service.pasteIntoSmartObjects({ placement: 'center' })).toMatchObject({ applied: 2 });
    expect(h.events.some(e => e[0] === 'offset')).toBe(false);
  });
});
