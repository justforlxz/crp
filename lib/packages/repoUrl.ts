/**
 * CRP 的仓库地址（`RepoUrl`）→ Gerrit 仓库路径。
 *
 * 「从 CRP 查项目」把查到的项目带回新建软件包表单（MKACG-996）。CRP 给的是**仓库地址**
 * （`ssh://gerrit.uniontech.com:29418/dde-kwin`、`https://gitlabwh.uniontech.com/wuhan/....git`），
 * 而软件包登记的 `repoPath` 是 **Gerrit 的仓库路径**（`deepin-kde/kwin`），两者不能混填：
 * `repoPath` 有自己的校验规则（不允许冒号、不允许首尾斜杠），填一个地址进去表单会被拒。
 *
 * 地址与仓库路径的关系是确定的，不是猜：Gerrit 的 SSH / HTTP 克隆地址就是
 * `协议://主机:端口/<仓库路径>`，所以「去掉协议、主机、端口与结尾的 `.git`」就是仓库路径。
 * 拿到的结果还要过一遍 `repoPath` 的校验规则，不合格就返回空串 —— 宁可留空让人自己填，
 * 也不把一段一定保存不了的值塞进表单。
 */

import { REPO_PATH_PATTERN } from "./validation";

/**
 * 从仓库地址里取出仓库路径；取不出来或不合格时返回空串。
 *
 * 支持两种写法：
 *
 * - 带协议的：`ssh://gerrit.uniontech.com:29418/dde-kwin`、`https://主机/组/仓库.git`
 * - scp 写法：`git@gerrit.uniontech.com:dde-kwin`
 */
export function repoPathFromRepoUrl(repoUrl: string): string {
  const text = repoUrl.trim();

  if (text === "") {
    return "";
  }

  const path = trimRepoPath(pathOfRepoUrl(text));

  return REPO_PATH_PATTERN.test(path) ? path : "";
}

/** 地址里的路径部分；解析不了时是空串。 */
function pathOfRepoUrl(text: string): string {
  if (text.includes("://")) {
    try {
      return new URL(text).pathname;
    } catch {
      return "";
    }
  }

  // scp 写法：`[user@]主机:路径`。主机不能带斜杠，否则不是这种写法。
  const scp = /^(?:[^:@/\s]+@)?[^:/\s]+:(.+)$/.exec(text);

  return scp?.[1] ?? "";
}

/** 去掉查询串与片段、首尾斜杠、结尾的 `.git`。 */
function trimRepoPath(path: string): string {
  return path
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}
