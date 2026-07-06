import { describe, it, expect } from 'vitest';
import { walk } from '../src/lib/traversal.js';

const g = (name, label, children, visible = true) => ({ name, kind: 'group', label, visible, children });
const l = (name, label = null, visible = true) => ({ name, kind: 'layer', label, visible, children: [] });

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
