import { describe, it, expect } from 'vitest';
import { matchName, matchLayers, describePath } from '../src/lib/search-core.js';

// 造一棵扁平清单（面板顺序：首个=最上），字段与 layer-finder.readAllLayers() 一致
//   UI
//   ├ Btn_normal
//   ├ Btn_hover（隐藏）
//   └ icons
//     ├ icon_btn
//     └ ICON_BG
//   背景
const UI = { id: 1, name: 'UI', kind: 'group', visible: true, isBackground: false, parents: [], path: [] };
const N1 = { id: 2, name: 'Btn_normal', kind: 'layer', visible: true, isBackground: false, parents: [1], path: ['UI'] };
const N2 = { id: 3, name: 'Btn_hover', kind: 'layer', visible: false, isBackground: false, parents: [1], path: ['UI'] };
const ICONS = { id: 4, name: 'icons', kind: 'group', visible: true, isBackground: false, parents: [1], path: ['UI'] };
const N3 = { id: 5, name: 'icon_btn', kind: 'layer', visible: true, isBackground: false, parents: [1, 4], path: ['UI', 'icons'] };
const N4 = { id: 6, name: 'ICON_BG', kind: 'layer', visible: true, isBackground: false, parents: [1, 4], path: ['UI', 'icons'] };
const BG = { id: 7, name: '背景', kind: 'layer', visible: true, isBackground: true, parents: [], path: [] };
const TREE = [UI, N1, N2, ICONS, N3, N4, BG];

const ids = (rows) => rows.map((r) => r.id);

describe('matchName —— 四种匹配方式与命中区间', () => {
  it('包含：返回首次出现的位置，供界面高亮', () => {
    expect(matchName('Btn_normal', 'normal')).toEqual({ start: 4, end: 10 });
    expect(matchName('Btn_normal', 'xxx')).toBe(null);
  });
  it('完全匹配 / 前缀 / 后缀', () => {
    expect(matchName('icon', 'icon', 'exact')).toEqual({ start: 0, end: 4 });
    expect(matchName('icon_1', 'icon', 'exact')).toBe(null);
    expect(matchName('icon_1', 'icon', 'prefix')).toEqual({ start: 0, end: 4 });
    expect(matchName('1_icon', 'icon', 'prefix')).toBe(null);
    expect(matchName('1_icon', 'icon', 'suffix')).toEqual({ start: 2, end: 6 });
    expect(matchName('icon_1', 'icon', 'suffix')).toBe(null);
  });
  it('默认不区分大小写，开启后区分', () => {
    expect(matchName('ICON_BG', 'icon')).toEqual({ start: 0, end: 4 });
    expect(matchName('ICON_BG', 'icon', 'contains', true)).toBe(null);
    expect(matchName('ICON_BG', 'ICON', 'contains', true)).toEqual({ start: 0, end: 4 });
  });
  it('关键词为空 / 名称非字符串都算未命中，不抛错', () => {
    expect(matchName('icon', '')).toBe(null);
    expect(matchName(undefined, 'icon')).toBe(null);
  });
  it('命中区间始终落在原名称范围内（大小写转换后长度变化也不越界）', () => {
    const hit = matchName('İ', 'i̇', 'suffix');           // 'İ'.toLowerCase() 是两个码元
    if (hit) {
      expect(hit.start).toBeGreaterThanOrEqual(0);
      expect(hit.end).toBeLessThanOrEqual('İ'.length);
    }
  });
});

describe('matchLayers —— 条件筛选', () => {
  it('关键词为空返回空结果（不当成匹配全部）', () => {
    expect(matchLayers(TREE, { text: '' })).toEqual([]);
    expect(matchLayers(TREE, {})).toEqual([]);
  });
  it('默认：不分大小写、含隐藏层、图层与组都找、排除背景层，保持面板顺序', () => {
    expect(ids(matchLayers(TREE, { text: 'btn' }))).toEqual([2, 3, 5]);
    expect(ids(matchLayers(TREE, { text: 'icon' }))).toEqual([4, 5, 6]);
    expect(ids(matchLayers(TREE, { text: '背景' }))).toEqual([]);          // 不传开关时不出现
    const [bg] = matchLayers(TREE, { text: '背景', includeBackground: true });
    expect(bg).toMatchObject({ id: 7, isBackground: true });                // 界面就是传 true
  });
  it('区分大小写', () => {
    expect(ids(matchLayers(TREE, { text: 'ICON', caseSensitive: true }))).toEqual([6]);
  });
  it('只找图层 / 只找组', () => {
    expect(ids(matchLayers(TREE, { text: 'icon', kind: 'layer' }))).toEqual([5, 6]);
    expect(ids(matchLayers(TREE, { text: 'icon', kind: 'group' }))).toEqual([4]);
  });
  it('排除隐藏图层', () => {
    expect(ids(matchLayers(TREE, { text: 'btn', includeHidden: false }))).toEqual([2, 5]);
  });
  it('前缀 / 后缀 / 完全匹配作用到整份清单', () => {
    expect(ids(matchLayers(TREE, { text: 'btn', mode: 'prefix' }))).toEqual([2, 3]);
    expect(ids(matchLayers(TREE, { text: 'btn', mode: 'suffix' }))).toEqual([5]);
    expect(ids(matchLayers(TREE, { text: 'icons', mode: 'exact' }))).toEqual([4]);
  });
  it('范围限定：选中组只找组内后代，组自身不算命中', () => {
    expect(ids(matchLayers(TREE, { text: 'icon', scopeIds: [4] }))).toEqual([5, 6]);
    expect(ids(matchLayers(TREE, { text: 'icon', scopeIds: [1] }))).toEqual([4, 5, 6]);
    expect(ids(matchLayers(TREE, { text: 'btn', scopeIds: [4] }))).toEqual([5]);
  });
  it('范围限定：直接选中某个图层时它自己算命中', () => {
    expect(ids(matchLayers(TREE, { text: 'btn', scopeIds: [2] }))).toEqual([2]);
    expect(ids(matchLayers(TREE, { text: 'btn', scopeIds: new Set([2, 3]) }))).toEqual([2, 3]);
  });
  it('结果行带上路径与命中区间，供列表显示', () => {
    const [row] = matchLayers(TREE, { text: 'icon_btn' });
    expect(row).toMatchObject({
      id: 5, name: 'icon_btn', kind: 'layer', visible: true, locked: false, isBackground: false,
    });
    expect(row.path).toEqual(['UI', 'icons']);
    expect(row.hit).toEqual({ start: 0, end: 8 });
  });
  it('清单为空 / 元素残缺都不抛错', () => {
    expect(matchLayers(null, { text: 'a' })).toEqual([]);
    expect(matchLayers([null, { id: 9 }], { text: 'a' })).toEqual([]);
  });
});

describe('describePath', () => {
  it('祖先名称用 / 连接，顶层为空串', () => {
    expect(describePath(['UI', 'icons'])).toBe('UI / icons');
    expect(describePath([])).toBe('');
    expect(describePath(undefined)).toBe('');
  });
});
