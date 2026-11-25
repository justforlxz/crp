/**
 * 「我的账号」页（MKACG-986）：每个成员在这里配置自己的 CRP 与 Gerrit 账号。
 *
 * 为什么凭据要按人配置：CRP 侧会记下每一次调用的操作人。全平台共用一个账号时，提交人永远
 * 是同一个人，「谁提的、谁批的」这条审计链就断了；那个人的密码一改，全平台提测一起挂
 * （`.agents/spec/product/credentials.md` 第一节）。
 *
 * 页面只有三块：CRP 账号、Gerrit 账号、「没配置会怎样」。前两块各自「保存并验证」——
 * 保存时平台会真的登录一次，通过才入库，所以页面上永远只有已配置的账号名与时间，
 * 从来没有密码。
 *
 * 账号级页面，不按工作区收窄：凭据属于人，不属于工作区。
 */

import { PageShell } from "@/components/page-shell";
import { requirePageAuth } from "@/lib/auth/server";
import { listCredentialViews } from "@/lib/credentials";
import { CREDENTIAL_SECRET_LABELS } from "@/lib/credentials/kinds";

import { CredentialPanel } from "./credentialsForm";

// 凭据随时可能被改动，页面不做静态化。
export const dynamic = "force-dynamic";

export default async function CredentialsPage() {
  // 回跳地址写死这一页自己的路由：守卫与本页必须指同一处，改路由要一起改。
  const auth = await requirePageAuth("/settings/credentials");
  const views = await listCredentialViews(auth.account.id);

  return (
    <PageShell title="我的账号">
      <p>
        平台按<strong>当前操作人</strong>的身份调用 CRP 与 Gerrit：你在页面上点「创建提测」
        「投递」「刷新代码状态」，CRP 上记的就是你的账号。后台定时作业没有登录身份，
        以该提测创建者的名义调用。
      </p>

      {views.map((view) => (
        <CredentialPanel
          key={view.kind}
          view={view}
          secretLabel={CREDENTIAL_SECRET_LABELS[view.kind]}
        />
      ))}

      <div className="tip">
        <div>
          <b>没配置会怎样。</b>
          没有 CRP 账号时，创建提测、投递构建、刷新代码状态都会被拦下来并提示来这里配置，
          平台不会退回任何共用账号；没有 Gerrit 账号时，向导第二步读不到分支与提交，
          也就无法确定要提测哪个 Commit。
        </div>
      </div>
    </PageShell>
  );
}
