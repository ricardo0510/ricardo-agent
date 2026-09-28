// calculate 递归下降求值器的单元测试。
// 纯函数、零依赖,测边界情况:优先级、括号、负数、小数、非法输入。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculate } from "../src/tools.js";

describe("calculate 递归下降求值器", () => {
  it("四则运算 + 优先级", () => {
    assert.equal(calculate("(48+52)*3"), 300);
    assert.equal(calculate("100/4"), 25);
    assert.equal(calculate("2+3*4"), 14); // 乘法优先于加法
    assert.equal(calculate("(2+3)*4"), 20); // 括号改变优先级
  });

  it("负数和小数", () => {
    assert.equal(calculate("-5+3"), -2);
    assert.equal(calculate("7/2"), 3.5);
    assert.equal(calculate("1.5+2.5"), 4);
  });

  it("嵌套括号", () => {
    assert.equal(calculate("((1+2)*(3+4))"), 21);
    assert.equal(calculate("10-(2+3)"), 5);
  });

  it("非法输入抛错(而不是返回错误值)", () => {
    assert.throws(() => calculate("abc")); // 非数字
    assert.throws(() => calculate("1+2)")); // 括号不匹配
    assert.throws(() => calculate("")); // 空表达式
    assert.throws(() => calculate("2**3")); // 不支持的运算符
  });
});
