// guard 硬规则黑名单的单元测试。
// 只测第 1 层(纯函数 checkHardBlock),不碰 Kev/HTTP——这是它「可测」的原因:
// 危险命令的判断被抽成了纯函数,逻辑和副作用(网络)分离。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkHardBlock } from "../src/guard.js";

describe("guard 硬规则黑名单", () => {
  it("破坏性命令命中拦截", () => {
    assert.ok(checkHardBlock("rm -rf / --no-preserve-root"));
    assert.ok(checkHardBlock("del /s /q C:\\Windows\\System32\\*"));
    assert.ok(checkHardBlock("format C:"));
    assert.ok(checkHardBlock("shutdown /s /t 0"));
    assert.ok(checkHardBlock("rmdir /s /q C:\\important"));
    assert.ok(checkHardBlock("mkfs.ext4 /dev/sda1"));
  });

  it("安全命令不命中(放行)", () => {
    assert.equal(checkHardBlock("dir"), null);
    assert.equal(checkHardBlock("echo hello"), null);
    assert.equal(checkHardBlock("type README.md"), null);
    assert.equal(checkHardBlock("node --version"), null);
    assert.equal(checkHardBlock("cd /c/Users"), null);
  });
});
