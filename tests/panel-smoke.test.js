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
  const kids = new Map();               // 选择器 → 假子元素（同一个选择器恒返回同一个）
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
    // 同一个选择器要返回同一个假子元素：面板会往按钮里的 .btn-label 写文字，
    // 每次都新造一个的话那些写入就全丢了（用例读到的永远是空串）
    querySelector: (sel) => {
      if (!kids.has(sel)) kids.set(sel, makeEl());
      return kids.get(sel);
    },
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
   * 照 index.html 里的真实标记，把某个容器下带指定 class 的 <span> / <div> 造成假元素
   *（pill 单选/多选组、自绘下拉的选项、步骤指示器的四个步骤都靠它）。同一组每次返回
   * 同一批元素，渲染时写进去的 .active 才读得回来。
   */
  const spansIn = (containerId, cls) => {
    const key = `${containerId}|${cls}`;
    if (spanCache.has(key)) return spanCache.get(key);
    const at = html.indexOf(`id="${containerId}"`);
    const list = [];
    if (at >= 0) {
      // 按 <div>/</div> 配平找容器的结束位置：九宫格锚点那种嵌套容器不能只找第一个 </div>
      let i = html.indexOf('>', at) + 1;
      let depth = 1;
      while (depth > 0) {
        const open = html.indexOf('<div', i);
        const close = html.indexOf('</div', i);
        if (close < 0) break;
        if (open >= 0 && open < close) { depth++; i = open + 4; } else { depth--; i = close + 5; }
      }
      const body = html.slice(at, i);
      const re = new RegExp(`<(?:span|div) class="([^"]*\\b${cls}\\b[^"]*)"([^>]*)>([^<]*)`, 'g');
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

  /**
   * 面板自己拼 innerHTML 出来的元件（预设列表、多尺寸列表、失败记录里的小按钮）：
   * 从当前 innerHTML 里按 class 还原成假元素。同一段 innerHTML 返回同一批，
   * 渲染时挂上的监听器测试里才点得到。
   */
  const renderCache = new Map();
  const renderedIn = (containerId, cls) => {
    const cur = (els.get(containerId) || {}).innerHTML || '';
    const hit = renderCache.get(containerId);
    if (hit && hit.html === cur) return hit.list;
    const list = [];
    const re = new RegExp(`<span class="([^"]*\\b${cls}\\b[^"]*)"([^>]*)>([^<]*)`, 'g');
    for (const m of cur.matchAll(re)) {
      const el = makeEl(cls);
      if (/active/.test(m[1])) el.classList.add('active');
      for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
      el.textContent = m[3];
      list.push(el);
    }
    renderCache.set(containerId, { html: cur, list });
    return list;
  };

  // 功能磁贴：让 switchPage 在测试里也走得通（点磁贴 = 切页）
  const tiles = ['rename', 'split', 'batch', 'move', 'layout', 'table', 'guide', 'resize', 'slice'].map((p) => {
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
      const m = /^#([\w-]+)\s+\.([\w-]+)(?:\.active|\[([\w-]+)="([^"]*)"\])?$/.exec(sel);
      if (m) {
        // 静态标记里没有就找面板自己拼 innerHTML 出来的那批（预设菜单是动态渲染的）
        const items = spansIn(m[1], m[2]).length ? spansIn(m[1], m[2]) : renderedIn(m[1], m[2]);
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
      // #容器 .class —— 照 index.html 里的真实标记造（改尺寸页的锚点 / 步骤 / 预设菜单都靠它）
      const m = /^#([\w-]+)\s+\.([\w-]+)$/.exec(sel);
      if (m) {
        const fromHtml = spansIn(m[1], m[2]);
        if (fromHtml.length) return fromHtml;
        return renderedIn(m[1], m[2]);          // 面板自己拼 innerHTML 出来的元件
      }
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
    // documents 可由用例传入一个【可变数组】：切图要往里 push 临时工作文档
    app: { activeDocument: opts.doc ?? null, documents: opts.documents || (opts.doc ? [opts.doc] : []) },
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
    // 只有分割那条路要读像素；不传就是 undefined，与今天的桩一致（模块顶层解构不会炸）
    imaging: opts.imaging,
  };
  // 文件系统桩：批量改尺寸要用到「选文件夹 / 多选文件 / 建文件 / 会话令牌 / 临时目录」
  const shellCalls = [];
  const tmpFiles = [];                             // 写进插件临时目录的 [名字, 内容]
  const copied = [];                               // 复制到剪贴板的文本
  const pickCalls = { folder: 0, files: [] };      // 弹了几次选择框、多选时传了什么参数
  const uxp = {
    storage: {
      localFileSystem: {
        getFolder: async () => { pickCalls.folder++; return opts.folder || null; },
        getFileForOpening: async (o) => { pickCalls.files.push(o || {}); return opts.files || []; },
        createSessionToken: async () => 'session-token',
        // 反查父目录用的（要 manifest 的 fullAccess）；默认按「没权限」演，用例可覆盖
        getEntryWithUrl: opts.entryWithUrl || (async () => { throw new Error('没有权限'); }),
        // 「打开输出文件夹」的 ExtendScript 桥把临时 .jsx 写在这儿
        getTemporaryFolder: async () => ({
          name: 'Temp',
          isFolder: true,
          nativePath: 'D:\\tmp',
          createFile: async (n) => ({
            name: n,
            nativePath: `D:\\tmp\\${n}`,
            write: async (text) => { tmpFiles.push([n, text]); },
          }),
        }),
      },
    },
    // ⚠️ 真机上 openPath 打不开时**不抛异常**，而是 resolve 出一句错误描述（成功是空串）——
    //    桩按这个契约来：opts.openPathResult 给非空串就等于「打不开」。
    //    openExternal 故意不提供：官方文档写明它不收 file: 协议，这条路已经放弃了。
    shell: {
      openPath: async (p, t) => { shellCalls.push([p, t]); return opts.openPathResult || ''; },
    },
  };
  const navigator = { clipboard: { writeText: async (t) => { copied.push(t); } } };

  const req = (name) => {
    if (name === 'photoshop') return photoshop;
    if (name === 'uxp') return uxp;
    throw new Error('未预期的 require：' + name);
  };
  const module = { exports: {} };
  const localStorage = makeStorage(opts.prefs || {});
  const run = new Function(
    'require', 'module', 'exports', 'document', 'localStorage', 'sessionStorage', 'window', 'navigator',
    out.outputFiles[0].text,
  );
  run(req, module, module.exports, document, localStorage, makeStorage(), { addEventListener() {} }, navigator);

  /** 切功能页（等价于点对应的磁贴） */
  const goPage = (name) => fire(tiles.find((t) => t.getAttribute('data-page') === name), 'click');
  /** 模拟 Photoshop 发一条动作通知（参考线记录全靠它） */
  const notify = async (event, desc) => {
    for (const cb of notifiers.get(event) || []) await cb(event, desc);
  };
  /** 点开记录弹窗，取出某条记录上的某个操作按钮 */
  const recordAction = (act) => document.querySelectorAll('#gdList .gd-mini')
    .find((el) => el.getAttribute('data-act') === act);

  return {
    document, played, photoshop, localStorage, goPage, notify, recordAction,
    shellCalls, tmpFiles, copied, pickCalls,
  };
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
/** 让桩像 PS 一样真把「选中」和「改名」落到假文档上（否则预览/统计验不出效果）。
 *  ⚠️ 假文档上有两份「选中」，对应真机上的两个来源：
 *    - activeLayers：DOM 那份，选中组时 PS 会把组内后代一并塞进来（切图/排版等仍读它）
 *    - targetIds：文档描述符 targetLayersIDs 那份，只有用户真正点亮的（重命名读它）
 *  用例造 doc 时可以让两者不一致，才验得出「选中组时组内的层不被改名」。 */
function onLayerPlay(doc) {
  return (d) => {
    if (d._obj === 'set' && d.to && d.to._obj === 'layer') {
      const l = findFakeLayer(doc.layers, d._target[0]._id);
      if (l) l.name = d.to.name;
    }
    if (d._obj === 'select' && d._target && d._target[0] && d._target[0]._ref === 'layer') {
      const l = findFakeLayer(doc.layers, d._target[0]._id);
      const add = d.selectionModifier && d.selectionModifier._value === 'addToSelection';
      if (l) {
        doc.activeLayers = add ? [...doc.activeLayers, l] : [l];
        doc.targetIds = add ? [...(doc.targetIds || []), l.id] : [l.id];
      }
    }
    if (d._obj === 'get' && d._target && d._target[0] && d._target[0]._property === 'targetLayersIDs') {
      const ids = doc.targetIds || (doc.activeLayers || []).map((l) => l.id);
      return { targetLayersIDs: ids.map((id) => ({ _ref: 'layer', _id: id })) };
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

/** 往假文档里塞一条参考线：模拟 PS 执行 newGuideLayout 后文档确实变了。
 *  applyGuideLayout 现在按【文档有没有变化】判定成功，不再只看 batchPlay 抛没抛 */
function addFakeGuide(doc, direction, coordinate) {
  const g = doc.guides;
  g[g.length] = { direction, coordinate, delete() { /* 这里不用单条删 */ } };
  g.length += 1;
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
  // activeLayers = DOM 那份（PS 会把选中组的后代也塞进来）；targetIds = 用户真正点亮的那份，
  // 省略时视作两者一致。只有让它俩不一致，才验得出重命名读的是后者。
  const doc = (activeLayers = [], targetIds = null) => {
    const d = fakeLayerDoc([
      fakeGroup(10, 'UI', [fakeLayer(11, 'Btn_normal'), fakeLayer(12, 'BTN_hover')]),
      fakeLayer(13, 'bg_btn'),
      fakeLayer(14, 'Title'),
    ]);
    d.activeLayers = activeLayers.map((id) => findFakeLayer(d.layers, id));
    d.targetIds = targetIds;
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

  it('没打开文档时点查找只提示，不开弹窗', async () => {
    const a = await loadPanel();
    open(a.document);
    expect(a.document.getElementById('slOverlay').style.display).not.toBe('flex');
    expect(a.document.getElementById('status').textContent).toMatch(/请先打开一个 PSD 文档/);
  });

  it('弹窗期间锁住内容列与功能栏的滚动（UXP 原生滚动条会横穿弹窗）', async () => {
    const { document } = await loadPanel({ doc: doc() });
    const boxes = ['pages', 'rail', 'previewList'];             // 内容列 / 功能栏 / 改名预览框
    for (const id of boxes) expect(document.getElementById(id).style.overflow).toBeUndefined();
    open(document);
    for (const id of boxes) expect(document.getElementById(id).style.overflow).toBe('hidden');
    click(document, 'slCloseBtn');
    // 解锁是把内联样式清掉、还给样式表，不是硬写 auto
    for (const id of boxes) expect(document.getElementById(id).style.overflow).toBe('');
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
    // 按钮上只写「确认」：项数写在上面那行预览标题里，塞进按钮会被窄面板截断
    expect(okLabel(document)).toBe('确认');
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
    // 选中没被动过：预览里还是原本那一个 Title，查出来的 Btn 一个都没进去
    const preview = document.getElementById('previewList').innerHTML;
    expect((preview.match(/class="pv-row"/g) || []).length).toBe(1);
    expect(preview).toMatch(/Title/);
  });

  // 选中数只在底部状态栏报（页面顶部那一行已经撤掉）
  it('选中数写进状态栏：数变了才写，刚写的结果提示不会被它冲掉', async () => {
    const d = doc([14], [14]);                                         // 先点亮 Title 一层
    const { document, notify } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    await settle();
    expect(document.getElementById('status').textContent).toBe('插件已加载');   // 启动那次只记数

    d.targetIds = [10, 14];                                            // PS 里又点亮了 UI 组
    await notify('select');
    await settle();
    expect(document.getElementById('status').textContent).toBe('已选中 2 个图层/组');

    // 数没变（只是换了两个别的层）：不碰状态栏，否则改名结果会被这一句盖掉
    document.getElementById('status').textContent = '完成：已重命名 2 个图层/组';
    d.targetIds = [11, 13];
    await notify('select');
    await settle();
    expect(document.getElementById('status').textContent).toBe('完成：已重命名 2 个图层/组');

    d.targetIds = [];
    await notify('select');
    await settle();
    expect(document.getElementById('status').textContent).toBe('未选中图层或组');
  });

  it('从别的功能页回到重命名页：选中数照样重写一次', async () => {
    const d = doc([14], [14]);
    const { document, goPage } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    await settle();
    goPage('layout');                                                  // 排版页写的是它自己的提示
    await settle();
    expect(document.getElementById('status').textContent).not.toMatch(/已选中 1 个/);
    goPage('rename');
    await settle();
    expect(document.getElementById('status').textContent).toBe('已选中 1 个图层/组');
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

  // ⚠️ 真机上选中一个组，PS 会把组里的层也一起塞进 activeLayers —— 光看这个列表分不出
  //    「用户自己两样都选了」和「组把子层带出来了」。改名读的是 targetLayersIDs，它只报
  //    真正点亮的那些，所以下面两个用例的 activeLayers 一模一样、结果却必须不同。
  it('只点亮了组（PS 顺带把组内层塞进 activeLayers）：只改组名，组内的层一个都不动', async () => {
    const d = doc([10, 11], [10]);                                     // 点亮的只有 UI 组
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    await settle();
    clickPill(document, 'renameModePills', 'data-mode', 'prefix');
    type(document, 'templateText', 'X_');
    await settle();
    const preview = document.getElementById('previewList').innerHTML;
    expect((preview.match(/class="pv-row"/g) || []).length).toBe(1);    // 只有组那一行
    expect(preview).toMatch(/X_UI/);
    expect(preview).not.toMatch(/X_Btn_normal/);
    played.length = 0;
    fire(document.getElementById('renameBtn'), 'click');
    await settle();
    expect(renamesFrom(played)).toEqual([[10, 'X_UI']]);
    expect(document.getElementById('status').textContent).toMatch(/已重命名 1 个图层\/组/);
  });

  it('预览每行行首带类型图标：组是文件夹、图层是图片框', async () => {
    const d = doc([10, 11, 13], [10, 11, 13]);                         // UI 组 + 组内的层 + 组外的层
    const { document } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    await settle();
    // 还没填查找内容时预览退化成原名，图标一样要在
    const bare = document.getElementById('previewList').innerHTML;
    expect((bare.match(/data-kind="group"/g) || []).length).toBe(1);
    expect((bare.match(/data-kind="layer"/g) || []).length).toBe(2);

    clickPill(document, 'renameModePills', 'data-mode', 'prefix');
    type(document, 'templateText', 'X_');
    await settle();
    const html = document.getElementById('previewList').innerHTML;
    // 组那一行配文件夹图标，图层那两行配图片框；顺序按面板从上往下（组名在前）
    const kinds = (html.match(/data-kind="(group|layer)"/g) || []).map((s) => s.slice(11, -1));
    expect(kinds).toEqual(['group', 'layer', 'layer']);
    expect(html).toContain('class="pv-ico"');
    expect(html).not.toMatch(/<img\b/i);                               // 位图会让 PS 卡死闪退
  });

  // 每行带图标后节点数翻几倍，预览得有个渲染上限（UXP 下 DOM 一大就卡）。
  // 但上限只管「画」——改名必须照样覆盖全部，否则就是静默漏改。
  it('选中数超过预览上限：只画 300 行并说明，改名仍覆盖全部 305 个', async () => {
    const many = Array.from({ length: 305 }, (_, i) => fakeLayer(100 + i, `L${i}`));
    const d = fakeLayerDoc(many);
    d.activeLayers = many;
    d.targetIds = many.map((l) => l.id);
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    await settle();
    clickPill(document, 'renameModePills', 'data-mode', 'prefix');
    type(document, 'templateText', 'X_');
    await settle();
    const html = document.getElementById('previewList').innerHTML;
    expect((html.match(/class="pv-row"/g) || []).length).toBe(300);
    expect(html).toContain('还有 5 项没画出来');
    played.length = 0;
    fire(document.getElementById('renameBtn'), 'click');
    await settle();
    expect(renamesFrom(played).length).toBe(305);                      // 画 300，改 305
  });

  it('组和组内的层都点亮了：组名与组内层名各改自己的', async () => {
    const d = doc([10, 11], [10, 11]);                                 // 用户自己两样都点了
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    await settle();
    clickPill(document, 'renameModePills', 'data-mode', 'prefix');
    type(document, 'templateText', 'X_');
    await settle();
    const preview = document.getElementById('previewList').innerHTML;
    expect((preview.match(/class="pv-row"/g) || []).length).toBe(2);    // 组 + 组内的层
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

// 所有文字输入框共用的一套：聚焦时外层描边高亮、框清空、原值转灰字；
// 退出时没输东西就把原值放回去，输了新值就按新值。
// 桩里 el.parentNode 与元素自己共用 classList，所以描边那个类直接在元素上断言。
describe('输入框通用行为：聚焦高亮 + 点进去清空', () => {
  const focus = (document, id) => fire(document.getElementById(id), 'focus');
  const blur = (document, id) => fire(document.getElementById(id), 'blur');

  it('聚焦：描边高亮 + 框清空 + 原值转灰字；没改动就退出 → 原值回来', async () => {
    const { document } = await loadPanel();
    const el = document.getElementById('layoutGap');
    el.value = '10';
    el.placeholder = '';
    el.setAttribute('placeholder', '');
    focus(document, 'layoutGap');
    expect(el.classList.contains('focused')).toBe(true);
    expect(el.value).toBe('');
    expect(el.placeholder).toBe('10');                 // 原值还看得见
    blur(document, 'layoutGap');
    expect(el.classList.contains('focused')).toBe(false);
    expect(el.value).toBe('10');
    expect(el.placeholder).toBe('');                   // 借去当灰字的 placeholder 还回来了
  });

  it('输了新值：退出后按新值，不会被原值盖回去', async () => {
    const { document } = await loadPanel();
    const el = document.getElementById('layoutGap');
    el.value = '10';
    focus(document, 'layoutGap');
    type(document, 'layoutGap', '24');
    blur(document, 'layoutGap');
    expect(el.value).toBe('24');
  });

  it('focus 与 focusin 都来也只清一次（第二次不会把空串当成原值记下）', async () => {
    const { document } = await loadPanel();
    const el = document.getElementById('layoutGap');
    el.value = '10';
    focus(document, 'layoutGap');
    fire(el, 'focusin');
    fire(el, 'focusout');
    expect(el.value).toBe('10');
  });

  it('正在编辑、还没输东西时读到的仍是原值（blur 没来也不会读成空）', async () => {
    const d = fakeLayerDoc([fakeLayer(1, 'Btn_a')]);
    d.targetIds = [1];
    const { document, played } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    await settle();
    type(document, 'findText', 'Btn');
    type(document, 'templateText', 'Icon');
    await settle();
    focus(document, 'findText');                       // 点进「查找内容」，框被清空
    expect(document.getElementById('findText').value).toBe('');
    played.length = 0;
    fire(document.getElementById('renameBtn'), 'click');   // 直接点按钮，blur 还没来
    await settle();
    expect(renamesFrom(played)).toEqual([[1, 'Icon_a']]);
  });

  it('表格页的框（真值本来就存在灰字里）只拿高亮，不被通用清空插一脚', async () => {
    const { document } = await loadPanel();
    const el = document.getElementById('tblRows');
    const holder = el.placeholder;                     // 当前真值以灰字显示
    expect(holder).not.toBe('');
    focus(document, 'tblRows');
    expect(el.classList.contains('focused')).toBe(true);
    expect(el.placeholder).toBe(holder);               // 灰字里的真值没被顶掉
    blur(document, 'tblRows');
    expect(el.placeholder).toBe(holder);
  });

  it('查找弹窗的「清空关键词」：正编辑着也真清空，退出不会把词放回来', async () => {
    const d = fakeLayerDoc([fakeLayer(1, 'Btn_a')]);
    const { document } = await loadPanel({ doc: d, onPlay: onLayerPlay(d) });
    fire(document.getElementById('slOpenBtn'), 'click');
    type(document, 'slFindText', 'btn');
    focus(document, 'slFindText');                     // 点回框里，词被挪进灰字
    fire(document.getElementById('slFindClear'), 'click');
    blur(document, 'slFindText');
    expect(document.getElementById('slFindText').value).toBe('');
    expect(document.getElementById('slCount').textContent).toBe('输入查找内容后显示结果');
  });
});

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
    const doc = fakeDoc(1920, 1080);
    const { document, played, notify, recordAction } = await loadPanel({
      doc,
      // 原生命令生效时文档会多出参考线 —— 插件就是靠这个变化判断「真的画了」
      onPlay: (d) => { if (d._obj === 'newGuideLayout') addFakeGuide(doc, 'vertical', 40); return null; },
    });
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

  it('原生命令不报错但一条线都没画出来时，「应用」照样退回插件自己算坐标', async () => {
    // 真机上的表现就是这个：点「应用」毫无反应，也没有任何报错 —— batchPlay 收下了
    // 描述符却空转。所以判定成功要看文档变化，不能只看有没有抛错。
    const doc = fakeDoc(1920, 1080);
    const { document, played, notify, recordAction } = await loadPanel({
      doc,
      onPlay: () => null,                      // 全部「成功」，但文档一条线也没多
    });
    await notify('newGuideLayout', layoutEvent());
    fire(document.getElementById('gdRecentBtn'), 'click');
    played.length = 0;

    fire(recordAction('rec-apply:0'), 'click');
    await new Promise((r) => setTimeout(r, 0));

    // 两种描述符形状都试过（平铺 + 嵌套），都空转，最后由插件逐条建
    expect(played.filter((d) => d._obj === 'newGuideLayout').length).toBe(2);
    expect(guidesFrom(played)).toEqual({
      vertical: [40, 485, 505, 950, 970, 1415, 1435, 1880],
      horizontal: [40, 360, 380, 700, 720, 1040],
    });
    expect(document.getElementById('status').textContent).toMatch(/已由插件直接创建/);
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

  it('收藏当前版面 → 应用：画出来的与收藏时看到的一模一样', async () => {
    // 用户报的问题就出在这条路上：手建的三等分被推断成「只有边距、没有列也没有行」，
    // 下发给 PS 的 newGuideLayout 里连 colCount / rowCount 都没有，原生命令空转、
    // 一条线都不画（也不报错）。此时必须退回插件自己逐条建，且坐标要与原来一致。
    const doc = fakeDoc(1920, 1080);
    doc.guides = fakeGuides([
      ...[640, 1280].map((coordinate) => ({ direction: 'vertical', coordinate })),
      ...[360, 720].map((coordinate) => ({ direction: 'horizontal', coordinate })),
    ]);
    const { document, played, recordAction } = await loadPanel({ doc, onPlay: () => null });
    fire(document.getElementById('gdFavNowBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    fire(document.getElementById('gdNameOk'), 'click');
    await new Promise((r) => setTimeout(r, 0));

    fire(document.getElementById('gdFavBtn'), 'click');
    played.length = 0;
    fire(recordAction('fav-apply:0'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(guidesFrom(played)).toEqual({ vertical: [640, 1280], horizontal: [360, 720] });
  });

  it('收藏当前版面：参数会损耗的版面，同尺寸下按坐标原样还原', async () => {
    // 「4 列 + 左右边距 100、没有横线」只能被推断成「边距 上0 下0 左100 右100」（边距是
    // 一个整体开关，没法只开左右），而这套参数还会多画出画布上下两条边线 0 / 1080。
    // 所以收藏时把坐标一起存下来，同尺寸画布上按坐标还原，不多不少
    const doc = fakeDoc(1920, 1080);
    const lines = [100, 515, 535, 950, 970, 1385, 1405, 1820];
    doc.guides = fakeGuides(lines.map((coordinate) => ({ direction: 'vertical', coordinate })));
    const { document, played, recordAction } = await loadPanel({ doc, onPlay: () => null });
    fire(document.getElementById('gdFavNowBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    fire(document.getElementById('gdNameOk'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('status').textContent).toMatch(/已收藏为「4列/);   // 仍按参数展示

    fire(document.getElementById('gdFavBtn'), 'click');
    played.length = 0;
    fire(recordAction('fav-apply:0'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(guidesFrom(played)).toEqual({ vertical: lines, horizontal: [] });
    // 也没有绕原生命令：同尺寸就是按坐标还原
    expect(played.filter((d) => d._obj === 'newGuideLayout')).toEqual([]);
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

// 参考线分割：真正切像素那段（getPixels / copy / paste / 跨文档 duplicate）只能真机验，
// 这里守住「切之前的把关」——切不了的情况必须在下发任何描述符之前就拦住，
// 别把用户的文档折腾一半才发现不行。
describe('快速平移：八方向九宫格 + 复制移动', () => {
  /** 选中两个图层的假文档（没有 suspendHistory → 走 executeAsModal 那条路） */
  const movableDoc = () => {
    const d = fakeLayerDoc([fakeLayer(11, 'A'), fakeLayer(12, 'B')]);
    d.activeLayers = [...d.layers];
    return d;
  };
  /** 在九宫格里点某个方向 */
  const pickDir = (document, dir) =>
    fire(document.querySelector(`#moveDirPills .pill[data-dir="${dir}"]`), 'click');
  const rowShown = (document, id) => document.getElementById(id).style.display !== 'none';
  const activeDir = (document) =>
    document.querySelector('#moveDirPills .pill.active').getAttribute('data-dir');
  const moves = (played) => played.filter((d) => d._obj === 'move');
  const offsetOf = (d) => [d.to.horizontal._value, d.to.vertical._value];
  const clickMove = async (document) => {
    fire(document.getElementById('moveBtn'), 'click');
    await settle();
  };

  it('默认向右：只出水平距离那一行，垂直那行收起来', async () => {
    const { document, goPage } = await loadPanel({ doc: movableDoc() });
    goPage('move');
    expect(activeDir(document)).toBe('right');
    expect(rowShown(document, 'moveXRow')).toBe(true);
    expect(rowShown(document, 'moveYRow')).toBe(false);
  });

  it('选上下方向：换成只出垂直那一行', async () => {
    const { document, goPage } = await loadPanel({ doc: movableDoc() });
    goPage('move');
    pickDir(document, 'down');
    expect(rowShown(document, 'moveXRow')).toBe(false);
    expect(rowShown(document, 'moveYRow')).toBe(true);
  });

  it('选斜角：两行都出，按两个值走一条斜的位移', async () => {
    const { document, goPage, played } = await loadPanel({ doc: movableDoc() });
    goPage('move');
    pickDir(document, 'upLeft');
    expect(rowShown(document, 'moveXRow')).toBe(true);
    expect(rowShown(document, 'moveYRow')).toBe(true);
    document.getElementById('moveX').value = '20';
    document.getElementById('moveY').value = '10';
    await clickMove(document);
    expect(moves(played)).toHaveLength(1);
    expect(offsetOf(moves(played)[0])).toEqual([-20, -10]);
  });

  it('正向方向下，另一行框里的残值绝不生效（不会斜着跑）', async () => {
    const { document, goPage, played } = await loadPanel({ doc: movableDoc() });
    goPage('move');
    pickDir(document, 'upLeft');
    document.getElementById('moveX').value = '20';
    document.getElementById('moveY').value = '10';
    pickDir(document, 'down');                       // 水平那行收起来了，值还留在框里
    await clickMove(document);
    expect(offsetOf(moves(played)[0])).toEqual([0, 10]);
  });

  it('填负数只翻那一个轴，九宫格点亮对面那格、框里回填正数', async () => {
    const { document, goPage, played } = await loadPanel({ doc: movableDoc() });
    goPage('move');
    pickDir(document, 'upLeft');
    document.getElementById('moveX').value = '-20';
    document.getElementById('moveY').value = '10';
    await clickMove(document);
    expect(activeDir(document)).toBe('upRight');     // ↖ 的水平轴翻过来 = ↗
    expect(document.getElementById('moveX').value).toBe('20');
    expect(offsetOf(moves(played)[0])).toEqual([20, -10]);
  });

  it('距离都没填：只提示，不下发任何 move', async () => {
    const { document, goPage, played } = await loadPanel({ doc: movableDoc() });
    goPage('move');
    await clickMove(document);
    expect(document.getElementById('status').textContent).toMatch(/还没填移动距离/);
    expect(moves(played)).toEqual([]);
  });

  it('没选中对象：拦住并提示', async () => {
    const doc = movableDoc();
    doc.activeLayers = [];
    const { document, goPage, played } = await loadPanel({ doc });
    goPage('move');
    document.getElementById('moveX').value = '20';
    await clickMove(document);
    expect(document.getElementById('status').textContent).toMatch(/请先选择/);
    expect(moves(played)).toEqual([]);
  });

  it('复制移动默认关：不下发 duplicate，按钮写「快速平移」', async () => {
    const { document, goPage, played } = await loadPanel({ doc: movableDoc() });
    goPage('move');
    expect(document.getElementById('moveCopy').checked).toBe(false);
    expect(document.getElementById('moveBtnLabel').textContent).toBe('快速平移');
    document.getElementById('moveX').value = '20';
    await clickMove(document);
    expect(played.filter((d) => d._obj === 'duplicate')).toEqual([]);
    expect(document.getElementById('status').textContent).toMatch(/^已移动 2 个对象/);
  });

  it('开复制移动：先 duplicate 再 move（副本吃位移，原对象留在原位）', async () => {
    const { document, goPage, played } = await loadPanel({ doc: movableDoc() });
    goPage('move');
    fire(document.getElementById('moveCopy'), 'click');
    expect(document.getElementById('moveBtnLabel').textContent).toBe('复制并平移');
    document.getElementById('moveX').value = '20';
    await clickMove(document);
    const order = played.filter((d) => d._obj === 'duplicate' || d._obj === 'move').map((d) => d._obj);
    expect(order).toEqual(['duplicate', 'move']);    // 顺序反了就成了「移动原件再复制」
    expect(offsetOf(moves(played)[0])).toEqual([20, 0]);
    expect(document.getElementById('status').textContent).toMatch(/^已复制并移动 2 个对象/);
  });

  it('旧版按轴分开记的方向已无对应控件，启动时清掉', async () => {
    const { localStorage } = await loadPanel({
      doc: movableDoc(),
      prefs: { 'move.xDir': 'left', 'move.yDir': 'up' },
    });
    expect(localStorage.getItem('move.xDir')).toBeNull();
    expect(localStorage.getItem('move.yDir')).toBeNull();
  });

  it('方向跨会话记忆：上次选的方向决定这次出哪一行', async () => {
    const { document, goPage } = await loadPanel({ doc: movableDoc(), prefs: { 'move.dir': 'downLeft' } });
    goPage('move');
    expect(activeDir(document)).toBe('downLeft');
    expect(rowShown(document, 'moveXRow')).toBe(true);
    expect(rowShown(document, 'moveYRow')).toBe(true);
  });
});

describe('参考线分割：切之前的把关', () => {
  const guideList = (xs, ys) => [
    ...xs.map((x) => ({ direction: 'vertical', coordinate: x })),
    ...ys.map((y) => ({ direction: 'horizontal', coordinate: y })),
  ];
  /** 400×300 的文档 + 一条参考线布局；默认选中一个像素图层 */
  const docWith = (xs, ys, select = true) => {
    const d = fakeDoc(400, 300, guideList(xs, ys));
    d.layers = [fakeLayer(11, '素材')];
    d.activeLayers = select ? [d.layers[0]] : [];
    return d;
  };
  const gridText = (document) => document.getElementById('gsGrid').textContent;
  const clickSplit = async (document) => {
    fire(document.getElementById('gsBtn'), 'click');
    await settle();
  };
  /** 有没有真的动过文档（拍平 / 复制 / 粘贴任一出现即算动过） */
  const touchedDoc = (played) =>
    played.some((d) => ['mergeVisible', 'copyEvent', 'paste'].includes(d._obj));

  it('进分割页就显示当前参考线切出几块（画布边缘算边界：3 竖 = 4 列）', async () => {
    const { document, goPage } = await loadPanel({ doc: docWith([100, 200, 300], [150]) });
    goPage('split');
    expect(gridText(document)).toBe('4 列 × 2 行 → 8 块');
  });

  it('没有参考线：按钮置灰，点了只提示、不碰文档', async () => {
    const { document, goPage, played } = await loadPanel({ doc: docWith([], []) });
    goPage('split');
    expect(gridText(document)).toBe('没有参考线');
    expect(document.getElementById('gsBtn').classList.contains('btn-off')).toBe(true);
    await clickSplit(document);
    expect(document.getElementById('status').textContent).toMatch(/没有参考线/);
    expect(touchedDoc(played)).toBe(false);
  });

  it('参考线全压在画布边缘（没切开）：同样拦住', async () => {
    const { document, goPage, played } = await loadPanel({ doc: docWith([0, 400], []) });
    goPage('split');
    expect(gridText(document)).toBe('参考线未切开画布');
    await clickSplit(document);
    expect(document.getElementById('status').textContent).toMatch(/只有 1 块/);
    expect(touchedDoc(played)).toBe(false);
  });

  it('没选中对象、又没开「合并可见内容」：提示怎么办，不动文档', async () => {
    const { document, goPage, played } = await loadPanel({ doc: docWith([200], [150], false) });
    goPage('split');
    expect(gridText(document)).toBe('2 列 × 2 行 → 4 块');
    await clickSplit(document);
    expect(document.getElementById('status').textContent).toMatch(/选中要分割的图层 \/ 组/);
    expect(touchedDoc(played)).toBe(false);
  });

  it('块数超过 40 先弹确认：取消则零改动，弹窗期间锁住滚动条', async () => {
    // 9 竖 + 4 横 = 10 列 × 5 行 = 50 块
    const { document, goPage, played } = await loadPanel({
      doc: docWith([40, 80, 120, 160, 200, 240, 280, 320, 360], [50, 100, 150, 200]),
    });
    goPage('split');
    expect(gridText(document)).toBe('10 列 × 5 行 → 50 块');

    await clickSplit(document);
    expect(document.getElementById('gsConfirm').style.display).toBe('flex');
    expect(document.getElementById('gsCellCount').textContent).toBe('50');
    // UXP 原生滚动条会横穿弹窗，开着弹窗时内容列必须锁住
    expect(document.getElementById('pages').style.overflow).toBe('hidden');

    fire(document.getElementById('gsConfirmNo'), 'click');
    await settle();
    expect(document.getElementById('gsConfirm').style.display).toBe('none');
    expect(document.getElementById('pages').style.overflow).toBe('');
    expect(document.getElementById('status').textContent).toMatch(/已取消/);
    expect(touchedDoc(played)).toBe(false);
  });

  it('块数没超阈值就不弹确认，直接进执行', async () => {
    const { document, goPage } = await loadPanel({ doc: docWith([100, 200, 300], [100, 200]) });
    goPage('split');
    expect(gridText(document)).toBe('4 列 × 3 行 → 12 块');
    await clickSplit(document);
    expect(document.getElementById('gsConfirm').style.display).not.toBe('flex');
    // 已经越过所有把关进入执行（桩没有 doc.duplicate，走到复制工作文档就报错——
    // 这里只关心「不是被前面的校验拦下的」，像素那段仍归真机验证）
    expect(document.getElementById('status').textContent).toMatch(/正在按参考线分割|分割失败/);
  });
});

// 参考线分割的执行段：把「工作文档 / 拍平层 / 读像素 / 粘出来的层」都做成桩，
// 在 Node 里把整条流水线走完。这里守的是三件真机上最容易翻车、又最难看出来的事：
//   1) 建选区用的是【每格内容的紧贴外框】，不是格子本身（PS 的 paste 居中贴，
//      拿格子当框、内容偏在一角就会跑位）；
//   2) 空白格不切、编号连续；
//   3) 万一还是跑位了，收尾会按预期外框补一条 move 把它挪回去。
describe('参考线分割：执行段（选区 / 编号 / 落位校正 / 编组）', () => {
  const BOUNDS = { left: 0, top: 0, right: 100, bottom: 100 };

  /** 造像素：把这些矩形填成不透明，其余全透明 */
  const rgbaWith = (rects) => {
    const buf = new Uint8Array(100 * 100 * 4);
    for (const r of rects) {
      for (let y = r.top; y < r.bottom; y++) {
        for (let x = r.left; x < r.right; x++) buf[(y * 100 + x) * 4 + 3] = 255;
      }
    }
    return buf;
  };

  /**
   * 给分割流水线配一套桩：duplicate 出工作文档 → 拍平层能读像素 →
   * paste 出来的层能跨文档 duplicate 回原文档。
   * @param {object[]} landed 第 i 块 duplicate 回来后【实际】落在哪（模拟 paste 跑位）
   */
  function fakeSplitEnv(srcDoc, rgba, landed, opts = {}) {
    const copies = [];
    const flat = { id: 500, kind: 'pixel', bounds: BOUNDS, visible: false };
    const target = { id: 11, name: '素材', kind: 'pixel', visible: true };
    // 栈顶特意放一个【隐藏的文字层】：mergeVisible 不会合并隐藏图层，它就一直待在
    // layers[0]。真机上正是它让「取 layers[0] 当底稿层」报 Unsupported layer type
    //（它没有 bounds，这里谁误取了它就会当场炸）。
    const hiddenText = { id: 12, name: '标题', kind: 'text', visible: false };
    const workDoc = {
      id: 99,
      name: '__sliceman_split',
      // 工作文档是原文档的副本，所以里面有同 id 的目标图层（流水线要按 id 找它再拍平）
      layers: [hiddenText, flat, target],
      activeLayers: [],
    };
    // 模拟 PS：可见图层并成一层，隐藏的原样留在栈里
    const onPlay = (d) => {
      if (d._obj === 'mergeVisible') {
        for (const l of workDoc.layers) l.visible = false;
        flat.visible = true;
      }
      if (d._obj === 'rasterizeLayer') flat.rasterized = true;
      return null;
    };
    workDoc.activeLayers = [{
      id: 600,
      async duplicate() {
        const copy = {
          id: 700 + copies.length,
          name: '',
          bounds: landed[copies.length] || null,
          async moveAbove() { this.movedAbove = true; },
        };
        copies.push(copy);
        return copy;
      },
      async delete() { this.deleted = true; },
    }];
    srcDoc.duplicate = async () => workDoc;
    // failFirstRead：模拟 imaging 不认这个图层类型（智能对象 / 文字没被合并掉时的真机报错）
    let reads = 0;
    const imaging = {
      getPixels: async () => {
        reads += 1;
        if (opts.failFirstRead && reads === 1) throw new Error('Unsupported layer type');
        return { imageData: { getData: async () => rgba, dispose: async () => {} } };
      },
    };
    return { imaging, onPlay, copies, flat };
  }

  /** 一条竖线 + 一条横线，把 100×100 切成 4 格；默认选中一个像素图层 */
  const doc4 = () => {
    const d = fakeDoc(100, 100, [
      { direction: 'vertical', coordinate: 50 },
      { direction: 'horizontal', coordinate: 50 },
    ]);
    d.layers = [fakeLayer(11, '素材')];
    d.activeLayers = [d.layers[0]];
    return d;
  };
  /** 从下发的描述符里挑出所有矩形选区 */
  const rectsFrom = (played) => played
    .filter((d) => d._obj === 'set' && d.to && d.to._obj === 'rectangle')
    .map((d) => ({
      left: d.to.left._value, top: d.to.top._value,
      right: d.to.right._value, bottom: d.to.bottom._value,
    }));

  it('选区是每格内容的紧贴外框；空白格不切、编号从 0 连续给；最后统一编组', async () => {
    // 左上格里内容偏在角上（10..20），右下格里内容贴右下角（90..100），另两格全空
    const content = [
      { left: 10, top: 10, right: 20, bottom: 20 },
      { left: 90, top: 90, right: 100, bottom: 100 },
    ];
    const doc = doc4();
    const env = fakeSplitEnv(doc, rgbaWith(content), content);   // 落位正确：不该有校正
    const { document, goPage, played } = await loadPanel({ doc, imaging: env.imaging, onPlay: env.onPlay });
    goPage('split');
    fire(document.getElementById('gsBtn'), 'click');
    await settle();

    // 选区 = 内容外框，不是 0..50 / 50..100 那两个格子
    expect(rectsFrom(played)).toEqual(content);
    expect(played.filter((d) => d._obj === 'copyEvent')).toHaveLength(2);
    expect(env.copies.map((c) => c.name)).toEqual(['0', '1']);   // 空白格不占号
    expect(env.copies.every((c) => c.movedAbove)).toBe(true);    // 都落在原图层上方
    expect(played.filter((d) => d._obj === 'move')).toEqual([]);  // 没跑位就不挪

    // 收尾编组：先选中这两层，再原地 make layerSection
    const grp = played.find((d) => d._obj === 'make' && d._target?.[0]?._ref === 'layerSection');
    expect(grp?.using?.name).toBe('素材 切片');
    expect(document.getElementById('status').textContent)
      .toMatch(/2 列 × 2 行 = 4 块，跳过 2 块空白，已新建 2 个图层并放进新组/);
  });

  it('落位跑偏时按预期外框补一条 move 挪回去（差 <1px 不动）', async () => {
    const content = [
      { left: 10, top: 10, right: 20, bottom: 20 },
      { left: 90, top: 90, right: 100, bottom: 100 },
    ];
    const doc = doc4();
    // 第一块被贴偏了 (+5,+3)，第二块只偏了 0.4px（PS 的舍入噪声，不该为它挪图层）
    const env = fakeSplitEnv(doc, rgbaWith(content), [
      { left: 15, top: 13, right: 25, bottom: 23 },
      { left: 90.4, top: 90.4, right: 100.4, bottom: 100.4 },
    ]);
    const { document, goPage, played } = await loadPanel({ doc, imaging: env.imaging, onPlay: env.onPlay });
    goPage('split');
    fire(document.getElementById('gsBtn'), 'click');
    await settle();

    const moves = played.filter((d) => d._obj === 'move');
    expect(moves).toHaveLength(1);
    expect(moves[0]._target[0]._id).toBe(env.copies[0].id);
    expect([moves[0].to.horizontal._value, moves[0].to.vertical._value]).toEqual([-5, -3]);
    expect(document.getElementById('status').textContent).toMatch(/校正落位 1 层/);
  });

  it('打开「合并可见内容」：不看选中也能切，结果放进「参考线切片」组', async () => {
    const content = [{ left: 0, top: 0, right: 50, bottom: 50 }];
    const doc = doc4();
    doc.activeLayers = [];                                   // 什么都没选
    const env = fakeSplitEnv(doc, rgbaWith(content), content);
    const { document, goPage, played } = await loadPanel({ doc, imaging: env.imaging, onPlay: env.onPlay });
    goPage('split');
    fire(document.getElementById('gsMerged'), 'click');      // 开开关
    fire(document.getElementById('gsBtn'), 'click');
    await settle();

    expect(played.filter((d) => d._obj === 'copyEvent')).toHaveLength(1);
    expect(env.copies[0].movedAbove).toBeUndefined();        // 没有原图层可依附，落在顶层
    const grp = played.find((d) => d._obj === 'make' && d._target?.[0]?._ref === 'layerSection');
    expect(grp?.using?.name).toBe('参考线切片');
  });

  it('底稿层取的是「合并后唯一可见的非组图层」，不是栈顶（栈顶可能是隐藏的文字层）', async () => {
    // 桩里 layers[0] 是个隐藏文字层、连 bounds 都没有：谁改回 doc.layers[0] 这条就炸。
    // 真机症状：分割失败 Error: Unsupported layer type（imaging 读不动文字 / 智能对象）
    const content = [{ left: 0, top: 0, right: 50, bottom: 50 }];
    const doc = doc4();
    const env = fakeSplitEnv(doc, rgbaWith(content), content);
    const { document, goPage, played } = await loadPanel({ doc, imaging: env.imaging, onPlay: env.onPlay });
    goPage('split');
    fire(document.getElementById('gsBtn'), 'click');
    await settle();
    expect(document.getElementById('status').textContent).toMatch(/已新建 1 个图层/);
    expect(played.filter((d) => d._obj === 'rasterizeLayer')).toEqual([]);   // 类型没问题就不栅格化
  });

  it('imaging 报「不认这个图层类型」时：栅格化后重读一次，不把失败甩给用户', async () => {
    const content = [{ left: 0, top: 0, right: 50, bottom: 50 }];
    const doc = doc4();
    const env = fakeSplitEnv(doc, rgbaWith(content), content, { failFirstRead: true });
    const { document, goPage, played } = await loadPanel({ doc, imaging: env.imaging, onPlay: env.onPlay });
    goPage('split');
    fire(document.getElementById('gsBtn'), 'click');
    await settle();

    const ras = played.filter((d) => d._obj === 'rasterizeLayer');
    expect(ras).toHaveLength(1);
    expect(ras[0]._target[0]._id).toBe(env.flat.id);
    expect(document.getElementById('status').textContent).toMatch(/已新建 1 个图层/);
  });

  it('每一格都是空的：如实报出来，不建空图层也不建组', async () => {
    const doc = doc4();
    const env = fakeSplitEnv(doc, rgbaWith([]), []);
    const { document, goPage, played } = await loadPanel({ doc, imaging: env.imaging, onPlay: env.onPlay });
    goPage('split');
    fire(document.getElementById('gsBtn'), 'click');
    await settle();

    expect(played.filter((d) => d._obj === 'copyEvent')).toEqual([]);
    expect(played.find((d) => d._obj === 'make' && d._target?.[0]?._ref === 'layerSection'))
      .toBeUndefined();
    expect(document.getElementById('status').textContent).toMatch(/没有切出图层/);
  });

  // ---- 智能分割：选区必须只圈住本元素自己的像素 ----
  // 真机报的 bug：两个互不相连的图形，外框交叠（战士伸出的手臂罩在王后的裙摆上方），
  // 按外框整块复制 → 每一层都被切进了邻居的一块，看着像「沿直线横竖切」。
  // 修法是给每块下发一批矩形（首个 set、其余 addTo）拼成非矩形选区。

  /** 战士：竖条 + 向右伸出的手臂 */
  const SHAPE_A = [
    { left: 4, top: 4, right: 20, bottom: 60 },
    { left: 20, top: 20, right: 60, bottom: 28 },
  ];
  /** 王后：竖条 + 向左拖出的裙摆（裙摆落在战士的外框里） */
  const SHAPE_B = [
    { left: 80, top: 4, right: 96, bottom: 60 },
    { left: 44, top: 40, right: 80, bottom: 52 },
  ];

  /** 按下发顺序把选区操作拆成一块块：set 开新块，addTo 追加到当前块 */
  const selGroups = (played) => {
    const out = [];
    for (const d of played) {
      const isSet = d._obj === 'set' && d.to && d.to._obj === 'rectangle';
      const isAdd = d._obj === 'addTo' && d.to && d.to._obj === 'rectangle';
      if (!isSet && !isAdd) continue;
      const r = {
        left: d.to.left._value, top: d.to.top._value,
        right: d.to.right._value, bottom: d.to.bottom._value,
      };
      if (isSet) out.push([r]); else out[out.length - 1].push(r);
    }
    return out;
  };
  const inAny = (rects, x, y) => rects.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
  /** 逐像素核对某块选区：自己的像素全在里面、别人的一个都不在 */
  const coverOf = (rects, own, foreign) => {
    let missed = 0, leaked = 0;
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        if (inAny(own, x, y) && !inAny(rects, x, y)) missed++;
        if (inAny(foreign, x, y) && inAny(rects, x, y)) leaked++;
      }
    }
    return { missed, leaked };
  };

  it('外框交叠的两块：选区按像素拼出来，谁都不含对方的像素', async () => {
    const doc = doc4();
    const env = fakeSplitEnv(doc, rgbaWith([...SHAPE_A, ...SHAPE_B]), []);
    const { document, goPage, played } = await loadPanel({ doc, imaging: env.imaging, onPlay: env.onPlay });
    goPage('split');
    fire(document.getElementById('splitBtn'), 'click');
    await settle();

    expect(document.getElementById('status').textContent)
      .toMatch(/识别 2 个元素，已新建 2 个独立图层/);
    const groups = selGroups(played);
    expect(groups).toHaveLength(2);
    // 选区是拼出来的，不是一个大矩形
    expect(played.filter((d) => d._obj === 'addTo').length).toBeGreaterThan(0);
    // 前提复现：两块的外框确实交叠（否则这条用例什么都没证明）
    const bbox = (rects) => rects.reduce((a, r) => ({
      left: Math.min(a.left, r.left), top: Math.min(a.top, r.top),
      right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom),
    }));
    expect(bbox(groups[0]).right).toBeGreaterThan(bbox(groups[1]).left);
    expect(coverOf([bbox(groups[0])], SHAPE_A, SHAPE_B).leaked).toBeGreaterThan(0);   // 整框会漏
    // 实际下发的选区：一个像素都不漏、一个像素都不多
    expect(coverOf(groups[0], SHAPE_A, SHAPE_B)).toEqual({ missed: 0, leaked: 0 });
    expect(coverOf(groups[1], SHAPE_B, SHAPE_A)).toEqual({ missed: 0, leaked: 0 });
    expect(env.copies.map((c) => c.name)).toEqual(['0', '1']);
  });

  it('PS 不认 addTo 时退回整框，整批不失败', async () => {
    const doc = doc4();
    const env = fakeSplitEnv(doc, rgbaWith([...SHAPE_A, ...SHAPE_B]), []);
    const onPlay = (d) => {
      if (d._obj === 'addTo') throw new Error('Illegal argument');
      return env.onPlay(d);
    };
    const { document, goPage, played } = await loadPanel({ doc, imaging: env.imaging, onPlay });
    goPage('split');
    fire(document.getElementById('splitBtn'), 'click');
    await settle();

    expect(document.getElementById('status').textContent)
      .toMatch(/识别 2 个元素，已新建 2 个独立图层/);
    expect(played.filter((d) => d._obj === 'copyEvent')).toHaveLength(2);
  });
});

// 批量改尺寸：四步向导 + 整批执行。
// 这一段在 Node 里把「选图片 → 设尺寸 → 设输出 → 跑」整条链走完，守住四件真机上
// 最容易错、又最难肉眼发现的事：
//   1) 每一步的校验真的拦得住（没选图不许往下走）；
//   2) 下发给 PS 的 imageSize / canvasSize 数值与锚点枚举正确；
//   3) 文件名、扩展名、JPG 质量换算（面板 1-100 → PS 的 12 档）正确；
//   4) 多尺寸时一个文件只打开一次（靠快照回退），而不是重开三遍。
describe('批量改尺寸：向导与整批执行', () => {
  const fakeFile = (name) => ({ name, isFile: true, isFolder: false, nativePath: `D:\\img\\${name}` });

  /** 输出文件夹桩：记下建过的文件名与子目录 */
  function fakeFolder(name = 'Resized') {
    const created = [];
    const folders = [];
    return {
      name,
      isFolder: true,
      isFile: false,
      nativePath: `D:\\img\\${name}`,
      _created: created,
      _folders: folders,
      async getEntries() { return []; },
      async getEntry() { throw new Error('not found'); },
      async createFolder(n) { folders.push(n); return fakeFolder(n); },
      async createFile(n) { created.push(n); return { name: n, isFile: true }; },
    };
  }

  /** 图片文档桩：够 resizer 走完「读尺寸 → imageSize → canvasSize → 另存 → 关」 */
  function fakeImageDoc(width, height) {
    const saved = [];
    const doc = {
      id: 7,
      name: 'shot.jpg',
      width,
      height,
      layers: [{ id: 1, isBackgroundLayer: true, visible: true }],
      activeLayers: [],
      _saved: saved,
      saveAs: {
        png: async (file) => { saved.push(['png', file.name]); },
        jpg: async (file, o) => { saved.push(['jpg', file.name, o && o.quality]); },
        psd: async (file) => { saved.push(['psd', file.name]); },
        tif: async (file) => { saved.push(['tif', file.name]); },
      },
      async closeWithoutSaving() { doc.closed = true; },
    };
    doc.duplicate = async () => doc;          // 来源是已打开文档时会复制一份，桩里返回自己
    return doc;
  }

  /** 反复让出事件循环，直到整批处理跑完（run 循环里有多处 await） */
  const drain = async (n = 80) => { for (let i = 0; i < n; i++) await settle(); };
  const paneShown = (document, i) => document.getElementById(`rzPane${i}`).style.display !== 'none';
  const clickSrc = (document, v) => fire(document.querySelector(`#rzSrcPills .pill[data-src="${v}"]`), 'click');
  const clickPill = (document, box, attr, v) => fire(document.querySelector(`#${box} .pill[${attr}="${v}"]`), 'click');
  const clickAnchor = (document, v) => fire(document.querySelector(`#rzAnchorGrid .rz-anchor[data-anchor="${v}"]`), 'click');
  const typeIn = (document, id, v) => {
    const el = document.getElementById(id);
    el.value = String(v);
    fire(el, 'input');
  };
  const descOf = (played, obj) => played.filter((d) => d._obj === obj);

  it('没选到图片也能一路往下翻页：卡只设在「开始批量修改」上', async () => {
    const { document, goPage } = await loadPanel({ doc: null });
    goPage('resize');
    expect(paneShown(document, 1)).toBe(true);
    clickSrc(document, 'files');            // 选了「选择图片」但一张都没选
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    expect(paneShown(document, 2)).toBe(true);        // 不拦：哪一步都可能是回头补设置的
    expect(document.getElementById('status').textContent).not.toMatch(/还没有选到图片/);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    expect(paneShown(document, 4)).toBe(true);
    // 点「开始批量修改」才拦：跳回缺东西的那一步，并报出「第几步 + 缺什么」
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain(5);
    expect(paneShown(document, 1)).toBe(true);
    expect(document.getElementById('status').textContent).toMatch(/第 1 步.*还没有选到图片/);
  });

  it('来源是当前文档时，位置必须指定一个文件夹（UXP 拿不到文档的磁盘目录）', async () => {
    const doc = fakeImageDoc(1920, 1080);
    const { document, goPage } = await loadPanel({ doc });
    goPage('resize');
    clickSrc(document, 'doc');
    fire(document.getElementById('rzNextBtn'), 'click');   // 1 → 2（当前文档，能过）
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');   // 2 → 3
    await drain(5);
    expect(paneShown(document, 3)).toBe(true);
    // 没点文件夹图标 → 问号浮层就得说清楚「得指定一个位置」，而不是含糊地说存回原文件夹
    fire(document.getElementById('rzDestInfo'), 'mouseover');
    expect(document.getElementById('rzDestTip').innerHTML).toMatch(/当前文档.*文件夹图标/);
    expect(document.getElementById('rzOutReset').style.display).toBe('none');   // 没得撤
    // 没选输出文件夹 → 不许开跑
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain(5);
    expect(document.getElementById('status').textContent).toMatch(/来源是当前文档.*文件夹图标/);
  });

  it('整批跑通：固定宽高 + 等比适应 → imageSize / canvasSize 数值与锚点、文件名、JPG 质量都对', async () => {
    const doc = fakeImageDoc(1920, 1080);
    const out = fakeFolder();
    const { document, goPage, played } = await loadPanel({
      doc, folder: out, files: [fakeFile('a.jpg')],
    });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    expect(document.getElementById('rzSrcInfo').textContent).toMatch(/已选 1 张/);

    fire(document.getElementById('rzNextBtn'), 'click');       // → 第 2 步
    await drain(5);
    typeIn(document, 'rzW', 1024);
    typeIn(document, 'rzH', 1024);
    clickPill(document, 'rzFitPills', 'data-fit', 'contain');
    clickAnchor(document, 'ct');                               // 锚点：上
    fire(document.getElementById('rzNextBtn'), 'click');       // → 第 3 步
    await drain(5);
    fire(document.getElementById('rzPickOutBtn'), 'click');   // 点文件夹图标 → 指定输出位置
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');       // → 第 4 步
    await drain(5);
    expect(paneShown(document, 4)).toBe(true);

    fire(document.getElementById('rzRunBtn'), 'click');
    await drain();

    // 1920×1080 装进 1024×1024 → 图 1024×576，画布 1024×1024（补边）
    const img = descOf(played, 'imageSize');
    expect(img).toHaveLength(1);
    expect([img[0].width._value, img[0].height._value]).toEqual([1024, 576]);
    expect(img[0].constrainProportions).toBe(false);           // 比例由插件算，不交给 PS
    const cvs = descOf(played, 'canvasSize');
    expect(cvs).toHaveLength(1);
    expect([cvs[0].width._value, cvs[0].height._value]).toEqual([1024, 1024]);
    expect([cvs[0].horizontal._value, cvs[0].vertical._value]).toEqual(['center', 'top']);
    // 扩画布前先把背景层转普通层，否则补出来的边是背景色不是透明
    expect(descOf(played, 'set').some((d) => d._target && d._target[0]._property === 'background')).toBe(true);
    // 保持原格式 → jpg；面板质量 90 → PS 的 11 档（12 档制）
    expect(doc._saved).toEqual([['jpg', 'a.jpg', 11]]);
    expect(out._created).toEqual(['a.jpg']);
    expect(document.getElementById('rzOkN').textContent).toBe('1');
    expect(document.getElementById('rzFailN').textContent).toBe('0');
    expect(document.getElementById('status').textContent).toMatch(/处理完成：成功 1/);
  });

  it('多尺寸输出：一个文件只打开一次，靠快照回退存三档，名字各带尺寸', async () => {
    const doc = fakeImageDoc(1024, 1024);
    const out = fakeFolder();
    const { document, goPage, played } = await loadPanel({
      doc, folder: out, files: [fakeFile('icon.png')],
    });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);

    typeIn(document, 'rzW', 1024);
    typeIn(document, 'rzH', 1024);
    fire(document.getElementById('rzMulti'), 'click');         // 开多尺寸
    fire(document.getElementById('rzAddScales'), 'click');     // 1x / 2x / 3x（按原图算）
    await drain(5);
    expect(document.getElementById('rzSizeList').innerHTML).toMatch(/原图 × 2/);
    // 列表里的 ✕ 能删掉那一档（面板拼的 innerHTML → 桩里还原成可点的假元素）
    fire(document.querySelectorAll('#rzSizeList .gd-mini')[2], 'click');
    await drain(3);
    expect(document.getElementById('rzSizeList').innerHTML).not.toMatch(/原图 × 3/);
    fire(document.getElementById('rzAddScales'), 'click');      // 再加回来
    await drain(3);

    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzPickOutBtn'), 'click');   // 点文件夹图标 → 指定输出位置
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain();

    // 只打开一次（一条 open 描述符），建一次快照、回退两次
    expect(descOf(played, 'open')).toHaveLength(1);
    expect(played.filter((d) => d._obj === 'make' && d._target && d._target[0]._ref === 'snapshotClass')).toHaveLength(1);
    expect(played.filter((d) => d._obj === 'select' && d._target && d._target[0]._ref === 'snapshotClass')).toHaveLength(2);
    // 三档各存一次，名字带算出来的实际尺寸（原图 1024 → 1x/2x/3x），互不覆盖
    expect(out._created).toEqual(['icon_1024x1024.png', 'icon_2048x2048.png', 'icon_3072x3072.png']);
    expect(document.getElementById('rzOkN').textContent).toBe('3');
  });

  // 「小图处理」三选一的入口已经撤掉（选了 1024 却输出 512 太反直觉），恒按「放大到目标」。
  // 这条钉住那个默认值 —— 撤控件时最容易顺手把默认值也带偏。
  it('小图默认放大到目标：512 的图配 1024 → 真的输出 1024，不跳过', async () => {
    const doc = fakeImageDoc(512, 512);
    const out = fakeFolder();
    const { document, goPage, played } = await loadPanel({
      doc, folder: out, files: [fakeFile('small.png')],
    });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    typeIn(document, 'rzW', 1024);
    typeIn(document, 'rzH', 1024);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzPickOutBtn'), 'click');   // 点文件夹图标 → 指定输出位置
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain();

    const img = descOf(played, 'imageSize');
    expect(img).toHaveLength(1);
    expect([img[0].width._value, img[0].height._value]).toEqual([1024, 1024]);
    expect(out._created).toEqual(['small.png']);
    expect(document.getElementById('rzSkipN').textContent).toBe('0');
    expect(document.getElementById('rzOkN').textContent).toBe('1');
  });

  it('下拉菜单展开时输入框必须躲开（UXP 的文字控件恒画在所有 DOM 之上）', async () => {
    // 真机截图确认：改尺寸页的菜单向下展开，被下面的「宽度 / 高度」输入框切掉一半。
    // z-index 管不着原生编辑层，只能在菜单开着时把输入框藏起来 —— 这条钉住那个联动。
    const { document, goPage } = await loadPanel({ doc: fakeImageDoc(1920, 1080) });
    goPage('resize');
    fire(document.getElementById('rzNextBtn'), 'click');        // → 第 2 步（尺寸设置）
    await drain(5);
    const w = document.getElementById('rzW');
    expect(w.style.visibility).toBe('');
    fire(document.getElementById('rzModeDd'), 'click');         // 展开「调整模式」
    expect(document.getElementById('rzModeDd').classList.contains('open')).toBe(true);
    expect(w.style.visibility).toBe('hidden');
    fire(document.querySelector('#rzModeDd .dd-item[data-mode="long"]'), 'click');
    expect(w.style.visibility).toBe('');                        // 选完就放回来
  });

  /** 展开某个自绘下拉再点里面一项（真机上得先开菜单，节点才挂着点击） */
  const pickDd = (document, dd, menu, attr, v) => {
    fire(document.getElementById(dd), 'click');
    fire(document.querySelector(`#${menu} .dd-item[${attr}="${v}"]`), 'click');
  };
  const modeName = (document) => document.getElementById('rzModeValue').textContent;
  const shown = (document, id) => document.getElementById(id).style.display !== 'none';

  it('预设选了「缩放 50%」再选回「自定义」：参数和参数区都回到套预设之前那一套', async () => {
    // 真机上「自定义」原来是个死选项：参数不还原、参数区还停在缩放那一页。
    const { document, goPage } = await loadPanel({ doc: fakeImageDoc(1920, 1080) });
    goPage('resize');
    fire(document.getElementById('rzNextBtn'), 'click');       // → 第 2 步
    await drain(5);
    typeIn(document, 'rzW', 800);
    typeIn(document, 'rzH', 600);

    pickDd(document, 'rzPresetDd', 'rzPresetMenu', 'data-preset', '5');   // 缩放 50%
    await drain(3);
    expect(document.getElementById('rzPresetValue').textContent).toBe('缩放 50%');
    expect(modeName(document)).toBe('百分比缩放');
    expect(shown(document, 'rzFieldPercent')).toBe(true);
    expect(shown(document, 'rzFieldWH')).toBe(false);

    pickDd(document, 'rzPresetDd', 'rzPresetMenu', 'data-preset', '-1');  // 自定义
    await drain(3);
    expect(modeName(document)).toBe('固定宽高');
    expect(shown(document, 'rzFieldWH')).toBe(true);           // 参数区跟着回来
    expect(shown(document, 'rzFieldPercent')).toBe(false);
    expect(document.getElementById('rzW').value).toBe('800');
    expect(document.getElementById('rzH').value).toBe('600');
  });

  it('没套过预设时点「自定义」：一个字段都不许动（别拿默认值把用户填的清了）', async () => {
    const { document, goPage } = await loadPanel({ doc: fakeImageDoc(1920, 1080) });
    goPage('resize');
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    typeIn(document, 'rzW', 777);
    pickDd(document, 'rzPresetDd', 'rzPresetMenu', 'data-preset', '-1');
    await drain(3);
    expect(document.getElementById('rzW').value).toBe('777');
    expect(modeName(document)).toBe('固定宽高');
  });

  it('套了预设又手动改调整模式：下拉的名字回到「自定义」', async () => {
    const { document, goPage } = await loadPanel({ doc: fakeImageDoc(1920, 1080) });
    goPage('resize');
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    pickDd(document, 'rzPresetDd', 'rzPresetMenu', 'data-preset', '2');   // 1024 × 1024
    await drain(3);
    expect(document.getElementById('rzPresetValue').textContent).toBe('1024 × 1024');
    pickDd(document, 'rzModeDd', 'rzModeDd', 'data-mode', 'long');   // 模式菜单没单独的 id
    await drain(3);
    expect(document.getElementById('rzPresetValue').textContent).toBe('自定义');
    expect(modeName(document)).toBe('最长边');
  });

  const clickStep = (document, n) => fire(document.querySelector(`#rzSteps .rz-step[data-step="${n}"]`), 'click');

  it('步骤指示器上的 1234 往前点也换页（跨步也行）', async () => {
    const { document, goPage } = await loadPanel({ doc: fakeImageDoc(1920, 1080), folder: fakeFolder() });
    goPage('resize');
    clickStep(document, 3);                                     // 1 → 3，跨过第 2 步
    await drain(5);
    expect(paneShown(document, 3)).toBe(true);
    clickStep(document, 1);                                     // 往回点
    await drain(5);
    expect(paneShown(document, 1)).toBe(true);
  });

  it('步骤指示器不设卡：什么都没选也点得进第 4 步，缺什么留给「开始批量修改」去说', async () => {
    const { document, goPage } = await loadPanel({ doc: null });
    goPage('resize');
    clickSrc(document, 'files');            // 选了「选择图片」但一张都没选
    clickStep(document, 4);
    await drain(5);
    expect(paneShown(document, 4)).toBe(true);
    expect(document.getElementById('status').textContent).not.toMatch(/还没有选到图片/);
  });

  it('位置留空（存回原位置）而反查父目录失败：每一种 file: 写法都试过、原话照报', async () => {
    // 真机反馈过「定位不到原文件所在目录」，但没说为什么 —— 反查父目录靠 manifest 的
    // localFileSystem: "fullAccess"，而权限是装载插件时读的，刚更新过没重载就是这个样子。
    // getEntryWithUrl 对 file: 的写法很挑（官方示例单斜杠，Windows 上也有报告要分隔符原样），
    // 所以几种写法要挨个试、并且把每一次的原话都带出来，不能只报最后那一条。
    const { document, goPage } = await loadPanel({
      doc: null,
      files: [fakeFile('a.jpg')],
      entryWithUrl: async () => { throw new Error('permission denied: file:/D:/img'); },
    });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    clickStep(document, 4);                       // 位置留空 = 存回原文件所在位置（默认）
    await drain(5);
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain(5);
    const s = document.getElementById('status').textContent;
    expect(s).toMatch(/第 3 步/);
    expect(s).toMatch(/定位不到原文件所在目录/);
    expect(s).toMatch(/permission denied: file:\/D:\/img/);
    expect(s).toContain('file:/D:/img →');        // 官方示例那种单斜杠
    expect(s).toContain('file:D:/img →');         // 一个斜杠都不加
    expect(s).toContain('file:/D:\\img →');       // 分隔符原样（Windows 上有报告说这个才行）
    expect(s).toContain('file:///D:/img →');
    expect(s).toMatch(/fullAccess/);              // 连原文件自己都解析不到 → 更像是权限没生效
    expect(s).toMatch(/文件夹图标/);              // 而且告诉人下一步怎么绕开
    expect(paneShown(document, 3)).toBe(true);
  });

  it('位置的说明和「现在输出到哪儿」都在标题后面的问号里：悬停才出', async () => {
    const { document, goPage } = await loadPanel({ doc: fakeImageDoc(1920, 1080), folder: fakeFolder() });
    goPage('resize');
    clickStep(document, 3);
    await drain(5);
    const tip = document.getElementById('rzDestTip');
    expect(tip.style.display).toBe('none');
    fire(document.getElementById('rzDestInfo'), 'mouseover');
    expect(tip.style.display).toBe('block');
    expect(tip.innerHTML).toMatch(/原文件所在位置/);
    expect(tip.innerHTML).toMatch(/指定文件夹/);
    // 页面上原来还有一行提示（#rzOutInfo），跟这段话重了一半 —— 现在只在这儿讲
    // （那个 id 已经从 index.html 里撤掉，这里再取会被桩挡下，交给 ui-ids 那条守卫钉）
    fire(document.getElementById('rzDestInfo'), 'mouseout');
    expect(tip.style.display).toBe('none');
  });

  it('位置：点文件夹图标后图标换成文件夹名、给出「改回原文件夹」，点它就退回默认', async () => {
    const out = fakeFolder();
    out.name = 'Resized';
    out.nativePath = 'D:\\out\\Resized';
    const { document, goPage } = await loadPanel({ doc: null, folder: out, files: [fakeFile('a.jpg')] });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    clickStep(document, 3);
    await drain(5);
    // 悬停问号读当前状态：说明搬进去之后，「输出到哪儿」这件事实也只在那儿报
    const destTip = () => {
      fire(document.getElementById('rzDestInfo'), 'mouseover');
      return document.getElementById('rzDestTip').innerHTML;
    };
    // 默认：图标在、没有「改回原文件夹」、浮层说的是「每张图自己所在的那个文件夹」
    expect(document.getElementById('rzOutIco').style.display).not.toBe('none');
    expect(document.getElementById('rzOutText').style.display).toBe('none');
    expect(document.getElementById('rzOutReset').style.display).toBe('none');
    expect(destTip()).toMatch(/每张图存回它自己所在的那个文件夹/);

    fire(document.getElementById('rzPickOutBtn'), 'click');
    await drain(10);
    // 选中后：文件夹名顶掉图标，完整路径在浮层里
    expect(document.getElementById('rzOutIco').style.display).toBe('none');
    expect(document.getElementById('rzOutText').textContent).toBe('Resized');
    expect(document.getElementById('rzOutText').style.display).not.toBe('none');
    expect(document.getElementById('rzOutReset').style.display).not.toBe('none');   // 有得撤了
    expect(destTip()).toContain('D:\\out\\Resized');

    fire(document.getElementById('rzOutReset'), 'click');
    await drain(5);
    expect(document.getElementById('rzOutIco').style.display).not.toBe('none');
    expect(document.getElementById('rzOutReset').style.display).toBe('none');
    expect(destTip()).toMatch(/每张图存回它自己所在的那个文件夹/);
    expect(destTip()).not.toContain('D:\\out\\Resized');
  });

  // 走完一整批，停在第 4 步的「已完成」状态上，方便下面几条各自往后接。
  async function runOnce(over = {}) {
    const doc = fakeImageDoc(1920, 1080);
    const out = fakeFolder();
    const ctx = await loadPanel({ doc, folder: out, files: [fakeFile('a.jpg')], ...over });
    const { document } = ctx;
    ctx.goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzPickOutBtn'), 'click');   // 点文件夹图标 → 指定输出位置
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain();
    return { ...ctx, doc, out };
  }

  const runLabel = (document) => document.getElementById('rzRunBtn').querySelector('.btn-label').textContent;

  it('跑完之后：标题变「处理完成」、主按钮变「返回」，点它回到第 1 步', async () => {
    const { document } = await runOnce();
    expect(document.getElementById('rzOkN').textContent).toBe('1');
    expect(document.getElementById('rzRunTitle').textContent).toBe('处理完成');
    expect(runLabel(document)).toBe('返回');
    expect(document.getElementById('rzPrevBtn').style.display).not.toBe('none');   // 「上一步」留着

    fire(document.getElementById('rzRunBtn'), 'click');
    await drain(5);
    expect(paneShown(document, 1)).toBe(true);
    // 结果区一并归零，回到能再跑一次的样子
    expect(document.getElementById('rzOkN').textContent).toBe('0');
    expect(document.getElementById('rzDoneRow').style.display).toBe('none');
  });

  it('跑完后回上一步改了参数，再回第 4 步：「返回」变回「开始批量修改」', async () => {
    const { document } = await runOnce();
    expect(runLabel(document)).toBe('返回');
    fire(document.getElementById('rzPrevBtn'), 'click');      // → 第 3 步
    await drain(5);
    fire(document.getElementById('rzPrevBtn'), 'click');      // → 第 2 步
    await drain(5);
    typeIn(document, 'rzW', 800);                             // 改了尺寸 → 上一批不作数
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    expect(paneShown(document, 4)).toBe(true);
    expect(runLabel(document)).toBe('开始批量修改');
    expect(document.getElementById('rzRunTitle').textContent).toBe('准备就绪');
  });

  it('跑完后什么都没改就来回翻页：「返回」还是「返回」', async () => {
    const { document } = await runOnce();
    fire(document.getElementById('rzPrevBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    expect(runLabel(document)).toBe('返回');
  });

  it('「打开输出文件夹」：走 PS 的脚本桥（临时 .jsx + AdobeScriptAutomation Scripts）', async () => {
    // 真机两条 UXP 路都被拒过：openPath 拿扩展名比白名单（文件夹没扩展名），
    // openExternal 干脆不收 file: 协议。能走通的是 PS 自带的 ExtendScript 引擎。
    const { document, played, tmpFiles, shellCalls } = await runOnce();
    document.getElementById('status').textContent = '';
    fire(document.getElementById('rzOpenOutBtn'), 'click');
    await drain(5);
    expect(tmpFiles).toHaveLength(1);
    expect(tmpFiles[0][0]).toMatch(/\.jsx$/);
    expect(tmpFiles[0][1]).toContain('D:\\\\img\\\\Resized');   // 路径按 JS 字面量嵌进去
    expect(tmpFiles[0][1]).toContain('new Folder(p).execute()');
    const jsx = descOf(played, 'AdobeScriptAutomation Scripts');
    expect(jsx).toHaveLength(1);
    expect(jsx[0].javaScriptName).toBe('D:\\tmp\\sliceman-reveal.jsx');
    expect(shellCalls).toHaveLength(0);                          // 桥通了就不必再碰 openPath
    expect(document.getElementById('status').textContent).toBe('');
  });

  it('「打开输出文件夹」：脚本桥失败退到 openPath，成功就不报错', async () => {
    const { document, shellCalls } = await runOnce({
      onPlay: (d) => {
        if (d._obj === 'AdobeScriptAutomation Scripts') throw new Error('脚本引擎不可用');
        return null;
      },
    });
    document.getElementById('status').textContent = '';
    fire(document.getElementById('rzOpenOutBtn'), 'click');
    await drain(5);
    expect(shellCalls[0][0]).toBe('D:\\img\\Resized');
    expect(shellCalls[0][1]).toBeTruthy();                       // launchProcess 要 developerText
    expect(document.getElementById('status').textContent).toBe('');
  });

  it('「打开输出文件夹」：两条路都不通 → 路径进剪贴板，每条拒绝理由都摊在状态栏上', async () => {
    // 真机上只有这一个反馈通道，含糊一句「打不开」等于下一轮还得靠猜；
    // 而且总得给个能落地的出路 —— 路径复制走，粘到资源管理器地址栏就到了。
    const { document, copied } = await runOnce({
      onPlay: (d) => {
        if (d._obj === 'AdobeScriptAutomation Scripts') throw new Error('脚本引擎不可用');
        return null;
      },
      openPathResult: 'Extension "" is not accepted',
    });
    fire(document.getElementById('rzOpenOutBtn'), 'click');
    await drain(5);
    expect(copied).toEqual(['D:\\img\\Resized']);
    const s = document.getElementById('status').textContent;
    expect(s).toMatch(/脚本引擎不可用/);
    expect(s).toMatch(/Extension "" is not accepted/);
    expect(s).toMatch(/剪贴板/);
    expect(s).toContain('D:\\img\\Resized');
  });

  it('弹窗开着时页面上的输入框必须躲开（UXP 的文字控件恒画在弹窗之上）', async () => {
    // 真机截图确认：「我的预设」弹窗被下面那页的宽度 / 高度输入框戳穿。
    const { document, goPage } = await loadPanel({ doc: fakeImageDoc(1920, 1080) });
    goPage('resize');
    fire(document.getElementById('rzNextBtn'), 'click');       // → 第 2 步（有宽/高输入框）
    await drain(5);
    const w = document.getElementById('rzW');
    expect(w.style.visibility).toBe('');
    fire(document.getElementById('rzManagePreset'), 'click');  // 打开「我的预设」
    await drain(3);
    expect(document.getElementById('rzPresetOverlay').style.display).not.toBe('none');
    expect(w.style.visibility).toBe('hidden');
    // 弹窗自己的输入框不能跟着藏（起名弹窗要能打字）
    expect(document.getElementById('gdNameInput').style.visibility).not.toBe('hidden');
    fire(document.getElementById('rzPresetClose'), 'click');
    await drain(3);
    expect(w.style.visibility).toBe('');
  });

  it('命名示例：不在第 3 步里占一行，改参数时报到底部状态栏（两边压成「头…尾」）', async () => {
    const long = 'Modify_gaming_table_image_edges_20260903145012.png';
    const { document, goPage } = await loadPanel({ doc: null, files: [fakeFile(long)] });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');       // → 第 3 步（输出设置）
    await drain(5);
    // 页面里已经没有 #rzNameSample 这一行了（那条由 ui-ids.test.js 静态钉住），示例只走状态栏
    const txt = document.getElementById('status').textContent;
    expect(txt).toMatch(/^命名示例：/);
    expect(txt).not.toContain(long);
    expect(txt).toContain('…');
    expect(txt).not.toContain('\n');                           // 状态栏也只有一行
    expect(txt).toContain(' → ');
    expect(txt.length).toBeLessThanOrEqual(44);                // 「命名示例：」+ 两个 16 字名 + 箭头
    // 离开第 3 步就不占着状态栏了（别在别的页上挂着一句命名示例）
    fire(document.getElementById('rzPrevBtn'), 'click');
    await drain(5);
    expect(document.getElementById('status').textContent).toBe('');
  });

  it('已选清单：每一张都列出来，一行一个，长名压成「头…尾」', async () => {
    const long = 'Modify_gaming_table_image_edges_20260903145012.png';
    const { document, goPage } = await loadPanel({
      doc: null,
      files: [fakeFile(long), fakeFile('b.png'), fakeFile('c.png'), fakeFile('d.png')],
    });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    // 上面那行只报张数，名字都在清单里
    expect(document.getElementById('rzSrcInfo').textContent).toMatch(/已选 4 张/);
    expect(document.getElementById('rzSrcInfo').textContent).not.toContain('b.png');
    const list = document.getElementById('rzFileList');
    expect(list.style.display).not.toBe('none');
    const rows = list.innerHTML.match(/class="rz-file-row"/g) || [];
    expect(rows).toHaveLength(4);                              // 四张全在（多了靠滚动看）
    expect(list.innerHTML).not.toContain(long);                // 整名会甩出卡片边框
    expect(list.innerHTML).toMatch(/Modify_gaming.*….*145012\.png/);
    expect(list.innerHTML).toContain('b.png');
    // 换回「当前文档」这个来源就没有清单可列了
    clickSrc(document, 'doc');
    await drain(5);
    expect(list.style.display).toBe('none');
    expect(list.innerHTML).toBe('');
  });

  it('选择图片文件：不给对话框加扩展名过滤，选完自己按扩展名筛', async () => {
    // 真机反馈：带 types 过滤时对话框里一个图片都看不见（文件夹里明明有）。
    // 于是全都列出来、选完自己筛 —— 这条钉住「没传 types」和「非图片被忽略且如实报出」。
    const { document, goPage, pickCalls } = await loadPanel({
      doc: null, files: [fakeFile('a.jpg'), fakeFile('note.txt'), fakeFile('b.PNG')],
    });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    expect(pickCalls.files).toHaveLength(1);
    expect(pickCalls.files[0].types).toBeUndefined();
    expect(pickCalls.files[0].allowMultiple).toBe(true);
    expect(document.getElementById('rzSrcInfo').textContent).toMatch(/已选 2 张/);
    expect(document.getElementById('status').textContent).toMatch(/1 个不是支持的图片格式/);
  });

  it('「包含子文件夹」开关：重扫已经选好的那个文件夹，不再弹选择框', async () => {
    // 真机反馈：这个开关无论开还是关都会冒出一个文件夹选择框（它原来直接调了 rzPick）。
    const sub = fakeFolder('sub');
    sub.getEntries = async () => [fakeFile('c.png')];
    const root = fakeFolder('src');
    root.getEntries = async () => [fakeFile('a.png'), sub];
    const { document, goPage, pickCalls } = await loadPanel({ doc: null, folder: root });
    goPage('resize');
    clickSrc(document, 'folder');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    expect(pickCalls.folder).toBe(1);
    expect(document.getElementById('rzSrcInfo').textContent).toMatch(/已选 1 张/);

    fire(document.getElementById('rzRecursive'), 'click');      // 开
    await drain(10);
    expect(pickCalls.folder).toBe(1);                           // ← 一次都不许再弹
    expect(document.getElementById('rzSrcInfo').textContent).toMatch(/已选 2 张/);

    fire(document.getElementById('rzRecursive'), 'click');      // 关
    await drain(10);
    expect(pickCalls.folder).toBe(1);
    expect(document.getElementById('rzSrcInfo').textContent).toMatch(/已选 1 张/);
  });

  it('还没选文件夹就拨「包含子文件夹」：什么都不做（不弹选择框、不报错）', async () => {
    const { document, goPage, pickCalls } = await loadPanel({ doc: null, folder: fakeFolder('src') });
    goPage('resize');
    clickSrc(document, 'folder');
    fire(document.getElementById('rzRecursive'), 'click');
    await drain(10);
    expect(pickCalls.folder).toBe(0);
  });

  it('「失败记录」：一条失败都没有也照样开弹窗并说清楚（不置灰）', async () => {
    // .btn-off 是 pointer-events:none —— 置灰的按钮点了什么都不会发生（真机反馈「点了没反应」）。
    const { document } = await runOnce();
    expect(document.getElementById('rzFailBtn').classList.contains('btn-off')).toBe(false);
    fire(document.getElementById('rzFailBtn'), 'click');
    await drain(5);
    expect(document.getElementById('rzFailOverlay').style.display).not.toBe('none');
    expect(document.getElementById('rzFailList').innerHTML).toMatch(/没有失败的文件/);
    expect(document.getElementById('status').textContent).toMatch(/没有失败的文件/);
  });

  it('「失败记录」：有失败时列出文件名与原因', async () => {
    const doc = fakeImageDoc(1920, 1080);
    doc.saveAs.jpg = async () => { throw new Error('磁盘满了'); };
    const { document } = await runOnce({ doc });
    expect(document.getElementById('rzFailN').textContent).toBe('1');
    fire(document.getElementById('rzFailBtn'), 'click');
    await drain(5);
    const html = document.getElementById('rzFailList').innerHTML;
    expect(html).toContain('a.jpg');
    expect(html).toMatch(/磁盘满了/);
  });

  it('「打开输出文件夹」：原文件所在位置 + 多选图片这条路也认得出目录', async () => {
    // 这条路是反查父目录、根本不进目录缓存 —— 老代码只看缓存，真机上点了只说「还没有产生输出文件夹」。
    const parent = fakeFolder('photos');
    const f = fakeFile('a.jpg');
    f.getParent = async () => parent;
    const { document, goPage, tmpFiles } = await loadPanel({ doc: fakeImageDoc(1920, 1080), files: [f] });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');        // → 第 2 步
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');        // → 第 3 步（默认「原文件所在位置」）
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');        // → 第 4 步
    await drain(5);
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain();
    expect(document.getElementById('rzOkN').textContent).toBe('1');
    expect(parent._created).toEqual(['a.jpg']);

    fire(document.getElementById('rzOpenOutBtn'), 'click');
    await drain(5);
    expect(tmpFiles).toHaveLength(1);                          // 脚本桥收到的就是这个目录
    expect(tmpFiles[0][1]).toContain('D:\\\\img\\\\photos');
    expect(document.getElementById('status').textContent).not.toMatch(/还没有产生输出文件夹/);
  });

  it('跑完点「返回」：第 1 步已经选好的图片一并清空', async () => {
    const { document } = await runOnce();
    fire(document.getElementById('rzRunBtn'), 'click');         // 此时它是「返回」
    await drain(5);
    expect(paneShown(document, 1)).toBe(true);
    expect(document.getElementById('rzSrcInfo').textContent).toMatch(/可以一次选中多个图片文件/);
    // 真清空了，再点「开始批量修改」才会被第 1 步拦住（不然会以为还是上一批、直接又跑一遍）
    clickStep(document, 4);
    await drain(5);
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain(5);
    expect(paneShown(document, 1)).toBe(true);
    expect(document.getElementById('status').textContent).toMatch(/第 1 步.*还没有选到图片/);
  });

  it('多尺寸：「添加」用它自己那行的宽高，想加几档加几档；倍率也照填的来', async () => {
    const { document, goPage } = await loadPanel({
      doc: fakeImageDoc(1024, 1024), files: [fakeFile('icon.png')],
    });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    typeIn(document, 'rzW', 1024);
    typeIn(document, 'rzH', 1024);
    fire(document.getElementById('rzMulti'), 'click');          // 开多尺寸
    await drain(5);
    // 那一行默认带出上面填的一档，省得空着让人不知道填什么
    expect(document.getElementById('rzAddW').value).toBe('1024');
    expect(document.getElementById('rzScales').value).toBe('1,2,3');

    const list = () => document.getElementById('rzSizeList').innerHTML;
    typeIn(document, 'rzAddW', 800);
    typeIn(document, 'rzAddH', 600);
    fire(document.getElementById('rzAddSize'), 'click');
    await drain(3);
    typeIn(document, 'rzAddW', 320);
    typeIn(document, 'rzAddH', 240);
    fire(document.getElementById('rzAddSize'), 'click');        // 第二档：不用回上面改宽高
    await drain(3);
    expect(list()).toMatch(/800 × 600/);
    expect(list()).toMatch(/320 × 240/);

    // 倍率按**原图**算，跟上面那行的 320×240 无关：加进去的是两档倍率，不是折好的像素
    typeIn(document, 'rzScales', '0.5,2');
    fire(document.getElementById('rzAddScales'), 'click');
    await drain(3);
    expect(list()).toMatch(/原图 × 0\.5/);
    expect(list()).toMatch(/原图 × 2/);
    expect(list()).not.toMatch(/160 × 120/);            // 320×240 的 0.5 倍 —— 不该出现
    expect(document.getElementById('status').textContent).toMatch(/已按原图的 0\.5、2 倍添加 2 档/);
  });

  // 倍率档的意义就在这儿：一批图尺寸各不相同，同一档要按各自的原尺寸出。
  // 折成绝对像素的话，横图竖图全被钉死成同一个尺寸。
  it('多尺寸：倍率档按每张原图各自的尺寸算，横图竖图各出各的', async () => {
    const doc = fakeImageDoc(400, 200);
    const out = fakeFolder();
    const { document, goPage } = await loadPanel({ doc, folder: out, files: [fakeFile('wide.png')] });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    typeIn(document, 'rzW', 1024);            // 主尺寸填成方的：倍率档不该理会它
    typeIn(document, 'rzH', 1024);
    fire(document.getElementById('rzMulti'), 'click');
    typeIn(document, 'rzScales', '1,2');
    fire(document.getElementById('rzAddScales'), 'click');
    await drain(5);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzPickOutBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    fire(document.getElementById('rzRunBtn'), 'click');
    await drain();

    expect(out._created).toEqual(['wide_400x200.png', 'wide_800x400.png']);
    expect(document.getElementById('rzOkN').textContent).toBe('2');
  });

  it('多尺寸：倍率填成一堆废话时只提示，不往列表里塞垃圾', async () => {
    const { document, goPage } = await loadPanel({
      doc: fakeImageDoc(1024, 1024), files: [fakeFile('icon.png')],
    });
    goPage('resize');
    clickSrc(document, 'files');
    fire(document.getElementById('rzPickBtn'), 'click');
    await drain(10);
    fire(document.getElementById('rzNextBtn'), 'click');
    await drain(5);
    typeIn(document, 'rzW', 512);
    typeIn(document, 'rzH', 512);
    fire(document.getElementById('rzMulti'), 'click');
    await drain(5);
    typeIn(document, 'rzScales', 'abc, -1, 0');
    fire(document.getElementById('rzAddScales'), 'click');
    await drain(3);
    expect(document.getElementById('rzSizeList').innerHTML).toMatch(/还没有添加尺寸/);
    expect(document.getElementById('status').textContent).toMatch(/倍率填成用逗号隔开的数字/);
  });
});

// 完整切图：文件名与「完整导出超出画布部分」。
// 这一段是切图流水线在 Node 下的第一层守卫，钉住两件真机上报过的错：
//   1) 图层名 WG_effect_8 被压成 wgeffect8 —— 下划线被删、大小写被压平；
//   2) 开着「完整导出超出画布部分」却只导出画布内那一块 —— Reveal All 排在
//      mergeVisible 之后，而 PS 合并图层时就把画布外的像素丢掉了。
describe('完整切图：文件名与超出画布', () => {
  /** 输出文件夹桩：记下真正落盘的文件名 */
  const exportFolder = () => {
    const saved = [];
    return {
      name: 'image', isFolder: true, isFile: false, nativePath: 'D:\\out\\image',
      _saved: saved,
      async getEntries() { return []; },
      async createFile(n) { saved.push(n); return { name: n, isFile: true }; },
    };
  };

  /**
   * 源文档 + 它复制出来的共享工作文档（切图整批只复制一次）。
   * @param {string[]|Function} spec 图层名数组，或一个「每次调用都造一棵新树」的函数（要建组时用）
   */
  function exportEnv(docName, spec) {
    // 默认给的边界右下溢出画布（画布 100×100）：这样「完整导出超出画布部分」才有东西可扩
    const build = typeof spec === 'function' ? spec
      : () => spec.map((n, i) => fakeLayer(11 + i, n, { bounds: { left: 10, top: 10, right: 160, bottom: 140 } }));
    const layers = build();
    const ops = [];                       // 扩画布与合并的先后顺序（crop 不是描述符，进不了 played）
    const work = {
      id: 99,
      name: '__sliceman_work',
      layers: build(),
      activeLayers: [],
      width: 100,
      height: 100,
      _crops: [],
      // 真机的 doc.crop：矩形超出画布的部分补透明 —— 这里只记下调用
      async crop(rect) { ops.push('crop'); work._crops.push(rect); },
      saveAs: { png: async () => {} },
      async closeWithoutSaving() { work.closed = true; },
    };
    const documents = [];
    const doc = {
      id: 1,
      name: docName,
      width: 100,
      height: 100,
      layers,
      activeLayers: [],
      guides: fakeGuides([]),
      activeHistoryState: { name: 'open' },
      async duplicate() { documents.push(work); return work; },
    };
    documents.push(doc);
    // 模拟 PS：合并后活动图层是那一张拍平的像素层（空图层判断要读它的 bounds）
    const onPlay = (d) => {
      if (d._obj === 'mergeVisible') {
        ops.push('mergeVisible');
        work.activeLayers = [{ id: 500, bounds: { left: 0, top: 0, right: 50, bottom: 50 } }];
      }
      return null;
    };
    return { doc, work, documents, onPlay, ops };
  }

  /** 整批跑完（导出循环里有多处 await） */
  const drain = async (n = 80) => { for (let i = 0; i < n; i++) await settle(); };

  /** 按下发顺序取出「扩画布 / 合并」这两步，看谁先谁后 */
  const canvasOps = (played) => played
    .filter((d) => d._obj === 'revealAll' || d._obj === 'mergeVisible')
    .map((d) => d._obj);

  it('图层名里的下划线与大小写原样进文件名（不再压成 wbt1_wgeffect8）', async () => {
    const env = exportEnv('WBT_1.psb', ['WG_effect_0', 'WG_effect_1', 'WG_effect_8']);
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(out._saved).toEqual([
      'WG_effect_0.png',
      'WG_effect_1.png',
      'WG_effect_8.png',
    ]);
    expect(document.getElementById('status').textContent).toMatch(/已导出 3\/3 张/);
  });

  it('文件名不拼 PSD 名：只有「项目名（可选）+ 各级组名 + 图层名」', async () => {
    const env = exportEnv('WBT_1.psb', () => [fakeGroup(20, 'Btn_Group', [fakeLayer(21, 'icon_1')])]);
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();
    expect(out._saved).toEqual(['Btn_Group_icon_1.png']);      // 不是 WBT_1_Btn_Group_icon_1.png
  });

  it('填了项目名就只多这一段前缀（PSD 名依旧不进来）', async () => {
    const env = exportEnv('WBT_1.psb', ['icon_1']);
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    document.getElementById('projectName').value = 'Proj_A';
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();
    expect(out._saved).toEqual(['Proj_A_icon_1.png']);
  });

  // 「导出选中」时命名的起点是【用户点的那一项】，不是文档根：
  // 只点了组里的一层、没点组，名字就该只有这一层，各级组名不该冒出来。
  it('只对选中的图层切图：选组内的一层、没选组 → 名字只有图层名', async () => {
    const env = exportEnv('WBT_1.psb', () => [
      fakeGroup(20, 'Btn_Group', [fakeLayer(21, 'icon_1'), fakeLayer(22, 'icon_2')]),
    ]);
    env.doc.activeLayers = [findFakeLayer(env.doc.layers, 21)];         // 只点亮了 icon_1
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    fire(document.getElementById('selectedOnly'), 'click');             // 只对选中的图层/组切图
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();
    expect(out._saved).toEqual(['icon_1.png']);                         // 不是 Btn_Group_icon_1.png
  });

  it('同上再填项目名 → 项目名_图层名，中间不夹组名', async () => {
    const env = exportEnv('WBT_1.psb', () => [
      fakeGroup(20, 'Btn_Group', [fakeLayer(21, 'icon_1')]),
    ]);
    env.doc.activeLayers = [findFakeLayer(env.doc.layers, 21)];
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    document.getElementById('projectName').value = 'Proj_A';
    fire(document.getElementById('selectedOnly'), 'click');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();
    expect(out._saved).toEqual(['Proj_A_icon_1.png']);
  });

  it('选中的是组本身 → 组名照旧进名（PS 会把组内的层也算进 activeLayers，得去重）', async () => {
    const env = exportEnv('WBT_1.psb', () => [
      fakeGroup(20, 'Btn_Group', [fakeLayer(21, 'icon_1'), fakeLayer(22, 'icon_2')]),
    ]);
    // 真机上点一个组，activeLayers 会把组和组内的层一起给 —— selectedLayers 要去重成只剩组
    env.doc.activeLayers = [20, 21, 22].map((id) => findFakeLayer(env.doc.layers, id));
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    fire(document.getElementById('selectedOnly'), 'click');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();
    expect(out._saved).toEqual(['Btn_Group_icon_1.png', 'Btn_Group_icon_2.png']);
  });

  // 真机上报的：三层图标标成蓝色，期望合并成一张，结果三张各切各的。
  // walk 原来只认「蓝色的组」，面板说明写的却是「图层 / 组标记为蓝色：合并切图」。
  /** 工作文档里此刻点亮了哪几个像素层（组不算） */
  const litIds = (layers, out = []) => {
    for (const l of layers || []) {
      if (l.layers) litIds(l.layers, out);
      else if (l.visible) out.push(l.id);
    }
    return out;
  };
  /** 图层树读颜色标记走 batchPlay 的 get color：给定这些 id 是蓝色 */
  const blueOnPlay = (env, blueIds, lit) => (d) => {
    if (d._obj === 'get' && d._target && d._target[0] && d._target[0]._property === 'color') {
      return blueIds.includes(d._target[1]._id) ? { color: { _enum: 'color', _value: 'blue' } } : {};
    }
    if (d._obj === 'mergeVisible' && lit) lit.push(litIds(env.work.layers));
    return env.onPlay(d);
  };
  const cardDoc = () => [
    fakeGroup(20, 'card', [
      fakeLayer(21, 'plus99'),
      fakeLayer(22, 'ava_3'), fakeLayer(23, 'ava_2'), fakeLayer(24, 'ava'),
      fakeLayer(25, 'b'),
    ]),
  ];

  it('同层蓝色图层合并成一张：三层只出一个文件，名字取最下面那层', async () => {
    const env = exportEnv('WBT_1.psb', cardDoc);
    const lit = [];
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out,
      onPlay: blueOnPlay(env, [22, 23, 24], lit),
    });
    goPage('slice');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    // 原来是 5 张（plus99 / ava_3 / ava_2 / ava / b），现在中间三张并成 card_ava
    expect(out._saved).toEqual(['card_plus99.png', 'card_ava.png', 'card_b.png']);
    // 合并那一张确实是三层一起点亮（别的张只点亮自己）
    expect(lit).toEqual([[21], [22, 23, 24], [25]]);
    expect(document.getElementById('status').textContent).toMatch(/已导出 3\/3 张/);
  });

  // 蓝层中间隔着没标蓝的层：隔开的照旧单独切，蓝的还是合成一张（不看顺序）
  it('蓝色图层中间隔了一层：隔着也合，被隔开的那层自己一张', async () => {
    const env = exportEnv('WBT_1.psb', cardDoc);
    const lit = [];
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out,
      onPlay: blueOnPlay(env, [22, 24], lit),                           // ava_2(23) 没标蓝
    });
    goPage('slice');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(out._saved).toEqual(['card_plus99.png', 'card_ava_2.png', 'card_ava.png', 'card_b.png']);
    expect(lit).toEqual([[21], [23], [22, 24], [25]]);                  // 合并那张跨过了 23
  });

  it('只对选中切图 + 只点中参与合并的一层 → 整张合并图照出，不只导那一层', async () => {
    const env = exportEnv('WBT_1.psb', cardDoc);
    env.doc.activeLayers = [findFakeLayer(env.doc.layers, 23)];        // 只点亮中间那层
    const lit = [];
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out,
      onPlay: blueOnPlay(env, [22, 23, 24], lit),
    });
    goPage('slice');
    fire(document.getElementById('selectedOnly'), 'click');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(out._saved).toEqual(['ava.png']);                          // 命名从选中项算起，组名不进名
    expect(lit).toEqual([[22, 23, 24]]);
  });

  it('Symbols 切图：同一套命名规则，定位格在画布根（路径为空）也不掺 PSD 名', async () => {
    // 这是唯一一种「项目名 + 组名 + 图层名」全都凑不出来的情况 —— 用固定的 symbol 收口
    const env = exportEnv('WBT_1.psb', () => [
      fakeLayer(30, '定位格', { bounds: { left: 0, top: 0, right: 64, bottom: 64 } }),
      fakeLayer(31, 'ball', { bounds: { left: 8, top: 8, right: 56, bottom: 56 } }),
    ]);
    // Symbols 那条路要在合并之后读「内容外框 C」：合并后只剩一张拍平的像素层
    const onPlay = (d) => {
      if (d._obj === 'mergeVisible') {
        env.work.layers = [{ id: 500, visible: true, bounds: { left: 8, top: 8, right: 56, bottom: 56 } }];
      }
      return null;
    };
    env.work.crop = async (r) => { env.work.cropped = r; };
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay,
    });
    goPage('slice');
    fire(document.querySelector('#sliceModePills .pill[data-slicemode="symbols"]'), 'click');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(out._saved).toEqual(['symbol.png']);          // 不是 WBT_1.png，也不是占位的 seg1.png
    expect(env.work.cropped).toEqual({ left: 0, top: 0, right: 64, bottom: 64 });   // 裁到定位格
  });

  it('Symbols 切图：图标组名原样进文件名（下划线与大小写照旧保留）', async () => {
    const env = exportEnv('WBT_1.psb', () => [
      fakeGroup(40, 'Icon_Home', [
        fakeLayer(41, '定位格', { bounds: { left: 0, top: 0, right: 64, bottom: 64 } }),
        fakeLayer(42, 'ball', { bounds: { left: 8, top: 8, right: 56, bottom: 56 } }),
      ]),
    ]);
    const onPlay = (d) => {
      if (d._obj === 'mergeVisible') {
        env.work.layers = [{ id: 500, visible: true, bounds: { left: 8, top: 8, right: 56, bottom: 56 } }];
      }
      return null;
    };
    env.work.crop = async (r) => { env.work.cropped = r; };
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay,
    });
    goPage('slice');
    fire(document.querySelector('#sliceModePills .pill[data-slicemode="symbols"]'), 'click');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(out._saved).toEqual(['Icon_Home.png']);       // 与完整切图同一套规则
  });

  it('中文图层名照旧转拼音首字母，下划线保留', async () => {
    const env = exportEnv('测试.psd', ['图标_关闭', 'Icon 圆角']);
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(out._saved).toEqual(['tb_gb.png', 'Iconyj.png']);
  });

  it('开着「完整导出超出画布部分」：先扩画布再合并（顺序反了画布外的像素就没了）', async () => {
    const env = exportEnv('WBT_1.psb', ['a_1', 'a_2']);
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    expect(document.getElementById('fullBleed').checked).toBe(true);   // 默认开
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    // 每张都是「扩画布 → 合并」，绝不能反过来（PS 合并时会丢弃画布外的像素）
    expect(env.ops).toEqual(['crop', 'mergeVisible', 'crop', 'mergeVisible']);
    // 只扩到【这一轮参与合并的层】的范围，不是整个 PSD ——
    // 用 revealAll 会把隐藏图层也算进去，画布每张都被撑成全 PSD 大小，切图会奇慢
    expect(env.work._crops[0]).toEqual({ left: 0, top: 0, right: 160, bottom: 140 });
  });

  it('内容没超出画布：连 crop 都不发（省掉一次无谓的画布操作）', async () => {
    const env = exportEnv('WBT_1.psb', () => [fakeLayer(11, 'a_1', {
      bounds: { left: 10, top: 10, right: 90, bottom: 90 },           // 老老实实在 100×100 里
    })]);
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    expect(document.getElementById('fullBleed').checked).toBe(true);
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(env.ops).toEqual(['mergeVisible']);
    expect(env.work._crops).toEqual([]);
  });

  it('关掉开关：不扩画布，溢出像素照旧被裁掉', async () => {
    const env = exportEnv('WBT_1.psb', ['a_1']);                       // 这一层是溢出画布的
    const out = exportFolder();
    const { document, played, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    fire(document.getElementById('fullBleed'), 'click');               // 关掉
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(env.ops).toEqual(['mergeVisible']);                         // 溢出也不扩
    expect(canvasOps(played)).toEqual(['mergeVisible']);               // revealAll 已彻底不用
    expect(out._saved).toEqual(['a_1.png']);
  });

  it('同名只差大小写：仍然当撞名处理，不让后一张静默覆盖前一张', async () => {
    // Windows 的文件名不分大小写，WG_1.png 与 wg_1.png 是同一个文件
    const env = exportEnv('P.psd', ['WG_1', 'wg_1']);
    const out = exportFolder();
    const { document, goPage } = await loadPanel({
      doc: env.doc, documents: env.documents, folder: out, onPlay: env.onPlay,
    });
    goPage('slice');
    fire(document.getElementById('sliceBtn'), 'click');
    await drain();

    expect(out._saved).toEqual(['WG_1.png', 'wg_1_2.png']);
    expect(document.getElementById('status').textContent).toMatch(/去重 1 次/);
  });
});
