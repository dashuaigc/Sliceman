import { describe, it, expect } from 'vitest';
import { normalizeNumText, evalExpr, formatNum, stepValue } from '../src/lib/num-field.js';

describe('归一（中文输入法是常客）', () => {
  it('全角数字转半角', () => {
    expect(normalizeNumText('１０２４')).toBe('1024');
  });

  it('× ÷ 和全角运算符 / 括号都认', () => {
    expect(normalizeNumText('２×３')).toBe('2*3');
    expect(normalizeNumText('１０÷２')).toBe('10/2');
    expect(normalizeNumText('（１＋２）＊３')).toBe('(1+2)*3');
    expect(normalizeNumText('１－２')).toBe('1-2');
  });

  it('空格与千分位逗号直接丢掉；中文句号当小数点', () => {
    expect(normalizeNumText(' 1 000 ')).toBe('1000');
    expect(normalizeNumText('1,920')).toBe('1920');
    expect(normalizeNumText('1。5')).toBe('1.5');
  });

  it('不把 x / X 当乘号：1920x1080 那种写法会算出个荒唐的数', () => {
    expect(normalizeNumText('1920x1080')).toBe('1920x1080');
    expect(evalExpr('1920x1080')).toBeNull();
  });
});

describe('算式求值', () => {
  it('纯数字返回它自己（调用方不用先判断是不是算式）', () => {
    expect(evalExpr('1000')).toBe(1000);
    expect(evalExpr('12.5')).toBe(12.5);
    expect(evalExpr('.5')).toBe(0.5);
    expect(evalExpr('-20')).toBe(-20);
    expect(evalExpr('+8')).toBe(8);
  });

  it('四则运算', () => {
    expect(evalExpr('1000+200')).toBe(1200);
    expect(evalExpr('1000-200')).toBe(800);
    expect(evalExpr('120*3')).toBe(360);
    expect(evalExpr('1000/4')).toBe(250);
  });

  it('先乘除后加减', () => {
    expect(evalExpr('2+3*4')).toBe(14);
    expect(evalExpr('100-20/4')).toBe(95);
  });

  it('括号改变优先级，可以嵌套', () => {
    expect(evalExpr('(2+3)*4')).toBe(20);
    expect(evalExpr('((1+2)*(3+4))')).toBe(21);
  });

  it('一元正负号，含连写', () => {
    expect(evalExpr('10*-2')).toBe(-20);
    expect(evalExpr('10--2')).toBe(12);
    expect(evalExpr('-(3+4)')).toBe(-7);
  });

  it('除以 0 判为非法，不产出 Infinity', () => {
    expect(evalExpr('10/0')).toBeNull();
    expect(evalExpr('0/0')).toBeNull();
    expect(evalExpr('10/(5-5)')).toBeNull();
  });

  it('写法不合法一律 null —— 由调用方原样保留用户输入', () => {
    for (const bad of ['', '   ', 'abc', '1+', '+', '*3', '(1+2', '1+2)', '1..2', '#999999']) {
      expect(evalExpr(bad)).toBeNull();
    }
  });

  it('空格一律当不存在 —— 代价是 "1 2" 会被读成 12', () => {
    // 去空格是为了让「1 000」这种手输的千分位能用；
    // 同一条规则下 "1 2" 只能读成 12，这是有意接受的取舍，不是漏判
    expect(evalExpr('1 000')).toBe(1000);
    expect(evalExpr('1 2')).toBe(12);
    expect(evalExpr('1000 + 200')).toBe(1200);
  });

  it('不给任何机会执行代码', () => {
    for (const bad of ['1;alert(1)', 'process.exit()', '1**2', '1e3', '0x10', '[1][0]']) {
      expect(evalExpr(bad)).toBeNull();
    }
  });

  it('全角算式照样算得出来', () => {
    expect(evalExpr('１０００＋２００')).toBe(1200);
    expect(evalExpr('（２＋３）×４')).toBe(20);
  });
});

describe('格式化', () => {
  it('取整', () => {
    expect(formatNum(1200, 0)).toBe('1200');
    expect(formatNum(333.333, 0)).toBe('333');
    expect(formatNum(333.5, 0)).toBe('334');
  });

  it('整数不会被误裁（曾经把 100 削成 1 的坑）', () => {
    expect(formatNum(100, 0)).toBe('100');
    expect(formatNum(1000, 0)).toBe('1000');
    expect(formatNum(10, 1)).toBe('10');
  });

  it('保留小数时去掉末尾的 0 和光秃秃的小数点', () => {
    expect(formatNum(100.0, 1)).toBe('100');
    expect(formatNum(10.5, 1)).toBe('10.5');
    expect(formatNum(10.55, 1)).toBe('10.6');
    expect(formatNum(10.5, 2)).toBe('10.5');
  });

  it('-0 显示成 0', () => {
    expect(formatNum(-0.2, 0)).toBe('0');
  });

  it('非有限数返回空串', () => {
    expect(formatNum(NaN, 0)).toBe('');
    expect(formatNum(Infinity, 0)).toBe('');
  });
});

describe('↑/↓ 步进', () => {
  it('默认 ±1，Shift ±10', () => {
    expect(stepValue(100, true, false)).toBe(101);
    expect(stepValue(100, false, false)).toBe(99);
    expect(stepValue(100, true, true)).toBe(110);
    expect(stepValue(100, false, true)).toBe(90);
  });

  it('可以自定步长', () => {
    expect(stepValue(1, true, false, 0.5, 5)).toBe(1.5);
    expect(stepValue(1, true, true, 0.5, 5)).toBe(6);
  });

  it('减到负数是允许的：平移页靠负数翻方向，夹在 0 的活由调用方做', () => {
    expect(stepValue(0, false, false)).toBe(-1);
  });

  it('当前值读不出来时按 0 起步', () => {
    expect(stepValue(NaN, true, false)).toBe(1);
    expect(stepValue(null, true, false)).toBe(1);
  });
});

describe('串起来用：算式 → 取整 → 写回输入框', () => {
  const resolve = (raw, decimals = 0) => {
    const n = evalExpr(raw);
    return n === null ? null : formatNum(n, decimals);
  };

  it('宽度框里敲 1000+200 得到 1200', () => {
    expect(resolve('1000+200')).toBe('1200');
  });

  it('要整数的框上 1000/3 收敛成 333，不留半像素', () => {
    expect(resolve('1000/3')).toBe('333');
  });

  it('算不出来就返回 null，输入框原样不动', () => {
    expect(resolve('1000+')).toBeNull();
  });
});
