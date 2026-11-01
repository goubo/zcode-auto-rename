import test from "node:test";
import assert from "node:assert/strict";
import { resolveSessionModel } from "../worker.mjs";

test("off（默认）时不跟随会话模型", () => {
  assert.equal(resolveSessionModel({ model: "magpie/zcode/GLM-5.3-Flash-Trial" }, {}), null);
  assert.equal(resolveSessionModel({ model: "magpie/zcode/GLM-5.3-Flash-Trial" }, { followSessionModel: "off" }), null);
});

test("on 且会话模型带 magpie/ 前缀 → 去掉一级 provider 前缀", () => {
  assert.equal(
    resolveSessionModel({ model: "magpie/zcode/GLM-5.3-Flash-Trial" }, { followSessionModel: "on" }),
    "zcode/GLM-5.3-Flash-Trial",
  );
  assert.equal(
    resolveSessionModel({ model: "magpie/zcode/GLM-5.3" }, { followSessionModel: true }),
    "zcode/GLM-5.3",
  );
});

test("on 但会话为原生账号直连（非网关形态）→ 回落 null", () => {
  assert.equal(
    resolveSessionModel({ model: "account:bigmodel-start-plan/GLM-5.3-Flash" }, { followSessionModel: "on" }),
    null,
  );
});

test("无 taskRow 或无 model 字段 → 回落 null", () => {
  assert.equal(resolveSessionModel(null, { followSessionModel: "on" }), null);
  assert.equal(resolveSessionModel({}, { followSessionModel: "on" }), null);
});
