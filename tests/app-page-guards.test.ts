/**
 * `(app)` 下每个页面都要有会话守卫（MKACG-978）。
 *
 * 缺陷背景：`/packages`、`/packages/new`、`/packages/<id>`、`/baselines` 四页没有调用
 * `resolveWorkspaceScope()`，未登录直接 200 并渲染出全部数据。问题不是守卫写错了，而是根本
 * 没写 —— 所以这里不盯着某一页的行为，而是遍历 `app/(app)` 下全部 `page.tsx`，锁住三条：
 *
 * - 每个页面都调用现成的那一个入口（`resolveWorkspaceScope()` 或 `requirePageAuth()`）；
 * - 回跳地址写的就是这个页面自己的路由 —— 静态段写字符串，动态段用模板串拼运行时参数；
 * - 守卫排在取数之前，页面不会先查库再判断登录。
 *
 * 真的发一次未登录请求要起服务，与 `tests/page-shell-sidebar.test.ts` 同一条取舍：那一步由
 * 验收在预览环境用 curl 做，这里只锁源码这一层。加一条不带守卫的页面，这三条都会失败。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

const APP_DIR = join(process.cwd(), "app", "(app)");

/** 守卫调用：`resolveWorkspaceScope("<回跳地址>", ...)` 或 `requirePageAuth("<回跳地址>")`。 */
const GUARD_CALL = /(?:resolveWorkspaceScope|requirePageAuth)\(\s*("[^"]*"|`[^`]*`)/;

/** 取数调用：`await listPackages(...)` 这类。`await params` / `await searchParams` 不算。 */
const DATA_CALL = /await (?:list|get|load|find)[A-Z][A-Za-z]*\(/;

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      return pageFiles(full);
    }

    return entry.name === "page.tsx" ? [full] : [];
  });
}

/** `app/(app)/packages/[id]/page.tsx` → `/packages/[id]`：去掉路由分组与文件名。 */
function routeOf(file: string): string {
  const segments = relative(APP_DIR, file)
    .split(sep)
    .slice(0, -1)
    .filter((segment) => !segment.startsWith("("));

  return `/${segments.join("/")}`;
}

/** 回跳地址在这个页面里应该长什么样：静态段用字符串，`[id]` 换成模板串里的 `${id}`。 */
function expectedNextPath(route: string): string {
  if (!route.includes("[")) {
    return `"${route}"`;
  }

  return `\`${route.replace(/\[([^\]]+)\]/g, "${$1}")}\``;
}

const PAGES = pageFiles(APP_DIR).sort();

function sourceOf(file: string): string {
  return readFileSync(file, "utf8");
}

test("(app) 下的页面一个不少地被这条测试覆盖，且每个都调用了统一守卫", () => {
  // 目录本身要能被读到，否则下面的「全部通过」只是空集。
  assert.ok(PAGES.length >= 9, `只扫到 ${PAGES.length} 个页面，目录可能写错了`);

  const missing = PAGES.filter((file) => !GUARD_CALL.test(sourceOf(file))).map(routeOf);

  assert.deepEqual(missing, [], `这些页面没有会话守卫：${missing.join("、")}`);
});

test("每个页面交给守卫的回跳地址就是它自己的路由", () => {
  const wrong: string[] = [];

  for (const file of PAGES) {
    const route = routeOf(file);
    const call = sourceOf(file).match(GUARD_CALL);

    if (call === null) {
      // 没有守卫的情况由上一条测试报，这里不重复。
      continue;
    }

    if (call[1] !== expectedNextPath(route)) {
      wrong.push(`${route}：回跳地址写成了 ${call[1]}`);
    }
  }

  assert.deepEqual(wrong, []);
});

test("守卫排在取数之前，页面不会先查库再判断登录", () => {
  const wrong: string[] = [];

  for (const file of PAGES) {
    const source = sourceOf(file);
    const guard = source.match(GUARD_CALL);
    const data = source.match(DATA_CALL);

    if (guard === null || data === null) {
      continue;
    }

    if ((guard.index ?? 0) > (data.index ?? 0)) {
      wrong.push(`${routeOf(file)}：先查库再守卫`);
    }
  }

  assert.deepEqual(wrong, []);
});
