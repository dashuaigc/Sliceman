import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
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
  const document = {
    _listeners: docListeners,
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    querySelector: () => makeEl(),
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
