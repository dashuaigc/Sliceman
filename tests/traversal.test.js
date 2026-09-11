import { describe, it, expect } from 'vitest';
import { walk, filterTasksBySelection } from '../src/lib/traversal.js';

let _id = 0;
const g = (name, label, children, visible = true) => ({ id: ++_id, name, kind: 'group', label, visible, children });
const l = (name, label = null, visible = true) => ({ id: ++_id, name, kind: 'layer', label, visible, children: [] });

describe('walk', () => {
  it('默认：每个可见叶子各一任务，组作前缀', () => {
    const tree = g('root', null, [ g('nav', null, [ l('home'), l('icon') ]) ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks).toEqual([
      { type: 'layer', node: expect.any(Object), pathSegments: ['nav', 'home'] },
      { type: 'layer', node: expect.any(Object), pathSegments: ['nav', 'icon'] },
    ]);
  });

  it('红色图层被跳过', () => {
    const tree = g('root', null, [ l('a'), l('b', 'red') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['a']);
  });

  it('红色组整棵子树被跳过', () => {
    const tree = g('root', null, [ g('skip', 'red', [ l('x'), l('y') ]), l('keep') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['keep']);
  });

  it('蓝色组产出单个 merged 任务，不递归', () => {
    const tree = g('root', null, [ g('card', 'blue', [ l('bg'), l('txt') ]) ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks).toEqual([
      { type: 'merged', node: expect.any(Object), pathSegments: ['card'] },
    ]);
  });

  // 面板说明写的是「图层 / 组标记为蓝色：合并切图」—— 图层也算，不是只有组
  it('同一层级下的蓝色图层合并成一张，名字取最下面那层', () => {
    const a = l('下注头像 拷贝 3', 'blue');
    const b = l('下注头像 拷贝 2', 'blue');
    const c = l('下注头像', 'blue');
    const tree = g('root', null, [ g('card', null, [ l('+99'), a, b, c, l('b') ]) ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['card/+99', 'card/下注头像', 'card/b']);
    const merged = tasks[1];
    expect(merged.type).toBe('merged');
    expect(merged.members).toEqual([a, b, c]);          // 三层都进合并
    expect(merged.node).toBe(c);                        // 出名字的是最下面那层
  });

  // 不看顺序：同层级标蓝的就是一伙的，中间隔着没标蓝的层照样合
  it('中间夹了别的层也照合：同层四个蓝层还是一张', () => {
    const tree = g('root', null, [
      l('a', 'blue'), l('a2', 'blue'), l('中间'), l('b', 'blue'), l('b2', 'blue'),
    ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['中间', 'b2']);
    expect(tasks.map(t => t.type)).toEqual(['layer', 'merged']);
    expect(tasks[1].members.map(m => m.name)).toEqual(['a', 'a2', 'b', 'b2']);
  });

  // 「同层级」按父容器算：组里的蓝层不会跟组外的蓝层合到一起
  it('不同层级的蓝色图层各合各的', () => {
    const tree = g('root', null, [
      g('nav', null, [ l('x', 'blue'), l('y', 'blue') ]),
      l('p', 'blue'), l('q', 'blue'),
    ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['nav/y', 'q']);
    expect(tasks[0].members.map(m => m.name)).toEqual(['x', 'y']);
    expect(tasks[1].members.map(m => m.name)).toEqual(['p', 'q']);
  });

  it('孤零零一个蓝色图层：还是它自己一张，跟不标蓝一样', () => {
    const tree = g('root', null, [ l('solo', 'blue'), l('x') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks).toEqual([
      { type: 'layer', node: expect.any(Object), pathSegments: ['solo'] },
      { type: 'layer', node: expect.any(Object), pathSegments: ['x'] },
    ]);
  });

  // 这一轮不导出的层不进合并，但也不影响别人合
  it('隐藏的蓝色图层不进合并；开了「包含隐藏图层」才算进来', () => {
    const tree = g('root', null, [ l('t', 'blue'), l('m', 'blue', false), l('b', 'blue') ]);
    const off = walk(tree, { includeHidden: false });
    expect(off.map(t => t.pathSegments.join('/'))).toEqual(['b']);
    expect(off[0].members.map(m => m.name)).toEqual(['t', 'b']);
    const on = walk(tree, { includeHidden: true });
    expect(on.map(t => t.pathSegments.join('/'))).toEqual(['b']);
    expect(on[0].members.map(m => m.name)).toEqual(['t', 'm', 'b']);
  });

  it('红色仍然优先于蓝色：红的不切，其余蓝层照合', () => {
    const tree = g('root', null, [ l('t', 'blue'), l('r', 'red'), l('b', 'blue') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['b']);
    expect(tasks[0].members.map(m => m.name)).toEqual(['t', 'b']);
  });

  it('蓝色组同层有蓝色图层：组照旧整组一张，不把外面的层吸进来', () => {
    const tree = g('root', null, [ g('card', 'blue', [ l('bg') ]), l('x', 'blue'), l('y', 'blue') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(tasks.map(t => t.pathSegments.join('/'))).toEqual(['card', 'y']);
    expect(tasks[0].members).toBeUndefined();           // 蓝色组走老路子：合并整组
    expect(tasks[1].members.map(m => m.name)).toEqual(['x', 'y']);
  });

  it('隐藏叶子默认跳过，开开关后纳入', () => {
    const tree = g('root', null, [ l('vis'), l('hid', null, false) ]);
    expect(walk(tree, { includeHidden: false }).map(t => t.pathSegments.join('/'))).toEqual(['vis']);
    expect(walk(tree, { includeHidden: true }).map(t => t.pathSegments.join('/'))).toEqual(['vis', 'hid']);
  });

  it('隐藏组默认跳过其内容', () => {
    const tree = g('root', null, [ g('hidgrp', null, [ l('x') ], false) ]);
    expect(walk(tree, { includeHidden: false })).toEqual([]);
  });
});

describe('filterTasksBySelection（导出选中）', () => {
  const names = (tasks) => tasks.map((t) => t.pathSegments.join('/'));

  it('选中一个组 → 保留组内各叶子任务，排除组外', () => {
    const nav = g('nav', null, [ l('home'), l('icon') ]);
    const foot = g('foot', null, [ l('copy') ]);
    const tree = g('root', null, [ nav, foot ]);
    const tasks = walk(tree, { includeHidden: false });
    const out = filterTasksBySelection(tasks, tree, [nav.id]);
    expect(names(out)).toEqual(['nav/home', 'nav/icon']);
  });

  // 命名路径以「用户点的那一项」为起点：只点了组里的某一层、没点组，
  // 名字就该只是这一层的名字，不该冒出各级组名。
  it('只选组内的一层（没选组）→ 名字只剩这一层，各级组名不进名', () => {
    const home = l('home');
    const nav = g('nav', null, [ home, l('icon') ]);
    const tree = g('root', null, [ nav ]);
    const tasks = walk(tree, { includeHidden: false });
    const out = filterTasksBySelection(tasks, tree, [home.id]);
    expect(names(out)).toEqual(['home']);
  });

  it('嵌套再深也一样：只选最里面那一层 → 只剩它自己', () => {
    const btn = l('btn');
    const tree = g('root', null, [ g('page', null, [ g('nav', null, [ g('box', null, [ btn ]) ]) ]) ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(names(filterTasksBySelection(tasks, tree, [btn.id]))).toEqual(['btn']);
  });

  it('选中的是中间那个组 → 从这个组算起（组名在，组以上的不在）', () => {
    const nav = g('nav', null, [ l('home'), l('icon') ]);
    const tree = g('root', null, [ g('page', null, [ nav ]) ]);
    const tasks = walk(tree, { includeHidden: false });
    // 完整切图时是 page/nav/home，这里点的是 nav，所以 page 不进名
    expect(names(filterTasksBySelection(tasks, tree, [nav.id]))).toEqual(['nav/home', 'nav/icon']);
  });

  it('深层的蓝色组被选中 → merged 任务也只剩组名自己', () => {
    const card = g('card', 'blue', [ l('bg'), l('txt') ]);
    const tree = g('root', null, [ g('page', null, [ card ]) ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(names(filterTasksBySelection(tasks, tree, [card.id]))).toEqual(['card']);
  });

  it('同时选了组和组内的一层：组更靠外，按组算（不会裁成两套）', () => {
    const home = l('home');
    const nav = g('nav', null, [ home, l('icon') ]);
    const tree = g('root', null, [ nav ]);
    const tasks = walk(tree, { includeHidden: false });
    const out = filterTasksBySelection(tasks, tree, [nav.id, home.id]);
    expect(names(out)).toEqual(['nav/home', 'nav/icon']);
  });

  it('选中蓝色组 → 保留其单个 merged 任务', () => {
    const card = g('card', 'blue', [ l('bg'), l('txt') ]);
    const tree = g('root', null, [ card, l('other') ]);
    const tasks = walk(tree, { includeHidden: false });
    const out = filterTasksBySelection(tasks, tree, [card.id]);
    expect(out).toEqual([{ type: 'merged', node: card, pathSegments: ['card'] }]);
  });

  // 合并出来的是一张图，不能因为只点中其中一层就只导一半
  it('只选中参与合并的其中一层 → 整张合并图都保留', () => {
    const top = l('top', 'blue');
    const bot = l('bot', 'blue');
    const nav = g('nav', null, [ top, bot, l('other') ]);
    const tree = g('root', null, [ nav ]);
    const tasks = walk(tree, { includeHidden: false });
    const out = filterTasksBySelection(tasks, tree, [top.id]);
    expect(names(out)).toEqual(['bot']);                // 名字仍从最下面那层来，组名不进名
    expect(out[0].members).toEqual([top, bot]);
  });

  it('选中整个组 → 组里的合并图算一张，其余各自一张', () => {
    const nav = g('nav', null, [ l('a', 'blue'), l('b', 'blue'), l('c') ]);
    const tree = g('root', null, [ nav, l('out') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(names(filterTasksBySelection(tasks, tree, [nav.id]))).toEqual(['nav/b', 'nav/c']);
  });

  it('选中红色项 → 无任务（walk 已跳过，静默为空）', () => {
    const red = g('red', 'red', [ l('x') ]);
    const tree = g('root', null, [ red, l('keep') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(filterTasksBySelection(tasks, tree, [red.id])).toEqual([]);
  });

  it('多选组+图层 → 各自命中，保持原顺序', () => {
    const a = l('a');
    const nav = g('nav', null, [ l('home'), l('icon') ]);
    const tree = g('root', null, [ a, nav, l('z') ]);
    const tasks = walk(tree, { includeHidden: false });
    const out = filterTasksBySelection(tasks, tree, [a.id, nav.id]);
    expect(names(out)).toEqual(['a', 'nav/home', 'nav/icon']);
  });

  it('空选中 → 空结果', () => {
    const tree = g('root', null, [ l('a') ]);
    const tasks = walk(tree, { includeHidden: false });
    expect(filterTasksBySelection(tasks, tree, [])).toEqual([]);
  });
});
