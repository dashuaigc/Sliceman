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

  it('选中单个深层图层 → 只保留该图层任务（仍带完整路径命名）', () => {
    const home = l('home');
    const nav = g('nav', null, [ home, l('icon') ]);
    const tree = g('root', null, [ nav ]);
    const tasks = walk(tree, { includeHidden: false });
    const out = filterTasksBySelection(tasks, tree, [home.id]);
    expect(names(out)).toEqual(['nav/home']);
  });

  it('选中蓝色组 → 保留其单个 merged 任务', () => {
    const card = g('card', 'blue', [ l('bg'), l('txt') ]);
    const tree = g('root', null, [ card, l('other') ]);
    const tasks = walk(tree, { includeHidden: false });
    const out = filterTasksBySelection(tasks, tree, [card.id]);
    expect(out).toEqual([{ type: 'merged', node: card, pathSegments: ['card'] }]);
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
