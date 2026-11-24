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
 * 确认框用原型的 `.modal` 结构（MKACG-972）：外层 + 头部 + 主体 + 底部操作区。
 * 点遮罩、点右上角 ×、按 Esc、点「取消」都收起确认框，行为与改版前一致。
 *
 * 只有「能不能放弃」由页面判定，这个组件不重复判断：页面在不能放弃时根本不会渲染它。
 * 按钮用红色描边（`.btn-danger`，v2 样式表里唯一的危险动作样式），与日常动作区分；
 * 确认框的正文写清后果，不是红色实心块。
 */

import { useState } from "react";

import { Modal } from "@/components/modal";

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
        className="btn btn-danger"
        onClick={() => setConfirming(true)}
      >
        放弃提测主题
      </button>
    );
  }

  return (
    <Modal
      className="modal"
      title={`确认放弃 Topic ${topicId}`}
      onClose={() => setConfirming(false)}
      footer={
        <form action={action}>
          <input type="hidden" name="releaseId" value={releaseId} />
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            取消
          </button>{" "}
          <button type="submit" className="btn btn-danger">
            确认放弃提测主题
          </button>
        </form>
      }
    >
      <p>「{topicName}」放弃后不可撤销，影响范围如下：</p>
      <ul>
        <li>Topic ID：<code>{topicId}</code></li>
        <li>主题名：{topicName}</li>
        <li>影响包数：{packageCount} 个（只影响本地这条提测的状态，不改任何包的仓库内容）</li>
        <li>CRP 上是否已有 Release：{hasCrpReleases ? "有" : "没有"}</li>
        <li>不可撤销。</li>
        <li>本操作不删除 CRP 上的 Release，只把主题标记为已放弃。</li>
      </ul>
    </Modal>
  );
}
