import { describe, it, expect } from 'vitest';
import { findSymbols, computeSymbolFrame } from '../src/lib/symbols.js';

let _id = 0;
const g = (name, children, label = null, visible = true) => ({ id: ++_id, name, kind: 'group', label, visible, children });
const l = (name, label = null, visible = true) => ({ id: ++_id, name, kind: 'layer', label, visible, children: [] });

describe('findSymbols', () => {
  it('组内含定位格 → 一个 symbol，范围为该组，路径为组名', () => {
    const dwg = l('定位格');
    const grp = g('icon_home', [dwg, l('bg'), l('fg')]);
    const root = g('root', [grp]);
    const syms = findSymbols(root);
    expect(syms).toHaveLength(1);
    expect(syms[0].type).toBe('symbol');
    expect(syms[0].node).toBe(grp);
    expect(syms[0].pathSegments).toEqual(['icon_home']);
    expect(syms[0].dinweigeIds).toEqual([dwg.id]);
  });

  it('定位格直接在画布根 → 范围为根，路径为空（命名退化为 项目名_PSD名）', () => {
    const dwg = l('定位格');
    const root = g('root', [dwg, l('bg'), l('fg')]);
    const syms = findSymbols(root);
    expect(syms).toHaveLength(1);
    expect(syms[0].node).toBe(root);
    expect(syms[0].pathSegments).toEqual([]);
  });

  it('名称包含「定位格」即算（如「定位格1」「定位格_底」）', () => {
    const root = g('root', [ g('a', [l('定位格1'), l('x')]), g('b', [l('底_定位格_参考'), l('y')]) ]);
    expect(findSymbols(root)).toHaveLength(2);
  });

  it('多个组各含定位格 → 多个 symbol，按 DFS 顺序', () => {
    const root = g('root', [ g('one', [l('定位格'), l('a')]), g('two', [l('定位格'), l('b')]) ]);
    const syms = findSymbols(root);
    expect(syms.map(s => s.pathSegments.join('/'))).toEqual(['one', 'two']);
  });

  it('嵌套组里的定位格 → 范围为最内层组，路径含祖先组', () => {
    const inner = g('inner', [l('定位格'), l('x')]);
    const root = g('root', [ g('outer', [inner]) ]);
    const syms = findSymbols(root);
    expect(syms).toHaveLength(1);
    expect(syms[0].node).toBe(inner);
    expect(syms[0].pathSegments).toEqual(['outer', 'inner']);
  });

  it('隐藏的定位格也要检测到（可见性忽略）', () => {
    const dwg = l('定位格', null, false);      // visible:false
    const root = g('root', [ g('grp', [dwg, l('a')]) ]);
    expect(findSymbols(root)).toHaveLength(1);
  });

  it('同一组多个定位格 → 归为一个 symbol，收集全部 id', () => {
    const d1 = l('定位格'), d2 = l('定位格_备');
    const root = g('root', [ g('grp', [d1, d2, l('a')]) ]);
    const syms = findSymbols(root);
    expect(syms).toHaveLength(1);
    expect(syms[0].dinweigeIds).toEqual([d1.id, d2.id]);
  });

  it('没有定位格 → 空', () => {
    const root = g('root', [ g('grp', [l('a'), l('b')]) ]);
    expect(findSymbols(root)).toEqual([]);
  });
});

describe('computeSymbolFrame', () => {
  const G = { left: 100, top: 100, right: 200, bottom: 200 };  // 100×100 定位格

  it('用户例子：上超20、左超15、下右不超 → E=20，四边各外扩20', () => {
    const C = { left: 85, top: 80, right: 200, bottom: 200 };  // 左超15、上超20
    expect(computeSymbolFrame(G, C)).toEqual({ left: 80, top: 80, right: 220, bottom: 220 });
  });

  it('没有超出定位格 → E=0，导出框就是定位格原尺寸', () => {
    const C = { left: 120, top: 120, right: 180, bottom: 180 };  // 完全在定位格内
    expect(computeSymbolFrame(G, C)).toEqual(G);
  });

  it('恰好贴边 → E=0', () => {
    expect(computeSymbolFrame(G, { ...G })).toEqual(G);
  });

  it('只有一边超出 → E 取该边', () => {
    const C = { left: 100, top: 100, right: 200, bottom: 235 };  // 下超35
    expect(computeSymbolFrame(G, C)).toEqual({ left: 65, top: 65, right: 235, bottom: 235 });
  });

  it('四边都超出但量不同 → E 取最大', () => {
    const C = { left: 90, top: 70, right: 205, bottom: 210 };    // 左10 上30 右5 下10 → E=30
    expect(computeSymbolFrame(G, C)).toEqual({ left: 70, top: 70, right: 230, bottom: 230 });
  });

  it('无内容(C=null) → 返回定位格原边界', () => {
    expect(computeSymbolFrame(G, null)).toEqual(G);
  });
});
