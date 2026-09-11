import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// UXP 下 getElementById 拿到 null 之后再取属性会直接抛错，整个面板停在空白页
//（没有控制台的用户只会看到「插件坏了」）。这里在 Node 里静态比对一遍：
// panel.js 里引用的每个 id / #选择器，index.html 中都必须真的存在。

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/ui/index.html'), 'utf8');
const js = readFileSync(join(root, 'src/ui/panel.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** 收集 js 里引用到的 id，附带出处便于定位 */
function collect(re, pick) {
  return [...js.matchAll(re)].map((m) => pick(m));
}

describe('panel.js 引用的 DOM id 都存在于 index.html', () => {
  it('getElementById 的每个 id 都能找到', () => {
    const used = collect(/getElementById\(\s*'([^']+)'\s*\)/g, (m) => m[1]);
    expect(used.length).toBeGreaterThan(40);          // 防止正则失效后静默通过
    const missing = [...new Set(used)].filter((id) => !htmlIds.has(id));
    expect(missing).toEqual([]);
  });

  it('字符串常量数组里的 id（TIP_MASKED_FIELD_IDS / GD_FIELDS 等）也都存在', () => {
    // 形如 const XXX_IDS/XXX_FIELDS = [ 'a', 'b', ... ]，逐个校验
    const blocks = collect(
      /const\s+\w*(?:FIELD|FIELDS|IDS)\s*=\s*\[([\s\S]*?)\]/g,
      (m) => m[1],
    );
    expect(blocks.length).toBeGreaterThan(0);
    const missing = [];
    for (const b of blocks) {
      for (const m of b.matchAll(/'([^']+)'/g)) {
        if (!htmlIds.has(m[1])) missing.push(m[1]);
      }
    }
    expect(missing).toEqual([]);
  });

  it('querySelector/querySelectorAll 里的 #id 都能找到', () => {
    const used = collect(/querySelectorAll?\(\s*[`'"]#([A-Za-z0-9_-]+)/g, (m) => m[1]);
    const missing = [...new Set(used)].filter((id) => !htmlIds.has(id));
    expect(missing).toEqual([]);
  });

  it('传给 show() / setPillActive() / setupSwitch() 的 id 都能找到', () => {
    const used = [
      ...collect(/\bshow\(\s*'([^']+)'/g, (m) => m[1]),
      ...collect(/\bsetupSwitch\(\s*'([^']+)'/g, (m) => m[1]),
      ...collect(/\bsetPillActive\(\s*'([^']+)'/g, (m) => m[1]),
      ...collect(/\bbindPillGroup\(\s*'([^']+)'/g, (m) => m[1]),
      ...collect(/\bbindTogglePills\(\s*'([^']+)'/g, (m) => m[1]),
      ...collect(/\bbindDropdownBox\(\s*'([^']+)'/g, (m) => m[1]),
    ];
    expect(used.length).toBeGreaterThan(10);
    const missing = [...new Set(used)].filter((id) => !htmlIds.has(id));
    expect(missing).toEqual([]);
  });
});

describe('左侧功能栏与 panel.js 的契约', () => {
  // 功能入口从顶部磁贴改成左侧竖排后，切页仍然只靠「.tile 这个 class + data-page 属性」
  //（panel.js 的 querySelectorAll('.tile') / switchPage / setTilesDisabled 都认它们）。
  // 谁把 class 改了名或漏搬一个入口，面板不会报错，只会「点了没反应」——静态钉住。
  const tiles = [...html.matchAll(/<div class="tile(?: active)?" data-page="([^"]+)"/g)]
    .map((m) => m[1]);

  it('功能栏里有 9 个 .tile，且都带 data-page', () => {
    // 顺序就是面板上从上到下的顺序：平移排在排版前面
    expect(tiles).toEqual(['rename', 'split', 'batch', 'move', 'layout', 'table', 'guide', 'resize', 'slice']);
  });

  it('每个 data-page 在 switchPage 里都有对应的显隐分支', () => {
    const body = /function switchPage\(name\) \{([\s\S]*?)\n\}/.exec(js);
    expect(body).toBeTruthy();
    const missing = tiles.filter((p) => !body[1].includes(`name === '${p}'`));
    expect(missing).toEqual([]);
  });

  it('功能栏与内容列的骨架都在（工作区 = .rail + .pages）', () => {
    for (const cls of ['workspace', 'rail', 'rail-foot', 'pages']) {
      expect(html).toContain(`class="${cls}"`);
    }
    // 设置钮已从顶栏移进功能栏底部：顶栏那层壳不该再有
    expect(html).not.toContain('topbar-actions');
  });

  it('分割页两个主按钮随页显隐：既不在 switchPage 里单独控制，也不能自带 display:none', () => {
    // 分割页有两个功能，按钮各自跟在自己的卡片下面、包在 #splitPage 里随页一起显隐。
    // 两种改坏方式都不会报错，只会「按钮永远不出现」或「在别的页上常驻」：
    //   · 谁又给按钮加回内联 display:none —— 没人再把它显示出来
    //   · 谁又在 switchPage 里 show('splitBtn') —— 与页级显隐打架
    const body = /function switchPage\(name\) \{([\s\S]*?)\n\}/.exec(js)[1];
    for (const id of ['splitBtn', 'gsBtn']) {
      expect(body).not.toContain(`show('${id}'`);
      const tag = new RegExp(`<button id="${id}"[^>]*>`).exec(html);
      expect(tag).toBeTruthy();
      expect(tag[0]).not.toMatch(/display:\s*none/);
    }
    expect(/<div id="splitPage"[^>]*style="display:none;?"/.test(html)).toBe(true);
  });

  it('改尺寸页第 4 步的两个按钮并排一行：主按钮就在 .rz-nav 里，且宽度不再是 100%', () => {
    // 「开始批量修改」原来是 .rz-nav 之外的整宽主按钮，跟「上一步」上下叠着。
    // 现在它进了导航行，两件事必须同时成立，否则又变回两行：
    //   · 标记上它是 .rz-nav 的子节点（按 div 深度扫，别用贪婪正则）
    //   · 样式上压掉 .primary-btn 的 width:100%
    const at = html.indexOf('<div class="rz-nav"');
    expect(at).toBeGreaterThan(0);
    let depth = 0;
    let end = at;
    for (const m of html.slice(at).matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) { end = at + m.index + 6; break; }
    }
    const nav = html.slice(at, end);
    expect(nav).toContain('id="rzPrevBtn"');
    expect(nav).toContain('id="rzRunBtn"');
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/\.rz-nav #rzRunBtn \{[^}]*width:\s*auto/);
    // 处理中「停止处理」就是这个主按钮：整行一藏就没法停了
    const body = /function rzSetRunning\(on\) \{([\s\S]*?)\n\}/.exec(js);
    expect(body).toBeTruthy();
    expect(body[1]).not.toContain("show('rzNav'");
  });

  it('已选清单允许按字符折行（长文件名没有空格可断，否则甩出卡片）', () => {
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.match(/\.rz-hint\s*\{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule[1]).toMatch(/word-break:\s*break-all/);
    expect(rule[1]).toMatch(/white-space:\s*pre-line/);      // 面板里用 \n 分行
  });

  it('命名示例改走底部状态栏：第 3 步里不再占一行', () => {
    expect(htmlIds.has('rzNameSample')).toBe(false);       // 页面上那一行已经撤掉
    const fn = /function rzRenderNameSample\(\) \{([\s\S]*?)\n\}/.exec(js);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain('setStatus(');
    expect(fn[1]).toContain('rzStep === 3');              // 只在停在第 3 步时写，不去盖别的页
    // 换页时先清状态栏再刷这一页，否则刚写上去的示例又被擦掉
    const go = /function rzGoStep\(next\) \{([\s\S]*?)\n\}/.exec(js);
    expect(go).toBeTruthy();
    expect(go[1].indexOf("setStatus('')")).toBeLessThan(go[1].indexOf('rzShowStep()'));
  });

  it('已选清单：用 .preview 那套带滚动的盒子，限高按 5 行算', () => {
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // 盒子本身要带 .preview（overflow-y:auto 在那儿），否则多出来的行没法滚
    const at = html.indexOf('id="rzFileList"');
    expect(at).toBeGreaterThan(0);
    const tag = html.slice(html.lastIndexOf('<', at), at + 60);
    expect(tag).toContain('preview');
    expect(tag).toContain('rz-file-list');
    const rule = css.match(/\.rz-file-list\s*\{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule[1]).toMatch(/max-height:\s*\d+px/);       // 露 5 行、多的滚
    // 每一行一个名字，长名截断而不是折行（长文件名折行会把盒子撑高）
    const row = css.match(/\.rz-file-row\s*\{([^}]*)\}/);
    expect(row).toBeTruthy();
    expect(row[1]).toMatch(/white-space:\s*nowrap/);
    expect(row[1]).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('图片来源默认「选择图片」：这个功能是给磁盘上成批的图用的', () => {
    const at = html.indexOf('id="rzSrcPills"');
    expect(at).toBeGreaterThan(0);
    const row = html.slice(at, html.indexOf('</div>', at));
    expect(row).toContain('<span class="pill active" data-src="files">');
    expect(row).not.toContain('class="pill active" data-src="doc"');
    expect(js).toMatch(/let rzSrc = 'files';/);           // 面板里的初值要跟标记上的高亮一致
  });

  it('宽度与高度在同一行：两个格子同属 #rzFieldWH，各自还能单独显隐', () => {
    // 模式切换时「固定宽度」只显示宽那一格 —— 所以整行与两个格子都得有自己的 id
    const at = html.indexOf('id="rzFieldWH"');
    expect(at).toBeGreaterThan(0);
    const row = html.slice(at, at + 600);
    expect(row).toContain('id="rzCellW"');
    expect(row).toContain('id="rzCellH"');
    expect(row.indexOf('id="rzW"')).toBeGreaterThan(0);
    expect(row.indexOf('id="rzH"')).toBeGreaterThan(0);
    // 拆成两行的旧标记不许回来
    expect(htmlIds.has('rzFieldW')).toBe(false);
    expect(htmlIds.has('rzFieldH')).toBe(false);
  });

  it('适应方式：四个选项一行排完，说明搬进标题后面的问号提示', () => {
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/\.rz-fit-pills\s*\{([^}]*)\}/)[1]).toMatch(/flex-wrap:\s*nowrap/);
    expect(htmlIds.has('rzFitInfo')).toBe(true);
    expect(htmlIds.has('rzFitTip')).toBe(true);
    expect(htmlIds.has('rzFitHint')).toBe(false);     // 原来挂在下面的那行说明已经撤掉
    // 提示内容必须把四种适应方式都讲到，且真的接到那个问号上
    expect(js).toMatch(/bindTip\(rzEl\('rzFitInfo'\), rzEl\('rzFitTip'\), RZ_FIT_TIP\)/);
    const tip = /const RZ_FIT_HINT = \{([\s\S]*?)\n\};/.exec(js);
    expect(tip).toBeTruthy();
    for (const k of ['contain', 'cover', 'stretch', 'scale']) expect(tip[1]).toContain(`${k}:`);
  });

  it('锚点九宫格整块在面板里居中，行末那一格不留右外边距', () => {
    // 留着 margin-right 的话，三行各多出 4px，整块看着偏左 2px
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/\.rz-anchor-grid\s*\{([^}]*)\}/)[1]).toMatch(/align-items:\s*center/);
    expect(css.match(/\.rz-anchor-row\s*\{([^}]*)\}/)[1]).toMatch(/justify-content:\s*center/);
    expect(css).toMatch(/\.rz-anchor-row \.rz-anchor:last-child\s*\{[^}]*margin-right:\s*0/);
  });

  it('空白区域填充：四个选项加末尾的色块一行排完，不许折行', () => {
    // 选「自定义」时色块出现，一折行就把「自定义」挤到第二行去（真机反馈）
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/\.rz-fill-row\s*\{([^}]*)\}/)[1]).toMatch(/flex-wrap:\s*nowrap/);
    // 折行才需要的下外边距要撤掉，否则这一行比别的行高一截
    expect(css).not.toMatch(/\.rz-fill-row \.pill[^{]*\{[^}]*margin-bottom/);
  });

  it('输出位置照切图的导出设置做：一个「位置」文件夹图标，没有两选一的 pill', () => {
    // 位置只有一个状态：没选 = 存回原文件所在位置，选了 = 那个目录。
    // 原来另有一组 data-dest 的 pill，两处状态能互相说反话，撤了。
    expect(htmlIds.has('rzDestPills')).toBe(false);
    expect(html).not.toContain('data-dest=');
    expect(js).not.toContain('data-dest');
    expect(htmlIds.has('rzPickOutBtn')).toBe(true);
    expect(htmlIds.has('rzOutIco')).toBe(true);
    expect(htmlIds.has('rzOutText')).toBe(true);
    expect(htmlIds.has('rzOutReset')).toBe(true);
    // 「位置」和「输出格式」同一行，跟切图那边一个样
    const at = html.indexOf('id="rzPickOutBtn"');
    expect(at).toBeGreaterThan(0);
    const rowAt = html.lastIndexOf('class="export-row"', at);
    expect(rowAt).toBeGreaterThan(0);
    expect(html.slice(rowAt, html.indexOf('id="rzKeepTreeRow"'))).toContain('id="rzFmtDd"');
    // 输出格式默认「原格式」
    expect(html).toMatch(/<span class="dd-value" id="rzFmtValue">原格式<\/span>/);
    expect(html).toMatch(/<span class="dd-item active" data-fmt="same">原格式<\/span>/);
    // 输出位置不入参数记忆：文件夹入口跨会话拿不回来（跟切图的导出位置一个道理）
    expect(js).not.toContain("prefSet('rz.dest'");
    expect(js).not.toContain("prefGet('rz.dest'");
  });

  it('位置的说明连同「现在输出到哪儿」都进标题后面的问号，页面上不再占一行', () => {
    expect(htmlIds.has('rzDestInfo')).toBe(true);
    expect(htmlIds.has('rzDestTip')).toBe(true);
    // 浮层内容按悬停那一刻算（要报当前是哪种状态），所以给 bindTip 传的是函数而不是常量
    expect(js).toMatch(/bindTip\(rzEl\('rzDestInfo'\), rzEl\('rzDestTip'\), rzDestTipHtml\)/);
    const tip = /const RZ_DEST_TIP = ([\s\S]*?);\n/.exec(js);
    expect(tip).toBeTruthy();
    expect(tip[1]).toContain('原文件所在位置');
    expect(tip[1]).toContain('指定文件夹');
    // 那一刻算出来的第一行要把「现在输出到哪儿」讲全：默认 / 指定的完整路径 / 当前文档还没指定
    const now = /function rzDestTipHtml\(\) \{([\s\S]*?)\n\}/.exec(js);
    expect(now).toBeTruthy();
    expect(now[1]).toContain('nativePath');
    expect(now[1]).toContain('RZ_DEST_TIP');
    expect(now[1]).toMatch(/当前文档/);
    // 页面上原来那行提示（#rzOutInfo）整个撤掉，连样式规则也不留
    expect(htmlIds.has('rzOutInfo')).toBe(false);
    expect(js).not.toContain('rzOutInfo');
    expect(readFileSync(join(root, 'src/ui/styles.css'), 'utf8')).not.toContain('rzOutInfo');
    const sync = /function rzSyncOut\(\) \{([\s\S]*?)\n\}/.exec(js);
    expect(sync).toBeTruthy();
    expect(sync[1]).not.toContain('输出到每张图');
  });

  it('步骤指示器上的 1234 前后都能点，换页一律不校验', () => {
    // 这个选择器出现两次：rzShowStep 里刷高亮的那处，和挂点击的那处 —— 要的是后者
    const hits = [...js.matchAll(/querySelectorAll\('#rzSteps \.rz-step'\)/g)].map((m) => m.index);
    expect(hits.length).toBeGreaterThan(0);
    const at = hits.find((i) => js.slice(i, i + 300).includes("addEventListener('click'"));
    expect(at).toBeGreaterThan(0);
    const block = js.slice(at, at + 300);
    expect(block).toContain('rzGoStep(n)');
    expect(block).not.toContain('n < rzStep');       // 只能点回头的旧写法不许回来
    // 换页函数里不许再有校验：卡只设在「开始批量修改」上（rzRun 那一处）
    const go = /function rzGoStep\(next\) \{([\s\S]*?)\n\}/.exec(js);
    expect(go).toBeTruthy();
    expect(go[1]).not.toContain('rzValidate');
    const run = /async function rzRun\(\) \{([\s\S]*?)\n  const items =/.exec(js);
    expect(run).toBeTruthy();
    expect(run[1]).toContain('rzValidate(s)');
    expect(run[1]).toContain('第 ${s} 步');           // 报的是「第几步 + 缺什么」
  });

  it('「打开输出文件夹」走 PS 的脚本桥，不再指望 UXP 的 openExternal', () => {
    // 官方文档写明 openExternal 不收 file: 协议、openPath 卡扩展名（文件夹没有）——
    // 这两条真机都撞过，别再退回去了。
    const resizer = readFileSync(join(root, 'src/ps/resizer.js'), 'utf8');
    expect(resizer).toContain('AdobeScriptAutomation Scripts');
    expect(resizer).toContain('buildRevealJsx');
    expect(js).not.toContain('openExternal');
    const core = readFileSync(join(root, 'src/lib/resize-core.js'), 'utf8');
    expect(core).toContain('new Folder(p).execute()');
  });

  it('多尺寸那两行的输入框都登记进了「弹窗/提示时躲开」名单', () => {
    // 漏一个，它就会在提示框或弹窗开着时戳穿上层（UXP 的文字控件恒画在最上层）
    const masked = /const TIP_MASKED_FIELD_IDS = \[([\s\S]*?)\]/.exec(js);
    expect(masked).toBeTruthy();
    for (const id of ['rzAddW', 'rzAddH', 'rzScales']) {
      expect(htmlIds.has(id)).toBe(true);
      expect(masked[1]).toContain(`'${id}'`);
    }
  });

  it('内容列右侧留出滚动条的位置（否则主按钮右侧圆角被滚动条压成直角）', () => {
    // UXP 的原生滚动条永远画在 DOM 之上，z-index 管不着。.pages 是唯一的滚动区，
    // 而 width:100% 的主按钮右边缘正好落在滚动条那一列 —— 右侧不留白，两个圆角就没了。
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.match(/\.pages\s*\{([^}]*)\}/);
    expect(rule).toBeTruthy();
    const pr = rule[1].match(/padding(?:-right)?:\s*([^;]+);/);
    expect(pr).toBeTruthy();
    // 简写取右值（`0 8px` → 8px），单值写法取它自己
    const parts = pr[1].trim().split(/\s+/);
    const right = parts.length >= 2 ? parts[1] : parts[0];
    expect(parseFloat(right)).toBeGreaterThanOrEqual(6);
  });
});

describe('改尺寸页：撤掉的入口与弹窗遮罩', () => {
  // 这几个入口是按用户要求撤掉的（选了却不生效 / 用不上 / 撤了才不误导）：
  // 撤的时候 panel.js 里的接线也一起删了，谁把标记加回来但不接线，就是「点了没反应」。
  it('撤掉的控件不许回到 index.html', () => {
    for (const id of ['rzProbeBtn', 'rzSmallPills', 'rzAdvHead', 'rzAdvBody',
      'rzResampleDd', 'rzPadSmall', 'rzSkipSame', 'rzSubRow', 'rzSubName']) {
      expect(htmlIds.has(id)).toBe(false);
    }
    expect(html).not.toContain('data-src="opened"');     // 图片来源：已打开的文档
    expect(html).not.toContain('data-dest="sub"');       // 保存位置：原目录下新建
  });

  it('小图一律放大到目标：rzCfg 里 small 恒为 up', () => {
    const body = /function rzCfg\(\) \{([\s\S]*?)\n\}/.exec(js);
    expect(body).toBeTruthy();
    expect(body[1]).toMatch(/small:\s*'up'/);
  });

  it('上一步 / 下一步不带箭头符号', () => {
    expect(html).toMatch(/id="rzPrevBtn"[^>]*>\s*上一步\s*</);
    expect(html).toMatch(/id="rzNextBtn"[^>]*>\s*下一步\s*</);
  });

  it('弹窗一开就把页面上的输入框藏掉（UXP 的文字控件恒画在弹窗之上）', () => {
    // 真机截图确认：「我的预设」弹窗被下面那页的宽度 / 高度输入框戳穿。
    // z-index 管不着原生编辑层 —— 只能藏。这条钉住 showOverlay 里那个联动。
    const body = /function showOverlay\(([\s\S]*?)\n\}/.exec(js);
    expect(body).toBeTruthy();
    expect(body[1]).toMatch(/ovMaskOn\s*=/);
    expect(body[1]).toContain('applyMaskedFields()');
    // 弹窗自己的输入框不能在名单里，否则起名弹窗没法打字
    const masked = /const TIP_MASKED_FIELD_IDS = \[([\s\S]*?)\]/.exec(js);
    expect(masked).toBeTruthy();
    expect(masked[1]).not.toContain('gdNameInput');
  });

  it('manifest 声明了按路径反查目录与打开文件夹所需的权限', () => {
    // fullAccess：多选图片时只有文件入口，要按路径反查父目录（「原文件所在位置」）；
    // launchProcess：打开输出文件夹的第二条路 shell.openPath 要它（文件夹没有扩展名，
    //   所以 extensions 里得有空串）。schemes 里放 file 是没用的 —— 官方文档写明
    //   openExternal 不收 file: 协议，真机也确认被拒，那条路已经不走了。
    const mf = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
    expect(mf.requiredPermissions.localFileSystem).toBe('fullAccess');
    expect(mf.requiredPermissions.launchProcess.extensions).toContain('');
    expect(mf.requiredPermissions.launchProcess.schemes).not.toContain('file');
    expect(mf.version).toBe('1.2.0');
  });
});

describe('输入框：聚焦高亮 + 点进去清空，一个框都不能漏', () => {
  it('index.html 里的每个 <input type="text"> 都在 panel.js 的 TEXT_FIELDS 里', () => {
    const ids = [...html.matchAll(/<input type="text" id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(30);
    const block = /const TEXT_FIELDS = \[([\s\S]*?)\];/.exec(js);
    expect(block).toBeTruthy();
    const listed = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // 不多不少：漏了的框没有高亮也不清空，多出来的是改版删掉后忘了撤的死 id
    expect(listed.slice().sort()).toEqual(ids.slice().sort());
  });

  it('高亮靠 JS 加的 .focused，:focus-within 只当降级', () => {
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
    // 外层那三种画边框的容器都要有对应的 .focused 规则
    for (const box of ['.num-box', '.head-field', '.tf']) {
      expect(css).toContain(`${box}.focused`);
    }
    expect(js).toContain("classList.add('focused')");
    expect(js).toContain("classList.remove('focused')");
  });

  it('正在编辑的框一律走 fieldValue 取值，不直接读 .value', () => {
    // 点进框里值就被清空了，直接读 .value 会读成空 → 改名报「请输入查找内容」、
    // 排版间距变默认值。这几个是「按钮一点就读」的取值口，必须走 fieldValue。
    expect(js).toContain('find: fieldValue(findInput)');
    expect(js).toContain('template: fieldValue(templateInput)');
    expect(js).toContain('clampPx(fieldValue(layoutGapInput)');
    expect(js).toContain('parseDistance(fieldValue(input))');
    expect(js).toContain('const rzVal = (id) => fieldValue(rzEl(id))');
  });
});

describe('重命名页：改名对象 = 图层面板里真正点亮的那些', () => {
  it('走 targetLayersIDs 而不是 activeLayers，预览与执行用的是同一个来源', () => {
    // 真机实测：选中一个组，PS 会把组里的层也算进 activeLayers，「只选了组」和
    // 「组与组内层都点亮了」在那个列表里长得一样；targetLayersIDs 只报真正点亮的。
    const body = /async function trueSelectedLayers\(\) \{([\s\S]*?)\n\}/.exec(js);
    expect(body).toBeTruthy();
    expect(body[1]).toContain('targetLayersIDs');
    expect(body[1]).toContain("_value: 'targetEnum'");
    expect(body[1]).toContain('selectedLayers()');            // 旧版 PS 读不到时的兜底
    // 定义 1 处 + 预览 / 执行 2 处；漏一处就是「预览里写着要改的、实际改的不是同一批」
    expect((js.match(/trueSelectedLayers\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('「按名称查找」就在大标题那一行，靠 margin-left:auto 贴右', () => {
    const head = /<div class="feature-head">([\s\S]*?)<\/div>\s*<div class="field-block">/.exec(html);
    expect(head).toBeTruthy();
    // 标题在前、按钮在后：同一行里一左一右
    expect(head[1].indexOf('批量重命名')).toBeLessThan(head[1].indexOf('id="slOpenBtn"'));
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/\.feature-head \.find-btn \{[^}]*margin-left:\s*auto/);
    expect(css).not.toMatch(/#targetRow/);                    // 原来那一行已经撤掉
    expect(html).not.toMatch(/id="targetRow"/);
  });

  it('数字位数四个选项排在同一行（.pill-row 默认会折行，面板只有 340px 宽）', () => {
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/#digitsPills \{[^}]*flex-wrap:\s*nowrap/);
    // 四等分剩余宽度才塞得下「1 位」～「4 位」；只写 nowrap 会被挤出容器
    expect(css).toMatch(/#digitsPills \.pill \{[^}]*flex:\s*1 1 0/);
  });

  it('「连组内图层一起改」开关已彻底移除，旧的记忆键也清掉', () => {
    expect(htmlIds.has('renameDeep')).toBe(false);
    expect(html).not.toContain('连组内图层一起改');
    expect(js).not.toContain('renameDeepEl');
    expect(js).not.toContain('allSelectedLayers');
    expect(js).not.toMatch(/setupSwitch\('renameDeep'/);
    expect(js).toContain("localStorage.removeItem('rename.deep')");
  });
});

describe('index.html 遵守 UXP 渲染约束', () => {
  it('不出现位图 <img>（多张位图会让 PS 进程 native 崩溃）', () => {
    expect(html).not.toMatch(/<img\b/i);
  });

  it('内联 svg 不带 filter / 渐变（GPU 高危项）', () => {
    expect(html).not.toMatch(/<filter\b|feDropShadow|linearGradient|radialGradient/i);
  });

  it('弹窗本体的 class 不与 panel.js 拼出来的元件同名', () => {
    // 真机踩过：查找弹窗本体和结果行里的勾选框都叫 .sl-box，弹窗吃到勾选框的
    // width/height:12px，整个窗被压成一条几十像素高的带子，内容全看不见。
    const boxClasses = [...html.matchAll(/class="overlay-box ([^"]+)"/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter(Boolean);
    expect(boxClasses.length).toBeGreaterThan(0);          // 防止正则失效后静默通过
    const clash = boxClasses.filter((c) => new RegExp(`class="[^"]*\\b${c}\\b`).test(js));
    expect(clash).toEqual([]);
  });

  it('限高一律用固定像素，不用百分比 max-height', () => {
    // 约定而非已知缺陷：项目里验证过能用的弹窗都是「本体高度由内容决定 + 内部列表按
    // 固定像素限高」。百分比高度在 UXP 下没验证过，且一旦哪条规则又给本体塞了固定
    // 高度，配上 overflow 就会把弹窗压成一条带（见 styles.css 里 sl-dialog 那段）。
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/max-height:\s*\d+%/);
  });

  it('样式表不用 grid / box-shadow / position:fixed（UXP 不支持或高危）', () => {
    const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');            // 注释里提到这些词不算
    expect(css).not.toMatch(/display:\s*(inline-)?grid/);
    // 允许 box-shadow:none（用来关掉 UXP 给输入框自绘的那圈装饰），其余一律不许
    expect(css).not.toMatch(/box-shadow:(?!\s*none)/);
    expect(css).not.toMatch(/position:\s*fixed/);
  });
});
