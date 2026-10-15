import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bindCustomButton, setButtonDisabled } from '../src/lib/custom-button.js';

function button() {
  const el = new EventTarget();
  const attrs = new Map();
  const classes = new Set();
  el.setAttribute = (k, v) => attrs.set(k, String(v));
  el.getAttribute = (k) => attrs.get(k) ?? null;
  el.classList = { contains: (c) => classes.has(c), add: (c) => classes.add(c) };
  bindCustomButton(el);
  return el;
}
function key(el, type, value, repeat = false) {
  const ev = new Event(type, { cancelable: true });
  Object.assign(ev, { key: value, repeat });
  el.dispatchEvent(ev);
  return ev;
}

describe('custom buttons', () => {
  it('removes native button controls from the panel', () => {
    const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/<button\b/i);
    expect(html).toMatch(/role="button" tabindex="0"/);
  });
  it('activates once for Enter and on Space release, preventing scroll', () => {
    const el = button();
    const click = vi.fn();
    el.addEventListener('click', click);
    key(el, 'keydown', 'Enter');
    key(el, 'keydown', 'Enter', true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(key(el, 'keydown', ' ').defaultPrevented).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    key(el, 'keyup', ' ');
    expect(click).toHaveBeenCalledTimes(2);
  });
  it('blocks mouse and keyboard activation when disabled, then restores it', () => {
    const el = button();
    const click = vi.fn();
    el.addEventListener('click', click);
    setButtonDisabled(el, true);
    el.dispatchEvent(new Event('click', { cancelable: true }));
    key(el, 'keydown', 'Enter');
    expect(click).not.toHaveBeenCalled();
    expect(el.getAttribute('aria-disabled')).toBe('true');
    setButtonDisabled(el, false);
    key(el, 'keydown', 'Enter');
    expect(click).toHaveBeenCalledTimes(1);
    el.classList.add('btn-off');
    el.dispatchEvent(new Event('click'));
    key(el, 'keydown', 'Enter');
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('cancels a pending Space activation when focus leaves', () => {
    const el = button();
    const click = vi.fn();
    el.addEventListener('click', click);
    key(el, 'keydown', ' ');
    el.dispatchEvent(new Event('blur'));
    key(el, 'keyup', ' ');
    expect(click).not.toHaveBeenCalled();
  });
});
