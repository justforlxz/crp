"use client";

/**
 * 「放弃提测主题」的二次确认（MKACG-950）。
 *
 * 放弃主题不可撤销，所以不让人一点就发：先点按钮，展开一个确认框，把**要放弃的是什么**
 * 写清楚，再点一次才真的提交。确认框里必须出现 Topic ID、主题名、影响包数、
 * CRP 上是否已有 Release，以及「不可撤销」「本操作不删除 CRP 上的 Release」两句后果说明。
 *
 * 为什么用客户端组件而不是直接放表单：二次确认要一次点击才展开，这需要一点状态；
 * 这里是页面里唯一需要状态的地方，不引入别的机制。
 *
 * 只有「能不能放弃」由页面判定，这个组件不重复判断：页面在不能放弃时根本不会渲染它。
 * 按钮用红色描边（`.btn-danger-outline`），与日常动作区分；确认框用警示底色，不是红色实心块。
 */

import { useState } from "react";

export function AbandonTopicForm({
  releaseId,
  topicId,
  topicName,
  packageCount,
  hasCrpReleases,
  action,
}: {
  releaseId: string;
  topicId: string;
  /** CRP 上的主题名；读不到时传本地记录的提测版本。 */
  topicName: string;
  /** 这条提测里当前轮的软件包数，确认框里要写「影响包数」。 */
  packageCount: number;
  /** CRP 上这条主题里是否已经有 Release；确认框要写明，避免以为会清空产物。 */
  hasCrpReleases: boolean;
  /** 服务端动作：提交后由它调 CRP 并回写本地状态。 */
  action: (formData: FormData) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-danger-outline"
        onClick={() => setConfirming(true)}
      >
        放弃提测主题
      </button>
    );
  }

  return (
    <div className="alert alert--warn" role="alert">
      <p>
        确认放弃 Topic <code>{topicId}</code>「{topicName}」？
      </p>
      <ul>
        <li>Topic ID：<code>{topicId}</code></li>
        <li>主题名：{topicName}</li>
        <li>影响包数：{packageCount} 个（只影响本地这条提测的状态，不改任何包的仓库内容）</li>
        <li>CRP 上是否已有 Release：{hasCrpReleases ? "有" : "没有"}</li>
        <li>不可撤销。</li>
        <li>本操作不删除 CRP 上的 Release，只把主题标记为已放弃。</li>
      </ul>
      <form action={action}>
        <input type="hidden" name="releaseId" value={releaseId} />
        <button type="submit" className="btn btn-danger">
          确认放弃提测主题
        </button>
      </form>
      <p>
        <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
          取消
        </button>
      </p>
    </div>
  );
}
