/**
 * 根路径入口的约定：`/` 不是页面，而是一条指向工作台的重定向。
 *
 * 只断言配置里的重定向表，不启动服务：`/dashboard` 未登录时跳登录页那套守卫不归这里管，
 * 这次改动也不碰它。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import nextConfig from "../next.config";

test("根路径重定向到工作台，且用临时重定向", async () => {
  const redirects = (await nextConfig.redirects?.()) ?? [];

  assert.deepEqual(redirects, [
    { source: "/", destination: "/dashboard", permanent: false },
  ]);
});

test("根路径不再有页面组件，占位页不会回来", () => {
  assert.equal(existsSync(join(process.cwd(), "app", "page.tsx")), false);
});
