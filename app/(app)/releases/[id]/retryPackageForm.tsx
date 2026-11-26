"use client";

/**
 * 单包重投的二次确认（MKACG-1011）。
 *
 * 重投会真的删掉 CRP 上这个包的旧 Release 再按同一份快照参数重发一次，所以不让人一点就发：
 * 先点「重新投递」，展开确认框，把**只重投这一个包**写清楚，再点一次才提交。
 *
 * 确认框里必须出现包名、只影响这一个包的说明、以及「已成功的架构不会重跑」：
 * 用户点它是因为卡住了，要知道别的包不会被他牵连。
 *
 * 为什么用客户端组件：二次确认要一次点击才展开，这需要一点状态。能不能重投不在这里判断 ——
 * 页面在不能重投时根本不会渲染它（判定在 `retryState.ts`，与页面用的是同一份）。
 *
 * 确认框用原型的 `.modal` 结构，并挂到 `document.body` 上（`./detailModal`，否则 `<td>` 里
 * 的定位基准会让弹窗落在视口外）：点遮罩、点右上角 ×、按 Esc、点「取消」都收起，
 * 与页面里另外两个危险动作的确认框一致。
 */

import { useState } from "react";

import { DetailModal } from "./detailModal";

export function RetryPackageForm({
  releaseId,
  packageName,
  action,
}: {
  releaseId: string;
  /** 要重投的软件包名，确认框标题与提交的表单字段都用它。 */
  packageName: string;
  /** 服务端动作：提交后由它只重投这一个包。 */
  action: (formData: FormData) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>
        重新投递
      </button>
    );
  }

  return (
    <DetailModal
      className="modal"
      title={`重新投递 ${packageName}？`}
      onClose={() => setConfirming(false)}
      footer={
        <form action={action}>
          <input type="hidden" name="releaseId" value={releaseId} />
          <input type="hidden" name="packageName" value={packageName} />
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            取消
          </button>{" "}
          <button type="submit" className="btn btn-primary">
            确认重投这个包
          </button>
        </form>
      }
    >
      <p>
        <b>只重投这一个软件包</b>，其他包不动。它当前的构建会作废，按同一份快照参数（分支、提交、
        提测版本）重新发一次。
      </p>
      <ul>
        <li>软件包：{packageName}</li>
        <li>已成功的架构不会重跑，只补没完成的。</li>
        <li>下游在等这个包时会继续等，不会被重投。</li>
        <li>作废的是 CRP 上这个包的旧 Release，不能撤销。</li>
      </ul>
    </DetailModal>
  );
}
