/**
 * 构建队列页：谁在等谁、卡在哪个上游、这一轮调度做了什么。
 *
 * 只读页面：数据全部由服务端的定时轮询写进库里，页面不自己调 CRP / Shuttle，
 * 也不用前端轮询去驱动状态写入（MUST NOT）。「立即轮询」按钮调
 * `app/(app)/queue/actions.ts` 里的服务端动作，与定时入口共用同一个 `runBuildPoll()`。
 *
 * 四张统计卡的数字与下面的任务列表出自同一次查询，不会出现「卡上 3 个、列表里 5 个」。
 *
 * 顶部那行「工作区：A（当前） B」是这一页的工作区切换器。它和 `/dashboard`、`/managers`、
 * `/projects`、`/releases`、`/webhooks` 用同一个 `showsWorkspaceSwitcher()` 判定：账号只属于
 * 一个工作区时整行不渲染，页面上不出现工作区名（MKACG-1017「必须做到」第 3 条）。
 * `data-style-anchor` 留在条件里面：样式门禁用的是平台管理员账号（三个工作区），那一档照旧渲染。
 *
 * 正文块在 `./board.tsx`：结构照 `.agents/spec/design/prototype.html` 的构建队列页
 * （`.stats` → `.dep-flow` → `.queue-list` → `.tip` → `table.grid`），那边不连库，
 * 测试可以直接把 `QueueBoard` 渲染成 HTML 核对模块与结构。依赖顺序取
 * `lib/build/queue.ts` 里 `sortByDependencies` 算出的拓扑序，与投递层同一份实现；
 * 进度用真实比例（已完成架构 / 全部架构），不照抄原型里硬编码的 68%。
 */
import type { Metadata } from "next";
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { loadBuildQueue } from "@/lib/build";

import { resolveWorkspaceScope, showsWorkspaceSwitcher } from "../workspaceScope";
import { refreshQueueAction } from "./actions";
import { QueueBoard } from "./board";

export const metadata: Metadata = { title: "构建队列 · CRP 提测平台" };

// 数据每次轮询都在变，页面不做静态化。
export const dynamic = "force-dynamic";

type QueuePageProps = {
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

export default async function QueuePage({ searchParams }: QueuePageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/queue", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="构建队列">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  const view = await loadBuildQueue(scope.active.id);

  return (
    <PageShell
      title="构建队列"
      actions={
        <form
          action={refreshQueueAction.bind(null, scope.active.slug)}
          data-style-anchor="queue.refresh"
        >
          <button type="submit" className="btn btn-primary">
            立即轮询
          </button>
        </form>
      }
    >
      <Toast
        className="toast alert alert--error"
        role="alert"
        message={query.error === undefined ? null : `操作失败：${query.error}`}
      />
      <Toast
        className="toast alert alert--info"
        message={query.notice === undefined ? null : query.notice}
      />

      {showsWorkspaceSwitcher(scope.workspaces) ? (
        <p className="hint" data-style-anchor="queue.workspace-switcher">
          工作区：
          {scope.workspaces.map((workspace) => (
            <span key={workspace.id}>
              <Link href={`/queue?workspace=${encodeURIComponent(workspace.slug)}`}>
                {workspace.name}
              </Link>
              {workspace.id === scope.active?.id ? "（当前）" : null}{" "}
            </span>
          ))}
        </p>
      ) : null}

      <QueueBoard view={view} workspaceSlug={scope.active.slug} />
    </PageShell>
  );
}
