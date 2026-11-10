import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const api = vi.hoisted(() => ({ pasteIntoSmartObjects: vi.fn() }));
vi.mock('../src/ps/smart-paste.js', () => api);
const moduleUrl = new URL('../src/ui/smart-paste-panel.js', import.meta.url);
const html = () => readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');

function fakeDocument() {
  const ids = new Set([...html().matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const els = new Map();
  return { getElementById(id) {
    if (!ids.has(id)) throw Error('Missing real UI id: ' + id);
    if (!els.has(id)) {
      const attrs = new Map(), classes = new Set(), events = new Map();
      els.set(id, {
        id, textContent: '', style: {},
        classList: { contains: c => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
        setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: k => attrs.get(k),
        addEventListener: (type, fn) => { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); },
        async fire(type, extra = {}) {
          const e = { preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra };
          for (const fn of events.get(type) || []) { await fn(e); if (e.stopped) break; }
        },
      });
    }
    return els.get(id);
  } };
}

let document, status, busy;
const el = id => document.getElementById(id);
const click = id => el(id).fire('click');
async function init(options = {}) {
  expect(existsSync(moduleUrl), 'new simplified paste panel exists').toBe(true);
  const { initSmartPastePanel } = await import('../src/ui/smart-paste-panel.js');
  return initSmartPastePanel({ setStatus: status, setBusy: busy, ...options });
}

beforeEach(() => {
  vi.clearAllMocks();
  document = fakeDocument(); globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem: vi.fn() };
  status = vi.fn(); busy = vi.fn();
  api.pasteIntoSmartObjects.mockResolvedValue({ applied: 2, skipped: 0, failed: 0, shared: 0, stopped: false, results: [] });
});

describe('智能对象内部粘贴面板', () => {
  it('替换旧版样板和 fx 界面，只提供位置和粘贴操作', () => {
    const markup = html();
    expect(markup).toContain('id="smartPasteCard"');
    expect(markup).not.toContain('id="smartContentCard"');
    expect(markup).not.toContain('id="scModeFx"');
    expect(markup).not.toContain('id="scCapture"');
    expect(markup).not.toContain('id="spProgress"');
    expect(markup.includes('id="spStop"')).toBe(false);
  });

  it('默认最上方和原位，直接执行无需获取样板', async () => {
    await init();
    expect(el('spPositionTop').getAttribute('aria-pressed')).toBe('true');
    expect(el('spPlacementOriginal').getAttribute('aria-pressed')).toBe('true');
    await click('spApply');
    expect(api.pasteIntoSmartObjects).toHaveBeenCalledWith({ position: 'top', placement: 'original' }, expect.any(Object));
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('成功 2'));
    expect(el('spApply').textContent).toBe('粘贴到智能对象内部');
    expect(el('spApply').classList.contains('sp-stopping')).toBe(false);
  });

  it('用户可以选择最下方与整体居中，设置会保存', async () => {
    await init();
    await click('spPositionBottom'); await click('spPlacementCenter'); await click('spApply');
    expect(api.pasteIntoSmartObjects.mock.calls[0][0]).toEqual({ position: 'bottom', placement: 'center' });
    expect(localStorage.setItem).toHaveBeenLastCalledWith('smartPaste.settings', JSON.stringify({ position: 'bottom', placement: 'center' }));
  });

  it('读取有效选项，损坏的存储退回默认值', async () => {
    localStorage.getItem = () => '{bad json';
    await init(); await click('spApply');
    expect(api.pasteIntoSmartObjects.mock.calls[0][0]).toEqual({ position: 'top', placement: 'original' });
    document = fakeDocument(); globalThis.document = document;
    localStorage.getItem = () => JSON.stringify({ position: 'bottom', placement: 'center' });
    await init();
    expect(el('spPositionBottom').getAttribute('aria-pressed')).toBe('true');
    expect(el('spPlacementCenter').getAttribute('aria-pressed')).toBe('true');
  });

  it('主按钮在运行时变为停止，停止结束后恢复粘贴，且不重复启动任务', async () => {
    let finish, hooks;
    api.pasteIntoSmartObjects.mockImplementation((cfg, opts) => { hooks = opts; return new Promise(resolve => { finish = () => resolve({ applied: 1, skipped: 0, failed: 0, shared: 0, stopped: opts.shouldStop(), results: [] }); }); });
    const panel = await init();
    busy.mockImplementation(on => panel.setExternalBusy(on));
    const running = click('spApply');
    // The fake event dispatcher awaits the disabled guard before the feature listener.
    await vi.waitFor(() => expect(hooks).toBeDefined());
    expect(status).toHaveBeenLastCalledWith('正在粘贴…');
    expect(el('spApply').getAttribute('aria-disabled')).toBe('false');
    expect(el('spApply').textContent).toBe('停止');
    expect(el('spApply').classList.contains('sp-stopping')).toBe(true);
    expect(el('spPositionBottom').getAttribute('aria-disabled')).toBe('true');
    hooks.onProgress(1, 3, '目标 A');
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('1 / 3'));
    await click('spPositionBottom'); await click('spApply');
    expect(status).toHaveBeenLastCalledWith('正在完成当前对象，随后停止…');
    expect(hooks.shouldStop()).toBe(true);
    expect(el('spApply').getAttribute('aria-disabled')).toBe('true');
    expect(el('spApply').textContent).toBe('停止');
    expect(el('spApply').classList.contains('sp-stopping')).toBe(true);
    await click('spApply');
    expect(api.pasteIntoSmartObjects).toHaveBeenCalledTimes(1);
    finish(); await running;
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('已停止'));
    expect(busy.mock.calls).toEqual([[true], [false]]);
    expect(el('spApply').getAttribute('aria-disabled')).toBe('false');
    expect(el('spApply').textContent).toBe('粘贴到智能对象内部');
    expect(el('spApply').classList.contains('sp-stopping')).toBe(false);
  });

  it('宿主失败后显示原因并恢复执行按钮', async () => {
    api.pasteIntoSmartObjects.mockRejectedValue(Error('剪贴板没有可粘贴的图层'));
    await init(); await click('spApply');
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('剪贴板没有可粘贴的图层'));
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('失败'));
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(el('spApply').getAttribute('aria-disabled')).toBe('false');
    expect(el('spApply').textContent).toBe('粘贴到智能对象内部');
    expect(el('spApply').classList.contains('sp-stopping')).toBe(false);
  });

  it('结果只展开异常详情，并显示共享内容同步提示', async () => {
    api.pasteIntoSmartObjects.mockResolvedValue({ applied: 2, skipped: 2, failed: 1, shared: 1, stopped: false,
      results: [{ name: 'A', status: 'applied', message: '成功' }, { name: 'B', status: 'skipped', message: '共享内容，仅添加一次' },
        { name: 'C', status: 'skipped', message: '普通图层' }, { name: 'D', status: 'failed', message: '保存失败' }] });
    await init(); await click('spApply');
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('跳过 2'));
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('失败 1'));
    expect(el('spDetails').style.display).toBe('');
    expect(el('spResults').style.display).toBe('none');
    await click('spDetails');
    expect(el('spResults').style.display).toBe('');
    expect(el('spResults').textContent).toContain('D：保存失败');
    expect(el('spResults').textContent).toContain('共享内容');
    expect(el('spResults').textContent).not.toContain('A：成功');
  });

  it('其他功能忙碌时不可执行，外部解除后可运行', async () => {
    const panel = await init({ bindButtons: false });
    panel.setExternalBusy(true); await click('spApply');
    expect(api.pasteIntoSmartObjects).not.toHaveBeenCalled();
    panel.setExternalBusy(false); await click('spApply');
    expect(api.pasteIntoSmartObjects).toHaveBeenCalledTimes(1);
  });
});
