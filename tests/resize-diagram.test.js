import { describe, it, expect } from 'vitest';
import { resizeDiagram } from '../src/lib/resize-diagram.js';

describe('resize explanation selection', () => {
  it('distinguishes all four fixed-box results and only offers meaningful anchors', () => {
    const states = ['contain', 'cover', 'stretch', 'scale'].map(f => resizeDiagram('wh', f));
    expect(new Set(states.map(s => s.asset)).size).toBe(4);
    expect(states.map(s => s.anchor)).toEqual([true, true, false, false]);
    expect(states[3].caption).toContain('不补边');
  });
  it('explains each other rule independently of a previously selected fit', () => {
    const rules = ['w', 'h', 'long', 'short', 'percent', 'times', 'max'];
    expect(new Set(rules.map(m => resizeDiagram(m).asset)).size).toBe(7);
    for (const mode of rules) {
      for (const fit of ['contain', 'cover', 'stretch', 'scale']) {
        const state = resizeDiagram(mode, fit);
        expect(state).toEqual(resizeDiagram(mode));
        expect(state.anchor).toBe(false);
        expect(state.caption.length).toBeGreaterThan(0);
      }
    }
    expect(resizeDiagram('max').caption).toContain('不放大');
  });
});
