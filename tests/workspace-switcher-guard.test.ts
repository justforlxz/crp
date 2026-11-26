/**
 * 工作区名只能出现在切换器里，切换器只能过 `showsWorkspaceSwitcher()`（MKACG-1017）。
 *
 * 为什么必须有一条源码级断言：样式门禁抓不到这一类漏。门禁用的是平台管理员账号
 * （`scripts/style-check/index.ts`），而 `listWorkspacesForAccount()` 对平台管理员返回全部
 * 工作区，`showsWorkspaceSwitcher()` 永远为真 —— 切换器在门禁里永远渲染，单工作区那一档
 * 它一次都量不到。`/queue` 就是在六条 AC 全过、评审与功能检测都通过的情况下漏出来的。
 *
 * 判据分两层：
 *
 * 1. **已知的切换器位置**：每一处都必须在守卫之后（服务端页面直接调
 *    `showsWorkspaceSwitcher()`；客户端组件收页面算好的 `showWorkspace` 布尔）。
 * 2. **发现层**：`app/(app)/` 下任何源码里出现工作区切换器的标记（工作区下拉的
 *    `aria-label`、`*.workspace-switcher` 锚点、`<WorkspaceSwitcher`），都必须在上面那张
 *    表里 —— 新加一处切换器却忘了过守卫，这条会直接失败。
 *
 * 这不是 JSX 解析器：只按「标记必须出现在守卫之后」的文本顺序判断，够挡住删守卫与把标记
 * 挪出条件这两种改法。真正的渲染行为由浏览器验收覆盖。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = process.cwd();

type Site = {
  /** 仓库内相对路径。 */
  path: string;
  /** 守卫的写法。 */
  guard: RegExp;
  /** 工作区名的渲染标记；必须出现在守卫之后。 */
  marker: string;
  /** 为什么这一处这样写。 */
  note: string;
};

/**
 * 已知的工作区切换器位置。
 *
 * 服务端页面自己判定、条件渲染的（第 1 组）；页面判定后把布尔交给客户端组件的（第 2 组）。
 * 两组的差别只在 `showWorkspace` 是常量还是 prop，判定的来源都是同一个
 * `showsWorkspaceSwitcher()`。
 */
const SITES: readonly Site[] = [
  {
    path: "app/(app)/managers/page.tsx",
    guard: /showsWorkspaceSwitcher\(scope\.workspaces\)\s*\?/u,
    marker: 'aria-label="工作区"',
    note: "项目经理清单表上方的筛选条",
  },
  {
    path: "app/(app)/webhooks/page.tsx",
    guard: /showsWorkspaceSwitcher\(scope\.workspaces\)\s*\?/u,
    marker: 'aria-label="工作区"',
    note: "端点列表上方的筛选条",
  },
  {
    path: "app/(app)/queue/page.tsx",
    guard: /showsWorkspaceSwitcher\(scope\.workspaces\)\s*\?/u,
    marker: 'data-style-anchor="queue.workspace-switcher"',
    note: "顶部那行「工作区：A（当前） B」，不是下拉但一样写工作区名",
  },
  {
    path: "app/(app)/dashboard/page.tsx",
    guard: /showsWorkspaceSwitcher\(workspaces\)\s*\?/u,
    marker: "<WorkspaceSwitcher",
    note: "工作台顶部的切换器由客户端组件 `controls.tsx` 渲染，这里只负责挂载",
  },
  {
    path: "app/(app)/projects/page.tsx",
    guard: /const showWorkspace = showsWorkspaceSwitcher\(scope\.workspaces\)/u,
    marker: "showWorkspace={showWorkspace}",
    note: "页面算出布尔，交给客户端组件",
  },
  {
    path: "app/(app)/projects/projectsView.tsx",
    guard: /\{showWorkspace \?/u,
    marker: 'aria-label="工作区"',
    note: "项目页筛选条（客户端组件）",
  },
  {
    path: "app/(app)/releases/page.tsx",
    guard: /const showWorkspace = showsWorkspaceSwitcher\(scope\.workspaces\)/u,
    marker: "showWorkspace={showWorkspace}",
    note: "页面算出布尔，交给客户端组件",
  },
  {
    path: "app/(app)/releases/filters.tsx",
    guard: /\{showWorkspace \?/u,
    marker: 'aria-label="工作区"',
    note: "提测记录页筛选条（客户端组件）",
  },
];

/**
 * 只声明、不调用切换器的组件：`WorkspaceSwitcher` 的定义在这里，唯一调用点是
 * `app/(app)/dashboard/page.tsx`，那里已经过守卫（上面那张表里的 dashboard 一条）。
 */
const DEFINITIONS_ONLY = new Set(["app/(app)/dashboard/controls.tsx"]);

/** 发现层用的标记：出现任意一个就说明这份源码在渲染工作区切换器。 */
const SWITCHER_MARKERS = ['aria-label="工作区"', "workspace-switcher", "<WorkspaceSwitcher"];

function sourceOf(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** 递归列出目录下的 `.tsx`，跳过测试文件。 */
function walkTsx(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...walkTsx(full));
      continue;
    }

    if (!entry.name.endsWith(".tsx") || /\.test\.tsx$/u.test(entry.name)) {
      continue;
    }

    found.push(full);
  }

  return found;
}

test("每一处工作区切换器都在 showsWorkspaceSwitcher 之后", () => {
  for (const site of SITES) {
    const source = sourceOf(site.path);
    const guard = source.search(site.guard);
    const marker = source.indexOf(site.marker);

    assert.ok(guard >= 0, `${site.path}（${site.note}）缺守卫：${String(site.guard)}`);
    assert.ok(marker >= 0, `${site.path}（${site.note}）里找不到标记 ${site.marker}`);
    assert.ok(
      marker > guard,
      `${site.path}（${site.note}）的 ${site.marker} 不在守卫之后：工作区名会在单工作区时写进页面`,
    );
  }
});

test("app/(app) 下没有绕过守卫的切换器", () => {
  const known = new Set(SITES.map((site) => site.path));
  const stray: string[] = [];

  for (const file of walkTsx(join(ROOT, "app", "(app)"))) {
    const path = relative(ROOT, file);

    if (known.has(path) || DEFINITIONS_ONLY.has(path)) {
      continue;
    }

    const source = readFileSync(file, "utf8");
    const marker = SWITCHER_MARKERS.find((candidate) => source.includes(candidate));

    if (marker !== undefined) {
      stray.push(`${path}（${marker}）`);
    }
  }

  assert.deepEqual(
    stray,
    [],
    `这些文件在渲染工作区切换器，却没登记到 SITES，也就没有过 showsWorkspaceSwitcher：\n${stray.join("\n")}`,
  );
});

test("列出的每一处都真的存在，表不会过期", () => {
  for (const site of SITES) {
    assert.doesNotThrow(() => statSync(join(ROOT, site.path)), `${site.path} 已不存在，请更新 SITES`);
  }
});
