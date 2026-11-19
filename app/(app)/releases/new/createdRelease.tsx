"use client";

/**
 * 提交成功后的结果页：提测编号、Topic 版本号、轮次与逐包快照。
 *
 * 内容全部来自接口返回体（`POST /api/releases` 的 201），这里不另算一遍：
 * 页面上显示的就是写进库里的那些值。
 */

import Link from "next/link";

import { shortSha, type SubmitResult } from "./wizardTypes";

export function CreatedRelease({ result, notice }: { result: SubmitResult; notice: string }) {
  return (
    <>
      <h2>提测已创建</h2>
      <p className="alert alert--info" role="status">{notice}</p>
      <dl>
        <dt>提测 ID</dt>
        <dd>
          <code>{result.id}</code>
        </dd>
        <dt>Topic 版本号</dt>
        <dd>{result.version}</dd>
        <dt>轮次</dt>
        <dd>{result.revision}</dd>
        <dt>快照条数</dt>
        <dd>{result.packageCount}</dd>
        <dt>投递顺序（上游在前）</dt>
        <dd>
          <code>{result.order.join(" → ")}</code>
        </dd>
        <dt>状态</dt>
        <dd>
          <code>pending</code>（已创建、尚未投递；投递由 A12 负责）
        </dd>
      </dl>

      <h2>快照</h2>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>软件包</th>
              <th>分支</th>
              <th>Commit</th>
              <th>代码版本</th>
              <th>仓库版本</th>
              <th>提测版本</th>
              <th>对比上次</th>
            </tr>
          </thead>
          <tbody>
            {result.snapshots.map((snapshot) => (
              <tr key={snapshot.packageName}>
                <td>{snapshot.packageName}</td>
                <td>
                  <code>{snapshot.branch}</code>
                </td>
                <td>
                  <code>{shortSha(snapshot.commitSha)}</code>
                </td>
                <td>{snapshot.codeVersion}</td>
                <td>{snapshot.repoVersion ?? "—"}</td>
                <td>{snapshot.releaseVersion}</td>
                <td>{snapshot.changed ? "有更新" : "无变化"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p>
        <Link href="/projects">返回项目列表</Link>
        {"　"}
        <Link href="/releases/new">再建一个提测</Link>
      </p>
    </>
  );
}
