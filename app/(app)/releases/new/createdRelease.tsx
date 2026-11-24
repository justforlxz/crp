"use client";

/**
 * 提交成功后的结果：提测版本、轮次与逐包快照。
 *
 * 内容全部来自接口返回体（`POST /api/releases` 的 201），这里不另算一遍：页面上显示的就是
 * 写进库里的那些值。容器用与向导同一套件（`.tip` 说明 + `.confirm-card` 事实 + `.grid` 表格），
 * 不再另起一套结果页视觉。
 */

import Link from "next/link";

import { Icon } from "@/components/icons";
// 只从纯函数模块引：`@/lib/releases` 的出口会连带把服务端模块（Prisma）拉进客户端包。
import { releaseStatusLabel, releaseStatusTone } from "@/lib/releases/labels";
import { shortSha, type SubmitResult } from "./wizardTypes";

export function CreatedRelease({ result, notice }: { result: SubmitResult; notice: string }) {
  return (
    <>
      <div className="tip" role="status">
        <Icon name="check" />
        <div>
          <b>提测已创建</b>
          {notice}
        </div>
      </div>

      <div className="confirm-card" data-style-anchor="release-new.created">
        <div className="cfg-row">
          <div>
            <small>提测 ID</small>
            <b className="col-mono">{result.id}</b>
          </div>
          <div>
            <small>Topic 版本号</small>
            <b className="num">{result.version}</b>
          </div>
        </div>
        <div className="cfg-row">
          <div>
            <small>轮次</small>
            <b className="num">第 {result.revision} 轮</b>
          </div>
          <div>
            <small>快照条数</small>
            <b className="num">{result.packageCount}</b>
          </div>
        </div>
        <div className="cfg-row">
          <div>
            <small>投递顺序（上游在前）</small>
            <b className="col-mono">{result.order.join(" → ")}</b>
          </div>
          <div>
            <small>状态</small>
            <b>
              <span className={`dot ${releaseStatusTone("pending")}`}>
                {releaseStatusLabel("pending")}
              </span>
            </b>
          </div>
        </div>
      </div>

      <div className="subhead">快照</div>

      <div className="table-scroll">
        <table className="grid cols-confirm">
          <thead>
            <tr>
              <th>软件包</th>
              <th>分支</th>
              <th>Commit</th>
              <th className="num">代码版本</th>
              <th className="num">仓库版本</th>
              <th>提测版本</th>
              <th>对比上次</th>
            </tr>
          </thead>
          <tbody>
            {result.snapshots.map((snapshot) => (
              <tr key={snapshot.packageName}>
                <td>
                  <strong>{snapshot.packageName}</strong>
                </td>
                <td className="col-mono">{snapshot.branch}</td>
                <td className="col-mono">{shortSha(snapshot.commitSha)}</td>
                <td className="num col-mono">{snapshot.codeVersion}</td>
                <td className="num col-mono">{snapshot.repoVersion ?? "—"}</td>
                <td>
                  <b className="num text-accent">{snapshot.releaseVersion}</b>
                </td>
                <td>
                  <span className={`dot ${snapshot.changed ? "is-warn" : "is-wait"}`}>
                    {snapshot.changed ? "有更新" : "无变化"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="wiz-foot-note">
        <Link className="btn" href="/releases">
          回到提测记录
        </Link>
        <Link className="btn btn-primary" href="/releases/new">
          再建一个提测
        </Link>
      </p>
    </>
  );
}
