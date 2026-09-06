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

describe('index.html 遵守 UXP 渲染约束', () => {
  it('不出现位图 <img>（多张位图会让 PS 进程 native 崩溃）', () => {
    expect(html).not.toMatch(/<img\b/i);
  });

  it('内联 svg 不带 filter / 渐变（GPU 高危项）', () => {
    expect(html).not.toMatch(/<filter\b|feDropShadow|linearGradient|radialGradient/i);
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
