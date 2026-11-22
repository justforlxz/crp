"use client";

/**
 * 「取消提测」的二次确认（MKACG-954）。
 *
 * 取消不可撤销，而且会真的删掉 CRP 上的 Release，所以不让人一点就发：先点按钮，展开确认框，
 * 把**要删的是什么**写清楚，再点一次才提交。
 *
 * 确认框里必须出现 Topic ID、主题名、将删除的 Release 条数，以及「不可撤销」。
 * 还要写明它与「放弃提测主题」的区别：那个动作一条 Release 都不删，这个会逐个删。
 * 这是两个动作唯一的差别，也是用户预判后果的依据，不能糊。
 *
 * 为什么用客户端组件而不是直接放表单：二次确认要一次点击才展开，这需要一点状态；
 * 这里是页面里唯一需要状态的地方，不引入别的机制。
 *
 * 只有「能不能取消」由页面判定，这个组件不重复判断：页面在不能取消时根本不会渲染它。
 */

import { useState } from "react";

export function CancelReleaseForm({
  releaseId,
  topicId,
  topicName,
  releaseCount,
  action,
}: {
  releaseId: string;
  /** CRP 上的 Topic ID；还没投递过时为 `null`。 */
  topicId: string | null;
  /** CRP 上的主题名；读不到时传本地记录的提测版本。 */
  topicName: string;
  /** 这条提测当前轮里已有 CRP Release 的包数，也就是会被逐个删掉的 Release 条数。 */
  releaseCount: number;
  /** 服务端动作：提交后由它复检并调 CRP。 */
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
        取消提测
      </button>
    );
  }

  return (
    <div className="alert alert--warn" role="alert">
      <p>
        确认取消 Topic <code>{topicId ?? "（尚未建）"}</code>「{topicName}」？
      </p>
      <ul>
        <li>Topic ID：{topicId === null ? "还没有建 Topic（尚未投递）" : <code>{topicId}</code>}</li>
        <li>主题名：{topicName}</li>
        <li>
          将删除的 Release：{releaseCount} 条 —— 会逐个删除这 {releaseCount} 条 Release 并放弃 Topic。
        </li>
        <li>不可撤销。</li>
        <li>与「放弃提测主题」不同：本操作会删掉 CRP 上的 Release，放弃主题一条都不会删。</li>
      </ul>
      <form action={action}>
        <input type="hidden" name="releaseId" value={releaseId} />
        <button type="submit" className="btn btn-danger">
          确认取消提测
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
