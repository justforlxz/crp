/**
 * 详情页里的「构建状态」区块（A13 挂载 A14）。
 *
 * 这一层只做两件事，渲染内容一行都不重写：
 *
 * - 把 A14 的 `BuildStatusBlock` 挂上去 —— 状态怎么显示、哪些列，全由那个组件决定
 *   （MUST NOT 在详情页复制一份渲染逻辑）；
 * - 区块自己查库，查库抛错时只把这一块换成一句提示，详情页其余部分照常可用（MUST）。
 *
 * 单独的模块而不是塞进 `page.tsx`：隔离逻辑要能被单测直接调用，页面文件只留一行挂载。
 */
import type { ReactNode } from "react";

import { BuildStatusBlock } from "@/components/build-status";

/** 区块的渲染函数；默认是 A14 的真组件，测试里换成会抛错的实现来验证隔离。 */
export type BuildStatusLoader = (props: { releaseId: string }) => Promise<ReactNode>;

/**
 * 渲染构建状态区块。
 *
 * 区块抛错（数据库连不上、查库超时）时不影响页面其他部分：这里接住错误，换成一句提示。
 * 错误内容不往页面上写，只让这一块变成「读不到」。
 */
export async function renderBuildStatusBlock(
  releaseId: string,
  load: BuildStatusLoader,
): Promise<ReactNode> {
  try {
    return await load({ releaseId });
  } catch {
    return (
      <section className="panel">
        <div className="panel-hd">
          <h2>构建状态</h2>
        </div>
        <div className="panel-bd">
          <div className="tip" role="status">
            <span aria-hidden="true">ⓘ</span>
            <div>构建状态暂时读不到，提测的其他内容不受影响。</div>
          </div>
        </div>
      </section>
    );
  }
}

/** 详情页用的挂载点：一边是提测记录 ID，另一边是 A14 的区块。 */
export async function BuildStatusSection({ releaseId }: { releaseId: string }) {
  return renderBuildStatusBlock(releaseId, BuildStatusBlock);
}
