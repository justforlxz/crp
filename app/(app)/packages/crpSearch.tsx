"use client";

/**
 * 软件包页的「从 CRP 查项目」（MKACG-996）。
 *
 * 为什么是客户端组件：CRP 查询要按输入即时出结果（300 毫秒防抖），服务端表单得点一次按钮。
 * 这里只负责「什么时候发请求、怎么显示」，查什么、怎么排序、错误怎么翻译全在
 * `lib/packages/crpSearch.ts` 与 `GET /api/crp/projects` 里，不在浏览器里再算一遍。
 *
 * 三条与接口约定对齐的行为：
 *
 * - 空输入不发请求（接口也会 400，两边各挡一次）；
 * - 限流只显示剩余秒数，不自动重发 —— 重发只会把限流窗口拖得更长；
 * - 结果里那三列带去新建软件包表单，不在这里写库。
 *
 * 用的是原型已有的模块（`.panel` / `.panel-hd` / `.panel-bd` / `.search` / `table-scroll` /
 * `grid` / `dot` / `empty` / `.btn`），没有新增类名。
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { repoPathFromRepoUrl } from "@/lib/packages/repoUrl";

/** 输入停下多久才发请求。CRP 是外部系统，每敲一个字打一次既慢又容易触发限流。 */
const DEBOUNCE_MS = 300;

/** 一次要多少条：CRP 的上限就是 100，多了也拿不到。 */
const RESULT_LIMIT = 100;

type SearchItem = {
  crpProjectName: string;
  packageName: string;
  repoUrl: string;
  exact: boolean;
};

type SearchResult = {
  items: SearchItem[];
  truncated: boolean;
  query: string;
};

type Failure = { message: string };

/**
 * 新建软件包表单的链接。
 *
 * 「仓库路径」填的是从仓库地址里取出来的 Gerrit 仓库路径，不是地址本身：表单那一列只
 * 接受 `deepin-kde/kwin` 这种写法，塞一个 `ssh://…` 进去保存会被拒（见 `repoUrl.ts`）。
 * 「deb 包名」在 CRP 里可能是空串，此时留空让人自己填 —— 凭空造一个包名比留空更糟。
 */
function registerHref(item: SearchItem): string {
  const params = new URLSearchParams();

  if (item.packageName !== "") {
    params.set("name", item.packageName);
  }

  params.set("crpProjectName", item.crpProjectName);

  const repoPath = repoPathFromRepoUrl(item.repoUrl);

  if (repoPath !== "") {
    params.set("repoPath", repoPath);
  }

  return `/packages/new?${params.toString()}`;
}

/** 从错误响应里取一句能给人看的话。取不到就用兜底那句话，不显示 CRP 原文。 */
function readFailure(body: unknown): Failure {
  const error = (body as { error?: { message?: unknown } } | null)?.error;

  return {
    message:
      typeof error?.message === "string" && error.message !== ""
        ? error.message
        : "查询 CRP 失败，请稍后再试。",
  };
}

export function CrpProjectSearch() {
  const [keyword, setKeyword] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const query = keyword.trim();

  useEffect(() => {
    // 空输入不发请求。清空上一个结果的动作放在 onChange 里，不在 effect 里同步改状态
    // （那会触发一轮没必要的重渲染）。
    if (query === "") {
      return;
    }

    const controller = new AbortController();

    const timer = setTimeout(() => {
      setPending(true);
      void (async () => {
        try {
          const response = await fetch(
            `/api/crp/projects?q=${encodeURIComponent(query)}&limit=${RESULT_LIMIT}`,
            { signal: controller.signal },
          );
          const body: unknown = await response.json();

          if (!response.ok) {
            setFailure(readFailure(body));
            setResult(null);

            return;
          }

          setFailure(null);
          setResult(body as SearchResult);
        } catch {
          // 中途换了关键词会 abort 掉上一个请求，那不是错误，不要报给用户。
          if (controller.signal.aborted) {
            return;
          }

          setFailure({ message: "查询 CRP 失败，请稍后再试。" });
          setResult(null);
        } finally {
          if (!controller.signal.aborted) {
            setPending(false);
          }
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const items = result?.items ?? [];

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>从 CRP 查项目</h2>
        <span className="hint">查到就在这儿登记，不写进平台</span>
      </div>

      <div className="panel-bd">
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="从 CRP 查项目"
            placeholder="输入 CRP 项目名或包名，例如 kwin"
            autoComplete="off"
            value={keyword}
            onChange={(event) => {
              const next = event.target.value;

              setKeyword(next);

              // 清空输入就当没查过：旧结果留在页面上会让人以为它属于新关键词。
              if (next.trim() === "") {
                setResult(null);
                setFailure(null);
                setPending(false);
              }
            }}
          />
        </label>

        {failure !== null ? (
          <p className="muted" role="status">
            {failure.message}
          </p>
        ) : result === null ? (
          <p className="muted">输入关键词后自动查询，不用点按钮。</p>
        ) : items.length === 0 ? (
          <div className="empty">
            <div className="empty-ico" aria-hidden="true">
              ◇
            </div>
            <div className="empty-t">CRP 里没有匹配的项目，换个关键词试试</div>
          </div>
        ) : (
          <>
            <p className="result-n num">
              {pending ? "正在查 CRP…" : `CRP 里匹配「${result.query}」的项目，共 ${items.length} 条`}
            </p>

            <div className="table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>CRP 项目名</th>
                    <th>deb 包名</th>
                    <th>仓库</th>
                    <th>匹配</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={`${item.crpProjectName}\u0000${item.repoUrl}`}>
                      <td>
                        <strong>{item.crpProjectName}</strong>
                      </td>
                      <td className="col-mono">{item.packageName === "" ? "—" : item.packageName}</td>
                      <td className="col-mono">{item.repoUrl === "" ? "—" : item.repoUrl}</td>
                      <td>
                        <span className={item.exact ? "dot is-ok" : "dot is-wait"}>
                          {item.exact ? "完全匹配" : "相近"}
                        </span>
                      </td>
                      <td className="num">
                        <Link className="btn btn-sm" href={registerHref(item)}>
                          登记为软件包
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {result.truncated ? (
              <p className="muted">
                CRP 一次最多返回 {RESULT_LIMIT} 条，还有更多没列出，换个更具体的关键词。
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
