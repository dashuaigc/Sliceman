import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 面板脚本一旦在【模块初始化阶段】抛错（常见死法：新加的代码块放在它依赖的 const
// 前面，撞上暂时性死区；或者调用了还没定义的函数），UXP 里的表现就是「面板全白」，
// 而且用户那边没有控制台可看。这里在 Node 里用一套宽松的 DOM/PS 桩把打包产物跑一遍。
//
// 桩是刻意宽松的——getElementById 永远返回一个假元素，不会返回 null。
// 「id 写错了」这类问题由 tests/ui-ids.test.js 静态比对 index.html 负责。
//
// 后面的用例更进一步：造一个假文档，模拟点「新建参考线版面」、模拟 Photoshop 发回
// newGuideLayout 通知、模拟点记录里的「应用」，断言真正下发给 PS 的描述符对不对、
// 记录写没写对——这段「界面 → PS 弹窗 → 通知 → 记录」的接线在 Node 下没法靠
// 纯单测覆盖，只能这样验。

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeEl(id = 'stub') {
  const classes = new Set();
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    id,
    checked: false,
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    style: {},
    dataset: {},
    _listeners: listeners,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); return; }
        if (on) classes.add(c); else classes.delete(c);
      },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    blur() {},
    focus() {},
  };
  el.parentNode = { classList: el.classList };
  return el;
}

/** 触发某个假元素上注册的事件（onclick 属性赋值的那种也一并触发） */
function fire(el, type, ev = {}) {
  for (const fn of el._listeners.get(type) || []) fn(ev);
  if (type === 'click' && typeof el.onclick === 'function') el.onclick(ev);
}

function makeStorage(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

/**
 * 造一套宿主环境并把打包后的面板脚本跑起来。
 * @param {{doc?:object, prefs?:object}} [opts]
 *        doc 为 null 表示没有打开文档；prefs 预置进 localStorage
 */
async function loadPanel(opts = {}) {
  const out = await build({
    entryPoints: [join(root, 'src/ui/panel.js')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome88'],
    external: ['photoshop', 'uxp'],
    write: false,
  });

  const els = new Map();
  // pill 单选 / 多选组照 index.html 里的真实标记造出来：这样 setPillActive / activePill /
  // pillOn / bindPillGroup 在桩里的行为和真 DOM 一致，匹配方式、查找范围这些条件才测得到
  const html = readFileSync(join(root, 'src/ui/index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const spanCache = new Map();
  /**
   * 照 index.html 里的真实标记，把某个容器下带指定 class 的 <span> 造成假元素
   *（pill 单选/多选组、自绘下拉的选项都靠它）。同一组每次返回同一批元素，
   * 渲染时写进去的 .active 才读得回来。
   */
  const spansIn = (containerId, cls) => {
    const key = `${containerId}|${cls}`;
    if (spanCache.has(key)) return spanCache.get(key);
    const at = html.indexOf(`id="${containerId}"`);
    const list = [];
    if (at >= 0) {
      const body = html.slice(at, html.indexOf('</div>', at));
      const re = new RegExp(`<span class="([^"]*\\b${cls}\\b[^"]*)"([^>]*)>([^<]*)`, 'g');
      for (const m of body.matchAll(re)) {
        const el = makeEl(cls);
        if (/\bactive\b/.test(m[1])) el.classList.add('active');
        for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
        el.textContent = m[3];        // 勾选框那种带子 span 的取不到全文，但没人读 pill 的文字
        list.push(el);
      }
    }
    spanCache.set(key, list);
    return list;
  };
  // 版面记录列表是拼 innerHTML 再回头 querySelectorAll 挂事件的，桩里得能把
  // 「操作按钮」还原出来，否则「点记录里的应用」这条路没法测。同一段 innerHTML
  // 返回同一批假元素，渲染时挂上的监听器测试里才点得到。
  let miniCache = { html: null, list: [] };
  const miniButtons = () => {
    const html = (els.get('gdList') || {}).innerHTML || '';
    if (miniCache.html === html) return miniCache.list;
    const list = (html.match(/data-act="[^"]+"/g) || []).map((m) => {
      const el = makeEl('gd-mini');
      el.setAttribute('data-act', m.slice(10, -1));
      return el;
    });
    miniCache = { html, list };
    return list;
  };

  // 功能磁贴：让 switchPage 在测试里也走得通（点磁贴 = 切页）
  const tiles = ['rename', 'split', 'batch', 'layout', 'table', 'guide', 'slice'].map((p) => {
    const el = makeEl('tile-' + p);
    el.setAttribute('data-page', p);
    return el;
  });

  const docListeners = new Map();
  // 同一个选择器每次返回同一个假元素：setPillOn 写进去的 .active 才能被 pillOn 读回来
  //（面板里这两个函数用的是同一串选择器），否则「含隐藏图层」这类开关在桩里恒为关
  const bySelector = new Map();
  const document = {
    _listeners: docListeners,
    getElementById(id) {
      // 对 panel.js 永远返回假元素、绝不返回 null（见文件头）；但 index.html 里根本
      // 没有的 id 直接报错——panel.js 那侧已由 ui-ids.test.js 静态保证，所以这种情况
      // 只会是用例自己写了个过时的 id（改版删掉的按钮），静默返回空壳最难查
      if (!htmlIds.has(id)) throw new Error(`index.html 里没有 id="${id}"`);
      if (!els.has(id)) {
        const el = makeEl(id);
        // 容器元素上的 querySelectorAll 交给 spansIn（bindPillGroup / bindDropdown 靠它挂事件）
        el.querySelectorAll = (sel) => (sel === '.pill' || sel === '.dd-item' ? spansIn(id, sel.slice(1)) : []);
        els.set(id, el);
      }
      return els.get(id);
    },
    querySelector: (sel) => {
      // #容器 .pill.active / #容器 .pill[data-x="y"]（.dd-item 同理）—— 走真实标记造出来的那批
      const m = /^#([\w-]+)\s+\.(pill|dd-item)(?:\.active|\[([\w-]+)="([^"]*)"\])?$/.exec(sel);
      if (m) {
        const items = spansIn(m[1], m[2]);
        return (m[3]
          ? items.find((p) => p.getAttribute(m[3]) === m[4])
          : items.find((p) => p.classList.contains('active'))) || null;
      }
      if (!bySelector.has(sel)) bySelector.set(sel, makeEl(sel));
      return bySelector.get(sel);
    },
    querySelectorAll: (sel) => {
      if (sel === '#gdList .gd-mini') return miniButtons();
      if (sel === '.tile') return tiles;
      return [];
    },
    createElement: () => makeEl(),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  const played = [];                       // 记录所有下发给 PS 的描述符
  const notifiers = new Map();             // 事件名 → 插件注册的回调
  const photoshop = {
    app: { activeDocument: opts.doc ?? null, documents: opts.doc ? [opts.doc] : [] },
    action: {
      // onPlay 让用例模拟 Photoshop 的反应：改文档、抛错（弹窗被取消），
      // 或者返回一份「实际执行的描述符」当作 batchPlay 的结果
      batchPlay: async (desc) => {
        played.push(...desc);
        const out = [];
        for (const d of desc) out.push((opts.onPlay ? await opts.onPlay(d) : null) || {});
        return out;
      },
      // 通知监听：把回调收下来，用例里用 notify('newGuideLayout', desc) 模拟 PS 发通知
      addNotificationListener: async (events, cb) => {
        for (const e of events || []) {
          const name = typeof e === 'string' ? e : (e && e.event);
          if (!name) continue;
          if (!notifiers.has(name)) notifiers.set(name, []);
          notifiers.get(name).push(cb);
        }
      },
    },
    core: { executeAsModal: async (fn) => fn() },
  };
  const uxp = { storage: { localFileSystem: { getFolder: async () => null } } };

  const req = (name) => {
    if (name === 'photoshop') return photoshop;
    if (name === 'uxp') return uxp;
    throw new Error('未预期的 require：' + name);
  };
  const module = { exports: {} };
  const localStorage = makeStorage(opts.prefs || {});
  const run = new Function(
    'require', 'module', 'exports', 'document', 'localStorage', 'sessionStorage', 'window',
    out.outputFiles[0].text,
  );
  run(req, module, module.exports, document, localStorage, makeStorage(), { addEventListener() {} });

  /** 切功能页（等价于点对应的磁贴） */
  const goPage = (name) => fire(tiles.find((t) => t.getAttribute('data-page') === name), 'click');
  /** 模拟 Photoshop 发一条动作通知（参考线记录全靠它） */
  const notify = async (event, desc) => {
    for (const cb of notifiers.get(event) || []) await cb(event, desc);
  };
  /** 点开记录弹窗，取出某条记录上的某个操作按钮 */
  const recordAction = (act) => document.querySelectorAll('#gdList .gd-mini')
    .find((el) => el.getAttribute('data-act') === act);

  return { document, played, photoshop, localStorage, goPage, notify, recordAction };
}

// ---- 按名称查找 + 重命名：造带图层的假文档 ----

const fakeLayer = (id, name, over = {}) => ({
  id, name, kind: 'pixel', visible: true, isBackgroundLayer: false, locked: false, ...over,
});
const fakeGroup = (id, name, layers, over = {}) => ({
  id, name, kind: 'group', visible: true, isBackgroundLayer: false, locked: false, layers, ...over,
});
/** 只提供改名/查找会用到的那几样（没有 suspendHistory → 走 executeAsModal 那条路） */
function fakeLayerDoc(layers, activeLayers = []) {
  return { id: 1, name: 'test.psd', width: 100, height: 100, layers, activeLayers, guides: fakeGuides([]) };
}
/** 递归找假文档里的某个图层 */
function findFakeLayer(layers, id) {
  for (const l of layers || []) {
    if (l.id === id) return l;
    const hit = findFakeLayer(l.layers, id);
    if (hit) return hit;
  }
  return null;
}
/** 让桩像 PS 一样真把「选中」和「改名」落到假文档上（否则预览/统计验不出效果） */
function onLayerPlay(doc) {
  return (d) => {
    if (d._obj === 'set' && d.to && d.to._obj === 'layer') {
      const l = findFakeLayer(doc.layers, d._target[0]._id);
      if (l) l.name = d.to.name;
    }
    if (d._obj === 'select' && d._target && d._target[0] && d._target[0]._ref === 'layer') {
      const l = findFakeLayer(doc.layers, d._target[0]._id);
      const add = d.selectionModifier && d.selectionModifier._value === 'addToSelection';
      if (l) doc.activeLayers = add ? [...doc.activeLayers, l] : [l];
    }
    return null;
  };
}
/** 从描述符里挑出改名的那些，还原成 [id, 新名] */
const renamesFrom = (played) => played
  .filter((d) => d._obj === 'set' && d.to && d.to._obj === 'layer')
  .map((d) => [d._target[0]._id, d.to.name]);
/** 从描述符里挑出「选中图层」的那些（改名后的预览会顺带读 itemIndex，得滤掉） */
const selectDescs = (played) => played
  .filter((d) => d._obj === 'select' && d._target && d._target[0] && d._target[0]._ref === 'layer');
const selectsFrom = (played) => selectDescs(played).map((d) => d._target[0]._id);
/** 在查找弹窗的结果列表里点某一行（子元素都 pointer-events:none，事件目标就是行本身） */
const clickRow = (document, id) => fire(document.getElementById('slList'), 'click', {
  target: { getAttribute: (k) => (k === 'data-sl' ? String(id) : null) },
});
/** 往输入框里打字 */
const type = (document, id, value) => {
  const el = document.getElementById(id);
  el.value = value;
  fire(el, 'input');
};
const settle = () => new Promise((r) => setTimeout(r, 0));

/** 造一个假的参考线集合（类数组，元素有 direction / coordinate / delete） */
function fakeGuides(list = []) {
  const g = {
    length: list.length,
    removeAll() {
      for (let i = 0; i < this.length; i++) delete this[i];
      this.length = 0;
    },
  };
  list.forEach((it, i) => { g[i] = { ...it, delete() { /* 单条删除这里不用 */ } }; });
  return g;
}

/** 造一个假文档：只提供参考线相关代码真正会用到的那几样 */
function fakeDoc(width, height, guides = []) {
  return {
    id: 1,
    name: 'test.psd',
    width,
    height,
    layers: [],
    activeLayers: [],
    guides: fakeGuides(guides),
  };
}

/** 从描述符里挑出新建参考线的那些，还原成 {vertical:[], horizontal:[]} */
function guidesFrom(played) {
  const v = [], h = [];
  for (const d of played) {
    if (d._obj !== 'make' || !d.new || d.new._obj !== 'good') continue;
    (d.new.orientation._value === 'vertical' ? v : h).push(d.new.position._value);
  }
  return { vertical: v, horizontal: h };
}

describe('panel.js 初始化冒烟', () => {
  it('没有打开文档时也能从头到尾跑完，不抛错', async () => {
    const { document } = await loadPanel();
    // 面板末尾会把状态栏写成「插件已加载」——跑到这一句说明整段初始化都过了
    expect(document.getElementById('status').textContent).toBe('插件已加载');
  });
});

// 「打开弹窗 → 输入关键词 → 看统计与结果 → 确认选中 → 照常改名」这条链只在面板里
// 接线，纯单测覆盖不到，只能像参考线那样用桩把整条路走一遍：断言弹窗里列出的行与统计、
// 确认后真正下发给 PS 的 select 描述符、以及改名仍然只认图层面板的选中。
// 注意桩的局限：pill 的 querySelectorAll 返回空数组，点不到 pill，所以匹配方式 / 范围 /
// 类型都是默认值（包含 / 整个文档 / 全部）；这些条件本身由 search-core 的单测覆盖。
describe('重命名：按名称查找弹窗（查找 → 加入列表 → 确认）', () => {
  const doc = (activeLayers = []) => {
    const d = fakeLayerDoc([
      fakeGroup(10, 'UI', [fakeLayer(11, 'Btn_normal'), fakeLayer(12, 'BTN_hover')]),
      fakeLayer(13, 'bg_btn'),
      fakeLayer(14, 'Title'),
    ]);
    d.activeLayers = activeLayers.map((id) => findFakeLayer(d.layers, id));
    return d;
  };
  const open = (document) => fire(document.getElementById('slOpenBtn'), 'click');
  const click = (document, id) => fire(document.getElementById(id), 'click');
  const shown = (document, id) => document.getElementById(id).style.display !== 'none';
  const count = (document) => document.getElementById('slCount').textContent;
  const grpHead = (document) => document.getElementById('slGroupsHead').textContent;
  const prevHead = (document) => document.getElementById('slPrevHead').textContent;
  const okLabel = (document) => document.getElementById('slOkBtn').textContent;
  const listHtml = (document) => document.getElementById('slList').innerHTML;
  const grpHtml = (document) => document.getElementById('slGroupList').innerHTML;
  const prevHtml = (document) => document.getElementById('slPrevList').innerHTML;
  /** 点某个 pill（桩里的 pill 是照 index.html 造出来的，和真 DOM 一样能点） */
  const clickPill = (document, box, attr, value) =>
    fire(document.querySelector(`#${box} .pill[${attr}="${value}"]`), 'click');
  const activeOf = (document, box, attr) =>
    document.querySelector(`#${box} .pill.active`).getAttribute(attr);
  /** 点自绘下拉里的某个选项（排序用的是下拉，不是 pill） */
  const clickDdItem = (document, box, attr, value) =>
    fire(document.querySelector(`#${box} .dd-item[${attr}="${value}"]`), 'click');
  /** 点搜索结果 / 预览里的某一行（子元素 pointer-events:none，事件目标就是行本身） */
  const clickRow = (document, listId, id) => fire(document.getElementById(listId), 'click', {
    target: { getAttribute: (k) => (k === 'data-sl' ? String(id) : null) },
  });
  /** 点查找项卡片上的某个操作（data-act="动作:组id[:图层id]"） */
  const grpAct = (document, act) => fire(document.getElementById('slGroupList'), 'click', {
    target: { getAttribute: (k) => (k === 'data-act' ? act : null) },
  });
  /** 查一批并加进查找列表 */
  const addBatch = (document, kw) => {
    type(document, 'slFindText', kw);
    click(document, 'slAddBtn');
  };

  it('入口那一行显示当前选中数；没打开文档时点查找只提示', async () => {
    const a = await loadPanel();
    expect(a.document.getElementById('targetInfo').textContent).toBe('未打开文档');
    open(a.document);
    expect(a.document.getElementById('slOverlay').style.display).not.toBe('flex');
    expect(a.document.getElementById('status').textContent).toMatch(/请先打开一个 PSD 文档/);

    const b = await loadPanel({ doc: doc([13]) });
    expect(b.document.getElementById('targetInfo').textContent).toBe('已选中 1 个图层/组');
  });

  it('打开时停在查找视图，并把页面上的输入框藏起来（UXP 文字控件恒在最上层）', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    expect(document.getElementById('slOverlay').style.display).toBe('flex');
    expect(shown(document, 'slSearchView')).toBe(true);
    expect(shown(document, 'slListView')).toBe(false);
    expect(document.getElementById('findText').style.visibility).toBe('hidden');
    expect(document.getElementById('templateText').style.visibility).toBe('hidden');
    expect(document.getElementById('slFindText').style.visibility).not.toBe('hidden');
    click(document, 'slCloseBtn');                                     // 右上角 ✕
    expect(document.getElementById('slOverlay').style.display).toBe('none');
    expect(document.getElementById('findText').style.visibility).toBe('');
  });

  it('搜索：列出命中的层（默认全勾 + 路径 + 命中高亮 + 类型小字）并给出统计', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    expect(count(document)).toBe('输入查找内容后显示结果');
    type(document, 'slFindText', 'btn');
    expect(count(document)).toBe('搜索结果（找到 3 项，已勾选 3 项）');
    const html = listHtml(document);
    expect((html.match(/class="sl-item on"/g) || []).length).toBe(3);
    expect(html).toMatch(/<span class="sl-path">UI \/ <\/span>/);      // 组内层带上父级路径
    expect(html).toMatch(/<span class="sl-hit">Btn<\/span>_normal/);   // 命中片段高亮
    expect(html).toMatch(/<span class="sl-hit">BTN<\/span>_hover/);    // 默认不分大小写
    expect(html).toMatch(/<span class="sl-kind">图层<\/span>/);
    expect(html).not.toMatch(/Title/);
    expect(document.getElementById('slAddBtn').textContent).toBe('＋ 添加到查找列表（3 项）');

    type(document, 'slFindText', 'zzz');
    expect(count(document)).toBe('没有名称匹配的图层');
    expect(document.getElementById('slAddBtn').classList.contains('btn-off')).toBe(true);
  });

  it('「搜索」按钮与框内回车都能触发搜索（不依赖输入事件）', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    document.getElementById('slFindText').value = 'btn';               // 只赋值，不触发 input
    expect(listHtml(document)).not.toMatch(/data-sl=/);
    click(document, 'slSearchBtn');
    expect(count(document)).toBe('搜索结果（找到 3 项，已勾选 3 项）');

    document.getElementById('slFindText').value = 'title';
    fire(document.getElementById('slFindText'), 'keydown', { key: 'Enter', preventDefault() {} });
    expect(count(document)).toBe('搜索结果（找到 1 项，已勾选 1 项）');
    expect(shown(document, 'slSearchView')).toBe(true);                // 回车不等于确认
  });

  it('点行取消勾选 / 全选 / 反选 / 清空关键词', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    type(document, 'slFindText', 'btn');
    clickRow(document, 'slList', 12);
    expect(count(document)).toBe('搜索结果（找到 3 项，已勾选 2 项）');
    click(document, 'slInvBtn');                                       // 反选 → 只剩 12
    expect(count(document)).toBe('搜索结果（找到 3 项，已勾选 1 项）');
    expect(listHtml(document)).toMatch(/class="sl-item on" data-sl="12"/);
    click(document, 'slAllBtn');
    expect(count(document)).toBe('搜索结果（找到 3 项，已勾选 3 项）');
    click(document, 'slFindClear');
    expect(document.getElementById('slFindText').value).toBe('');
    expect(count(document)).toBe('输入查找内容后显示结果');
  });

  it('排序下拉：默认图层顺序，选「按名称」只换看的顺序', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    expect(document.getElementById('slSortValue').textContent).toBe('图层顺序');
    type(document, 'slFindText', 'btn');
    const docOrder = listHtml(document);
    expect(docOrder.indexOf('data-sl="11"')).toBeLessThan(docOrder.indexOf('data-sl="13"'));
    clickDdItem(document, 'slSortDd', 'data-sort', 'name');
    expect(document.getElementById('slSortValue').textContent).toBe('按名称');
    const nameOrder = listHtml(document);
    // 按名称：bg_btn 排到最前（b-g 在 b-t 之前），图层顺序里它却是最后一个
    expect(nameOrder.indexOf('data-sl="13"')).toBeLessThan(nameOrder.indexOf('data-sl="11"'));
    expect(nameOrder.indexOf('data-sl="13"')).toBeLessThan(nameOrder.indexOf('data-sl="12"'));
  });

  it('添加到查找列表：折成一张卡片（关键词 / 条件 / 名字），下方预览列出全部', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    type(document, 'slFindText', 'btn');
    clickRow(document, 'slList', 12);                                  // 这批不要 BTN_hover
    click(document, 'slAddBtn');

    expect(shown(document, 'slListView')).toBe(true);                  // 自动回到查找项视图
    expect(shown(document, 'slSearchView')).toBe(false);
    expect(grpHead(document)).toBe('已添加的查找项（1 组，共 3 项）');
    const g = grpHtml(document);
    expect(g).toMatch(/class="sl-grp-key">btn</);
    expect(g).toMatch(/2\/3 项/);                                      // 勾了 2 个、共命中 3 个
    // 默认折叠：只有头一行，条件与名字都不画
    expect(g).toMatch(/data-act="fold:1">▶</);
    expect(g).not.toMatch(/包含 · 整个文档 · 全部/);
    expect(g).not.toMatch(/Btn_normal/);
    // 卡片头是「开关 + 两个小图标」：启用态带 .on，编辑/删除各是一个 data-act 的图标钮
    expect(g).toMatch(/class="sl-sw switch on" data-act="on:1"/);
    expect(g).toMatch(/class="sl-ico-btn" data-act="edit:1"/);
    expect(g).toMatch(/class="sl-ico-btn" data-act="del:1"/);
    expect(g).toMatch(/class="sl-grp-ico"/);                           // 关键词前的放大镜
    expect(g).not.toMatch(/启用|编辑|删除/);                            // 文字按钮已换成图标

    grpAct(document, 'fold:1');                                        // 展开：条件 + 勾选中的名字
    const open1 = grpHtml(document);
    expect(open1).toMatch(/包含 · 整个文档 · 全部/);
    expect(open1).toMatch(/class="sl-chip on" data-act="chip:1:11">Btn_normal</);
    expect(open1).not.toMatch(/☑|☐/);                                  // 名字前不再画勾选框
    expect(open1).not.toMatch(/BTN_hover/);                            // 卡片只列勾选中的名字
    expect(prevHead(document)).toBe('全部匹配结果预览（共 2 项）');
    expect(prevHtml(document)).toMatch(/来自: btn/);
    expect(prevHtml(document)).not.toMatch(/data-sl="12"/);
    expect(okLabel(document)).toBe('确认（选中 2 项）');
    // 关键词已清空，方便接着查下一批
    expect(document.getElementById('slFindText').value).toBe('');
  });

  it('继续添加：多个关键词形成多张卡片，预览合并且按 id 去重', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    addBatch(document, 'btn');
    click(document, 'slMoreBtn');                                      // 继续添加 → 回查找视图
    expect(shown(document, 'slSearchView')).toBe(true);
    addBatch(document, 'title');
    expect(grpHead(document)).toBe('已添加的查找项（2 组，共 4 项）');
    expect(prevHead(document)).toBe('全部匹配结果预览（共 4 项）');

    click(document, 'slMoreBtn');
    addBatch(document, 'bg_btn');                                      // 与第一批重复命中 13
    expect(grpHead(document)).toBe('已添加的查找项（3 组，共 5 项）');
    expect(prevHead(document)).toBe('全部匹配结果预览（共 4 项）');     // 去重后还是 4
    expect((prevHtml(document).match(/data-sl="13"/g) || []).length).toBe(1);
  });

  it('卡片：停用 / 启用 / 删除 / 折叠 / 单个名字取消勾选', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    addBatch(document, 'btn');
    click(document, 'slMoreBtn');
    addBatch(document, 'title');
    expect(prevHead(document)).toBe('全部匹配结果预览（共 4 项）');

    grpAct(document, 'on:1');                                          // 关掉第一张卡的开关
    expect(grpHtml(document)).toMatch(/class="sl-grp off"/);
    expect(grpHtml(document)).toMatch(/class="sl-sw switch" data-act="on:1"/);   // 开关回到关态
    expect(prevHead(document)).toBe('全部匹配结果预览（共 1 项）');
    grpAct(document, 'on:1');                                          // 再点回来
    expect(prevHead(document)).toBe('全部匹配结果预览（共 4 项）');

    grpAct(document, 'fold:1');                                        // 展开第一张卡才看得到名字
    expect(grpHtml(document)).toMatch(/BTN_hover/);
    expect(grpHtml(document)).not.toMatch(/Title/);                    // 另一张卡还是折着的
    grpAct(document, 'chip:1:11');                                     // 取消这张卡里的 Btn_normal
    expect(grpHtml(document)).not.toMatch(/Btn_normal/);               // 取消后它就不在卡片上了
    expect(grpHtml(document)).toMatch(/2\/3 项/);                      // 头上的数字跟着变
    expect(prevHead(document)).toBe('全部匹配结果预览（共 3 项）');

    grpAct(document, 'fold:1');                                        // 折回去：条件与名字都不显示
    expect(grpHtml(document)).not.toMatch(/BTN_hover/);
    expect(grpHtml(document)).not.toMatch(/包含 · 整个文档/);
    grpAct(document, 'fold:2');                                        // 另一张卡各自记自己的开合
    expect(grpHtml(document)).toMatch(/data-act="chip:2:14">Title</);

    grpAct(document, 'del:2');                                         // 删掉第二张卡
    expect(grpHead(document)).toBe('已添加的查找项（1 组，共 3 项）');
    expect(prevHead(document)).toBe('全部匹配结果预览（共 2 项）');
  });

  it('预览里点某一行 = 从所有卡片里取消它；「全选」把勾选恢复回来', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    addBatch(document, 'btn');
    click(document, 'slMoreBtn');
    addBatch(document, 'bg_btn');                                      // 13 同时在两张卡里
    expect(prevHead(document)).toBe('全部匹配结果预览（共 3 项）');
    clickRow(document, 'slPrevList', 13);
    expect(prevHead(document)).toBe('全部匹配结果预览（共 2 项）');
    expect(grpHtml(document)).toMatch(/2\/3 项/);                      // 第一张卡：3 命中里勾 2
    expect(grpHtml(document)).toMatch(/0\/1 项/);                      // 第二张卡：勾空了
    grpAct(document, 'fold:1');                                        // 两张卡里的 bg_btn 都取消了
    grpAct(document, 'fold:2');
    expect(grpHtml(document)).not.toMatch(/chip:1:13|chip:2:13/);
    expect(grpHtml(document)).toMatch(/这一项没有勾选任何图层/);
    click(document, 'slPrevAllBtn');
    expect(prevHead(document)).toBe('全部匹配结果预览（共 3 项）');
  });

  it('清空全部：卡片清零，确认按钮置灰且点了不下发', async () => {
    const d = doc();
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    open(document);
    addBatch(document, 'btn');
    click(document, 'slClearBtn');
    expect(grpHead(document)).toBe('已添加的查找项');
    expect(prevHead(document)).toBe('全部匹配结果预览（共 0 项）');
    expect(grpHtml(document)).toMatch(/还没有查找项/);
    expect(document.getElementById('slOkBtn').classList.contains('btn-off')).toBe(true);
    played.length = 0;
    click(document, 'slOkBtn');
    await settle();
    expect(played).toEqual([]);
    expect(shown(document, 'slListView')).toBe(true);                  // 弹窗留着
  });

  it('编辑卡片：条件回填、原来没勾的保持没勾，保存后替换而不是新增', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    type(document, 'slFindText', 'btn');
    clickPill(document, 'slMatchPills', 'data-match', 'prefix');       // 前缀匹配 → 11 / 12
    clickRow(document, 'slList', 12);                                  // 只留 11
    click(document, 'slAddBtn');
    expect(grpHead(document)).toBe('已添加的查找项（1 组，共 2 项）');
    grpAct(document, 'fold:1');
    expect(grpHtml(document)).toMatch(/前缀 · 整个文档 · 全部/);

    grpAct(document, 'edit:1');
    expect(shown(document, 'slSearchView')).toBe(true);
    expect(document.getElementById('slFindText').value).toBe('btn');   // 关键词回填
    expect(activeOf(document, 'slMatchPills', 'data-match')).toBe('prefix');
    expect(count(document)).toBe('搜索结果（找到 2 项，已勾选 1 项）');  // 原来没勾的仍没勾
    expect(document.getElementById('slAddBtn').textContent).toBe('保存修改（1 项）');

    click(document, 'slAllBtn');
    click(document, 'slAddBtn');
    expect(grpHead(document)).toBe('已添加的查找项（1 组，共 2 项）');   // 替换，不是变成 2 组
    expect(prevHead(document)).toBe('全部匹配结果预览（共 2 项）');
  });

  it('「返回列表」放弃这次查找 / 编辑，卡片保持原样', async () => {
    const { document } = await loadPanel({ doc: doc() });
    open(document);
    addBatch(document, 'btn');
    click(document, 'slMoreBtn');
    type(document, 'slFindText', 'title');
    click(document, 'slBackBtn');
    expect(shown(document, 'slListView')).toBe(true);
    expect(grpHead(document)).toBe('已添加的查找项（1 组，共 3 项）');
    expect(prevHtml(document)).not.toMatch(/data-sl="14"/);
  });

  it('确认：把预览里的层设为当前选中、关弹窗，直接进重命名预览', async () => {
    const d = doc([14]);                                               // 原本选着 Title
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    open(document);
    addBatch(document, 'btn');
    played.length = 0;
    click(document, 'slOkBtn');
    await settle();
    const sels = selectDescs(played);
    expect(selectsFrom(played).slice().sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(sels[0].selectionModifier).toBeUndefined();                 // 第一个替换选区
    expect(sels[1].selectionModifier._value).toBe('addToSelection');   // 其余追加
    expect(sels.every((p) => p.makeVisible === false)).toBe(true);     // 不点亮隐藏层
    expect(document.getElementById('slOverlay').style.display).toBe('none');
    expect(document.getElementById('targetInfo').textContent).toBe('已选中 3 个图层/组');
    expect(document.getElementById('status').textContent).toMatch(/已选中 3 个图层\/组/);
    const preview = document.getElementById('previewList').innerHTML;
    expect(preview).toMatch(/Btn_normal/);
    expect(preview).not.toMatch(/Title/);                              // 原来的选中被替换掉
  });

  it('取消：不下发任何描述符，选中不变', async () => {
    const d = doc([14]);
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    open(document);
    addBatch(document, 'btn');
    played.length = 0;
    click(document, 'slCancelBtn');
    await settle();
    expect(played).toEqual([]);
    expect(document.getElementById('targetInfo').textContent).toBe('已选中 1 个图层/组');
  });

  it('重新打开：上一次的查找项清零，不会把它们又提交一遍', async () => {
    const d = doc();
    const { document } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    open(document);
    addBatch(document, 'btn');
    click(document, 'slCancelBtn');
    open(document);
    expect(shown(document, 'slSearchView')).toBe(true);
    expect(document.getElementById('slFindText').value).toBe('');
    click(document, 'slBackBtn');                                      // 没有卡片时这个入口是藏着的
    expect(shown(document, 'slBackBtn')).toBe(false);
  });

  it('范围=已选中的组内：确认后组内命中的层真的进预览（父组不再留在选中里）', async () => {
    const d = doc([10]);                                               // 选中 UI 组
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    open(document);
    clickPill(document, 'slScopePills', 'data-scope', 'sel');
    type(document, 'slFindText', 'btn');
    expect(count(document)).toBe('搜索结果（找到 2 项，已勾选 2 项）');  // bg_btn 在组外，不该命中
    click(document, 'slAddBtn');
    played.length = 0;
    click(document, 'slOkBtn');
    await settle();
    expect(selectsFrom(played).slice().sort((a, b) => a - b)).toEqual([11, 12]);
    expect(document.getElementById('targetInfo').textContent).toBe('已选中 2 个图层/组');
    const preview = document.getElementById('previewList').innerHTML;
    expect(preview).toMatch(/Btn_normal/);                             // 组内子层进了预览
    expect(preview).toMatch(/BTN_hover/);
    expect(preview).not.toMatch(/>UI</);                               // 父组已不在选中里
  });

  it('「含隐藏图层」默认勾选，且不跨会话记忆（上次关掉了也照样勾回来）', async () => {
    const d = fakeLayerDoc([fakeLayer(40, 'btn_on'), fakeLayer(41, 'btn_off', { visible: false })]);
    const { document } = await loadPanel({ doc: d, prefs: { 'rename.f.hidden': '0' } });
    open(document);
    expect(document.querySelector('#slFlagPills .pill[data-flag="hidden"]').classList.contains('active')).toBe(true);
    type(document, 'slFindText', 'btn');
    expect(count(document)).toBe('搜索结果（找到 2 项，已勾选 2 项）');
    expect(listHtml(document)).toMatch(/图层 · 隐藏/);
  });

  it('背景图层一并查出来并标「背景」（给它改名会被 PS 转成普通图层）', async () => {
    const d = fakeLayerDoc([fakeLayer(30, 'btn_1'), fakeLayer(31, 'btn_bg', { isBackgroundLayer: true })]);
    const { document } = await loadPanel({ doc: d });
    open(document);
    type(document, 'slFindText', 'btn');
    expect(count(document)).toBe('搜索结果（找到 2 项，已勾选 2 项）');
    const html = listHtml(document);
    expect(html).toMatch(/data-sl="31"/);
    expect(html).toMatch(/图层 · 背景/);
  });

  it('加入列表后图层被删掉：确认时跳过并如实报出', async () => {
    const d = doc();
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    open(document);
    addBatch(document, 'btn');
    d.layers = d.layers.filter((l) => l.id !== 13);                    // PS 里把 bg_btn 删了
    played.length = 0;
    click(document, 'slOkBtn');
    await settle();
    expect(selectsFrom(played).slice().sort((a, b) => a - b)).toEqual([11, 12]);
    expect(document.getElementById('status').textContent).toMatch(/1 个已不存在，已跳过/);
  });

  it('选中组 + 组内的图层：组名与组内层名各改自己的（不再只改组名）', async () => {
    const d = doc([10, 11]);                                           // UI 组 + 组里的 Btn_normal
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    expect(document.getElementById('targetInfo').textContent).toBe('已选中 2 个图层/组');
    clickPill(document, 'renameModePills', 'data-mode', 'prefix');
    type(document, 'templateText', 'X_');
    await settle();
    const preview = document.getElementById('previewList').innerHTML;
    expect(preview).toMatch(/X_UI/);
    expect(preview).toMatch(/X_Btn_normal/);
    played.length = 0;
    fire(document.getElementById('renameBtn'), 'click');
    await settle();
    // 组排在组内层前面（面板顺序：组名那一行在上）
    expect(renamesFrom(played)).toEqual([[10, 'X_UI'], [11, 'X_Btn_normal']]);
    expect(document.getElementById('status').textContent).toMatch(/已重命名 2 个图层\/组/);
  });

  it('查找选中之后照常改名：编号按图层面板从上到下', async () => {
    const d = doc();
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    open(document);
    addBatch(document, 'btn');
    click(document, 'slOkBtn');
    await settle();
    type(document, 'findText', 'btn');                                 // 替换：查找内容仍是自己填
    type(document, 'templateText', 'icon_n');
    fire(document.getElementById('counterSwitch'), 'click');           // 数字编号 n
    await settle();
    played.length = 0;
    fire(document.getElementById('renameBtn'), 'click');
    await settle();
    // 替换本身区分大小写：Btn_normal / BTN_hover 里没有小写 btn，只有 bg_btn 被改
    expect(renamesFrom(played)).toEqual([[13, 'bg_icon_1']]);
    expect(document.getElementById('status').textContent).toMatch(/已重命名 1 个图层\/组/);
    expect(document.getElementById('status').textContent).toMatch(/3 个中有 2 个未找到匹配内容/);
  });
});

// 一份「PS 执行完 newGuideLayout 后发回来的」描述符。形状照真机抓到的来：
// 参数【平铺在顶层】、列是 colCount（不是 columnCount）、末尾还跟着参考线颜色
function layoutEvent(over = {}) {
  const px = (v) => ({ _unit: 'pixelsUnit', _value: v });
  return Object.assign({
    _obj: 'newGuideLayout',
    colCount: 4,
    colGutter: px(20),
    rowCount: 3,
    rowGutter: px(20),
    marginTop: px(40),
    marginLeft: px(40),
    marginBottom: px(40),
    marginRight: px(40),
    centerColumns: false,
    clearExistingGuides: true,
    $GdCA: 0, $GdCR: 74, $GdCG: 255, $GdCB: 255,
  }, over);
}

/** 「插件正在开那个原生弹窗」= 播放菜单项 视图 > 新建参考线版面 */
function isMenuOpen(d) {
  return d._obj === 'select' && d._target && d._target[0]
    && d._target[0]._ref === 'menuItemClass' && d._target[0]._value === 'newGuideLayout';
}
/** 菜单项这条路走不通（老版本 / 菜单被禁用）时 PS 抛的错 */
function menuUnavailable(d) {
  if (isMenuOpen(d)) throw new Error('menu item not available');
}

describe('参考线：原生弹窗 → 通知 → 记录 → 一键重放', () => {
  it('弹窗走菜单项打开：不传任何参数，初值交给 Photoshop 自己记', async () => {
    const doc = fakeDoc(1920, 1080);
    const { document, played, notify } = await loadPanel({
      doc,
      onPlay: (d) => {
        if (isMenuOpen(d)) doc.guides = fakeGuides([{ direction: 'vertical', coordinate: 40 }]);
      },
    });

    played.length = 0;
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 1600));
    const first = played.filter(isMenuOpen);
    expect(first.length).toBe(1);
    expect(first[0]._options.dialogOptions).toBe('display');     // 要弹窗，不是静默执行
    // 关键：一个 newGuideLayout 描述符都不下发 —— 传了 PS 就会拿它顶掉自己的「上次设置」
    expect(played.filter((d) => d._obj === 'newGuideLayout')).toEqual([]);
    expect(guidesFrom(played)).toEqual({ vertical: [], horizontal: [] });   // 插件不自己建

    // 已经建过一版之后再点开，仍然只播菜单项：第二次的初值由 PS 带出上一次的设置
    await notify('newGuideLayout', layoutEvent({ colCount: 6, rowCount: 4 }));
    played.length = 0;
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 1600));
    expect(played.filter(isMenuOpen).length).toBe(1);
    expect(played.filter((d) => d._obj === 'newGuideLayout')).toEqual([]);
  });

  it('菜单项打不开时才退回预填：按上一条记录把数值填进弹窗', async () => {
    const doc = fakeDoc(1920, 1080);
    const { document, played, notify } = await loadPanel({
      doc,
      onPlay: (d) => {
        menuUnavailable(d);
        if (d._obj === 'newGuideLayout') doc.guides = fakeGuides([{ direction: 'vertical', coordinate: 40 }]);
      },
    });
    await notify('newGuideLayout', layoutEvent({ colCount: 6, rowCount: 4 }));
    played.length = 0;
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 1600));
    const dlg = played.filter((d) => d._obj === 'newGuideLayout');
    expect(dlg.length).toBe(1);
    expect(dlg[0]._options.dialogOptions).toBe('display');
    expect(dlg[0].colCount).toBe(6);                             // 上一条的列数
    expect(dlg[0].rowCount).toBe(4);
    expect(dlg[0].colGutter).toEqual({ _unit: 'pixelsUnit', _value: 20 });
    expect(dlg[0].marginTop).toEqual({ _unit: 'pixelsUnit', _value: 40 });
    // 这条路不是原生记忆，状态栏得说清楚
    expect(document.getElementById('status').textContent).toMatch(/按上一条记录预填/);
  });

  it('退回预填时把每个键都写满：上次没设的那块填 0，PS 才不会拿默认值顶上', async () => {
    const doc = fakeDoc(1920, 1080);
    const { document, played, notify } = await loadPanel({
      doc,
      onPlay: (d) => {
        menuUnavailable(d);
        if (d._obj === 'newGuideLayout') doc.guides = fakeGuides([{ direction: 'vertical', coordinate: 40 }]);
      },
    });
    // 上一次只设了行，列与边距都没设
    await notify('newGuideLayout', {
      _obj: 'newGuideLayout', rowCount: 5, $GdCR: 74,
    });
    played.length = 0;
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 1600));
    const d = played.filter((x) => x._obj === 'newGuideLayout')[0];
    const zero = { _unit: 'pixelsUnit', _value: 0 };
    expect(d.rowCount).toBe(5);
    expect(d.colCount).toBe(0);                                  // 列没设 → 明写 0（弹窗里为空）
    expect(d.colGutter).toEqual(zero);
    expect(d.marginTop).toEqual(zero);                           // 边距同理，不能让 PS 填 20
    expect(d.marginRight).toEqual(zero);
  });

  it('预填那份也被 PS 拒收时，退回空手打开（弹窗照开）', async () => {
    const doc = fakeDoc(1920, 1080);
    const { document, played, notify } = await loadPanel({
      doc,
      onPlay: (d) => {
        menuUnavailable(d);
        if (d._obj === 'newGuideLayout' && ('colCount' in d || d.guideLayout)) {
          throw new Error('bad param');
        }
      },
    });
    await notify('newGuideLayout', layoutEvent());
    played.length = 0;
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 100));
    const dlg = played.filter((d) => d._obj === 'newGuideLayout');
    expect(dlg.length).toBe(3);                                  // 平铺 → 嵌套 → 空手
    expect(Object.keys(dlg[2]).sort()).toEqual(['_obj', '_options']);
  });

  it('弹窗被取消：状态如实说没变化，也不记录', async () => {
    const doc = fakeDoc(1920, 1080);
    const { document } = await loadPanel({
      doc,
      onPlay: (d) => {
        if (!isMenuOpen(d)) return;
        const e = new Error('User cancelled');                   // PS 取消弹窗就是抛错
        e.number = 9;
        throw e;
      },
    });
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 800));               // 弹窗返回后还会等一小会儿通知
    expect(document.getElementById('status').textContent).toMatch(/已取消，文档里的参考线没有变化/);
    expect(document.getElementById('gdRecentBtn').textContent).toBe('最近使用');
  });

  it('PS 发回 newGuideLayout 通知 → 记入最近使用，弹窗列表里显示实际参数', async () => {
    const { document, notify } = await loadPanel({ doc: fakeDoc(1920, 1080) });
    await notify('newGuideLayout', layoutEvent());
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('gdRecentBtn').textContent).toBe('最近使用 (1)');
    fire(document.getElementById('gdRecentBtn'), 'click');
    const html = document.getElementById('gdList').innerHTML;
    expect(html).toMatch(/4列 \/ 3行/);
    expect(html).toMatch(/列 4 · 宽度自动 · 装订线 20px/);
    expect(html).toMatch(/行 3 · 高度自动 · 装订线 20px/);
    expect(html).toMatch(/边距 40px/);
    expect(html).toMatch(/1920 × 1080/);
  });

  it('真机键名（colCount / 平铺 / 带颜色）能完整读出列与行', async () => {
    const { document, notify } = await loadPanel({ doc: fakeDoc(1151, 1002) });
    await notify('newGuideLayout', {
      _obj: 'newGuideLayout',
      colCount: 5, rowCount: 2,                      // ← 真机抓到的那一份
      $GdCA: 0, $GdCR: 74, $GdCG: 255, $GdCB: 255,
    });
    expect(document.getElementById('gdRecentBtn').textContent).toBe('最近使用 (1)');
    fire(document.getElementById('gdRecentBtn'), 'click');
    const html = document.getElementById('gdList').innerHTML;
    expect(html).toMatch(/5列 \/ 2行/);                // 列不再被漏掉
    expect(html).toMatch(/列 5 · 宽度自动/);
    expect(html).toMatch(/行 2 · 高度自动/);
  });

  it('只设了行时，摘要里把「列 未设置」也写出来（不是把列漏掉）', async () => {
    const { document, notify } = await loadPanel({ doc: fakeDoc(1151, 1002) });
    await notify('newGuideLayout', layoutEvent({
      colCount: 0, colGutter: { _unit: 'pixelsUnit', _value: 0 },
      rowCount: 5, rowGutter: { _unit: 'pixelsUnit', _value: 0 },
      marginTop: { _unit: 'pixelsUnit', _value: 0 },
      marginLeft: { _unit: 'pixelsUnit', _value: 0 },
      marginBottom: { _unit: 'pixelsUnit', _value: 0 },
      marginRight: { _unit: 'pixelsUnit', _value: 0 },
    }));
    fire(document.getElementById('gdRecentBtn'), 'click');
    const html = document.getElementById('gdList').innerHTML;
    expect(html).toMatch(/列 未设置/);
    expect(html).toMatch(/行 5 · 高度自动 · 装订线 0px/);
    expect(html).toMatch(/边距 未设置/);
  });

  it('PS 用了插件不认识的参数键时，状态栏如实报出来', async () => {
    const doc = fakeDoc(1920, 1080);
    const { document } = await loadPanel({
      doc,
      onPlay: (d) => {
        if (!isMenuOpen(d)) return null;
        doc.guides = fakeGuides([{ direction: 'horizontal', coordinate: 40 }]);
        // colCnt 不在别名表里；$Gd* 是参考线颜色，不该算作「没认出来」
        return { _obj: 'newGuideLayout', rowCount: 5, colCnt: 4, $GdCR: 74 };
      },
    });
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 800));
    const status = document.getElementById('status').textContent;
    expect(status).toMatch(/^已创建参考线版面：5行；/);                 // 摘要只留标题
    expect(status).toMatch(/有没认出来的参数：colCnt=4/);              // 带上值，一眼看清
    expect(status).not.toMatch(/GdCR/);                                // 颜色键不算
  });

  it('参数一样的第二次不堆记录，只提到最前；参数不同才新增一条', async () => {
    const { document, notify } = await loadPanel({ doc: fakeDoc(1920, 1080) });
    await notify('newGuideLayout', layoutEvent());
    await notify('newGuideLayout', layoutEvent());
    expect(document.getElementById('gdRecentBtn').textContent).toBe('最近使用 (1)');
    await notify('newGuideLayout', layoutEvent({ colCount: 6 }));
    expect(document.getElementById('gdRecentBtn').textContent).toBe('最近使用 (2)');
    fire(document.getElementById('gdRecentBtn'), 'click');
    expect(document.getElementById('gdList').innerHTML).toMatch(/6列 \/ 3行/);
  });

  it('通知里的百分比单位按画布折算成 px', async () => {
    const { document, notify } = await loadPanel({ doc: fakeDoc(1000, 500) });
    await notify('newGuideLayout', layoutEvent({
      colCount: 2,
      colGutter: { _unit: 'percentUnit', _value: 10 },         // 1000 的 10% = 100
      rowCount: 0,
      marginTop: { _unit: 'percentUnit', _value: 20 },            // 500 的 20% = 100
      marginLeft: { _unit: 'pixelsUnit', _value: 0 },
      marginBottom: { _unit: 'pixelsUnit', _value: 0 },
      marginRight: { _unit: 'pixelsUnit', _value: 0 },
    }));
    fire(document.getElementById('gdRecentBtn'), 'click');
    const html = document.getElementById('gdList').innerHTML;
    expect(html).toMatch(/列 2 · 宽度自动 · 装订线 100px/);
    expect(html).toMatch(/行 未设置/);                              // 没设的那块明写出来
    expect(html).toMatch(/边距 上100 下0 左0 右0/);
  });

  it('没有通知也要记录：对比弹窗前后的参考线，把这一版反推出来', async () => {
    const doc = fakeDoc(1920, 1080);
    // 菜单项那条路 batchPlay 不回传参数，通知也没来 —— 只剩文档里的线可看
    const { document } = await loadPanel({
      doc,
      onPlay: (d) => {
        if (!isMenuOpen(d)) return;
        doc.guides = fakeGuides([100, 515, 535, 950, 970, 1385, 1405, 1820]
          .map((coordinate) => ({ direction: 'vertical', coordinate })));
      },
    });
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 1200));
    const status = document.getElementById('status').textContent;
    expect(status).toBe('已创建参考线版面：4列');          // 状态栏只报摘要，详情在记录里看
    expect(document.getElementById('gdRecentBtn').textContent).toBe('最近使用 (1)');

    fire(document.getElementById('gdRecentBtn'), 'click');
    const html = document.getElementById('gdList').innerHTML;
    expect(html).toMatch(/列 4 · 宽度自动 · 装订线 20px/);
    expect(html).toMatch(/边距 上0 下0 左100 右100/);
  });

  it('反推也认不出来的形状：如实说明没记录，不编一条假的', async () => {
    const doc = fakeDoc(1920, 1080);
    const { document } = await loadPanel({
      doc,
      onPlay: (d) => {
        if (isMenuOpen(d)) doc.guides = fakeGuides([{ direction: 'vertical', coordinate: 40 }]);
      },
    });
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 1200));
    expect(document.getElementById('status').textContent).toMatch(/没能读出这一版的参数/);
    expect(document.getElementById('gdRecentBtn').textContent).toBe('最近使用');
  });

  it('点记录里的「应用」= 不弹窗直接重放那一版', async () => {
    const { document, played, notify, recordAction } = await loadPanel({ doc: fakeDoc(1920, 1080) });
    await notify('newGuideLayout', layoutEvent());
    fire(document.getElementById('gdRecentBtn'), 'click');
    played.length = 0;

    fire(recordAction('rec-apply:0'), 'click');
    await new Promise((r) => setTimeout(r, 0));

    const dlg = played.filter((d) => d._obj === 'newGuideLayout');
    expect(dlg.length).toBe(1);
    expect(dlg[0]._options.dialogOptions).toBe('dontDisplay');   // 不弹窗
    expect(dlg[0].colCount).toBe(4);                             // 用 PS 认的键名重放
    expect(dlg[0].rowCount).toBe(3);
    expect(dlg[0].marginRight).toEqual({ _unit: 'pixelsUnit', _value: 40 });
    expect(document.getElementById('status').textContent).toMatch(/已应用/);
  });

  it('原生版面命令不可用时，「应用」退回插件自己算坐标', async () => {
    const doc = fakeDoc(1920, 1080);
    const { document, played, notify, recordAction } = await loadPanel({
      doc,
      onPlay: (d) => { if (d._obj === 'newGuideLayout') throw new Error('nope'); },
    });
    await notify('newGuideLayout', layoutEvent());
    fire(document.getElementById('gdRecentBtn'), 'click');
    played.length = 0;

    fire(recordAction('rec-apply:0'), 'click');
    await new Promise((r) => setTimeout(r, 0));

    // 4 列 / 3 行 / 装订线 20 / 边距 40 在 1920×1080 上的坐标（与 guide-core 单测同一组）
    expect(guidesFrom(played)).toEqual({
      vertical: [40, 485, 505, 950, 970, 1415, 1435, 1880],
      horizontal: [40, 360, 380, 700, 720, 1040],
    });
    expect(document.getElementById('status').textContent).toMatch(/已由插件直接创建/);
  });

  it('☆ 收藏后进「收藏版面」，入口带条数', async () => {
    const { document, notify, recordAction } = await loadPanel({ doc: fakeDoc(1920, 1080) });
    await notify('newGuideLayout', layoutEvent());
    fire(document.getElementById('gdRecentBtn'), 'click');
    fire(recordAction('rec-star:0'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    fire(document.getElementById('gdNameOk'), 'click');           // 起名弹窗按默认名确定
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('gdFavBtn').textContent).toBe('收藏版面 (1)');
    expect(document.getElementById('status').textContent).toMatch(/已收藏为/);
  });

  it('收藏当前版面：认出画布上现成的那套版面，直接进收藏', async () => {
    const doc = fakeDoc(1920, 1080);
    doc.guides = fakeGuides([100, 515, 535, 950, 970, 1385, 1405, 1820]
      .map((coordinate) => ({ direction: 'vertical', coordinate })));
    const { document } = await loadPanel({ doc });

    fire(document.getElementById('gdFavNowBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    fire(document.getElementById('gdNameOk'), 'click');            // 按默认名确定
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('gdFavBtn').textContent).toBe('收藏版面 (1)');
    expect(document.getElementById('status').textContent).toMatch(/已收藏为「4列/);

    fire(document.getElementById('gdFavBtn'), 'click');
    expect(document.getElementById('gdList').innerHTML)
      .toMatch(/列 4 · 宽度自动 · 装订线 20px/);
  });

  it('收藏当前版面：同一套线再收藏一次只提示，不堆第二条', async () => {
    const doc = fakeDoc(1920, 1080);
    doc.guides = fakeGuides([0, 480, 960, 1440, 1920]
      .map((coordinate) => ({ direction: 'vertical', coordinate })));
    const { document } = await loadPanel({ doc });
    fire(document.getElementById('gdFavNowBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    fire(document.getElementById('gdNameOk'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    fire(document.getElementById('gdFavNowBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('gdFavBtn').textContent).toBe('收藏版面 (1)');
    expect(document.getElementById('status').textContent).toMatch(/已经在收藏里了/);
  });

  it('收藏当前版面：不是规则版面就按原坐标存，应用时逐条还原', async () => {
    const doc = fakeDoc(1920, 1080);
    doc.guides = fakeGuides([
      { direction: 'vertical', coordinate: 13 },
      { direction: 'vertical', coordinate: 500 },
      { direction: 'horizontal', coordinate: 777 },
    ]);
    const { document, played, recordAction } = await loadPanel({ doc });
    fire(document.getElementById('gdFavNowBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    fire(document.getElementById('gdNameOk'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('status').textContent).toMatch(/按原坐标存下来了/);

    fire(document.getElementById('gdFavBtn'), 'click');
    expect(document.getElementById('gdList').innerHTML).toMatch(/纵 2 条 \/ 横 1 条/);
    played.length = 0;
    fire(recordAction('fav-apply:0'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(guidesFrom(played)).toEqual({ vertical: [13, 500], horizontal: [777] });
  });

  it('收藏当前版面：文档里一条参考线都没有时只提示', async () => {
    const { document } = await loadPanel({ doc: fakeDoc(1920, 1080) });
    fire(document.getElementById('gdFavNowBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('status').textContent).toMatch(/还没有参考线/);
    expect(document.getElementById('gdFavBtn').textContent).toBe('收藏版面');
  });

  it('没有记录时两个入口都置灰', async () => {
    const { document } = await loadPanel({ doc: fakeDoc(1920, 1080) });
    expect(document.getElementById('gdRecentBtn').textContent).toBe('最近使用');
    expect(document.getElementById('gdRecentBtn').classList.contains('btn-off')).toBe(true);
    expect(document.getElementById('gdFavBtn').classList.contains('btn-off')).toBe(true);
  });

  it('没有打开文档时点「新建参考线版面」只提示，不下发任何描述符（需求 §30）', async () => {
    const { document, played } = await loadPanel();
    played.length = 0;
    fire(document.getElementById('gdCreateBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(played).toEqual([]);
    expect(document.getElementById('status').textContent).toMatch(/请先打开一个 Photoshop 文档/);
  });

  it('「清除参考线」清空文档参考线，且不新建任何参考线（需求 §20）', async () => {
    const doc = fakeDoc(1920, 1080);
    doc.guides.length = 5;                                          // 文档里本来有 5 条
    const { document, played } = await loadPanel({ doc });
    played.length = 0;
    fire(document.getElementById('gdClearBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.guides.length).toBe(0);
    expect(guidesFrom(played)).toEqual({ vertical: [], horizontal: [] });
    expect(document.getElementById('status').textContent).toMatch(/已清除 5 条参考线/);
  });

  it('上个版本残留的参数 / 开关键都被清掉（现在参数只在 PS 弹窗里）', async () => {
    const { localStorage } = await loadPanel({
      doc: fakeDoc(1920, 1080),
      prefs: {
        'guide.cfg': '{"cols":{"count":4}}',
        'guide.colCenter': '1',
        'guide.clearFirst': '0',
        'guide.preview': '1',
      },
    });
    for (const k of ['guide.cfg', 'guide.colCenter', 'guide.clearFirst', 'guide.preview']) {
      expect([k, localStorage.getItem(k)]).toEqual([k, null]);
    }
  });

  it('记录跨会话保留：写进 localStorage，重开面板还在', async () => {
    const a = await loadPanel({ doc: fakeDoc(1920, 1080) });
    await a.notify('newGuideLayout', layoutEvent());
    const saved = a.localStorage.getItem('guide.recent');
    expect(saved).toMatch(/"count":4/);

    const b = await loadPanel({ doc: fakeDoc(1920, 1080), prefs: { 'guide.recent': saved } });
    expect(b.document.getElementById('gdRecentBtn').textContent).toBe('最近使用 (1)');
  });
});
