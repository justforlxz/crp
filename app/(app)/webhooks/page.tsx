/**
 * Webhook 端点管理（MKACG-984 按原型重做）。
 *
 * 结构照 `.agents/spec/design/prototype.html` 的 Webhook 页与 `design.md` 第七节：
 *
 *   `.sec-hd` + `.project-grid` 端点卡（`.pc-hd` / `.pc-body` / `.pc-ft`）
 *   → 新增端点 `.panel`（表单）
 *   → 投递日志 `.panel` + `table.grid`
 *   → `.tip`
 *
 * 状态一律 `.dot` + 文字（design.md 第十节）：启停、投递结果都不靠颜色单独表达。
 *
 * 当前工作区走 `workspaceScope`，与提测记录、项目、项目经理、构建队列同一套解析与同一套排序：
 * 页面里列的「（当前）」必须和别的那几页指向同一个工作区。以前这里自己按 slug 取第一个，
 * 同一个会话下别的页面显示「安全组（当前）」、这一页显示「桌面核心组（当前）」，而平台上没有
 * 全局的工作区切换控件，用户看不出工作区已经变了。
 */

import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { listWebhookEndpoints } from "@/lib/webhook/endpoints";
import { isWebhookEventType, WEBHOOK_EVENT_LABELS, WEBHOOK_EVENT_TYPES } from "@/lib/webhook/events";
import { listRecentDeliveries } from "@/lib/webhook/service";

import { resolveWorkspaceScope } from "../workspaceScope";
import { createEndpointAction, sendTestEventAction, toggleEndpointAction } from "./actions";

/** 数据来自数据库，不参与静态化。 */
export const dynamic = "force-dynamic";

type WebhooksPageProps = {
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

function eventLabel(type: string): string {
  return isWebhookEventType(type) ? WEBHOOK_EVENT_LABELS[type] : type;
}

/** 投递结果的色点档位：只决定颜色，文案不变（design.md 第五节）。 */
function deliveryDotTone(status: string): string {
  if (status === "success") {
    return "is-ok";
  }

  return status === "failed" ? "is-bad" : "is-warn";
}

function formatTime(value: Date): string {
  return `${value.toISOString().replace("T", " ").slice(0, 19)}Z`;
}

export default async function WebhooksPage({ searchParams }: WebhooksPageProps) {
  const query = await searchParams;
  const scope = await resolveWorkspaceScope("/webhooks", query.workspace);

  if (scope.active === null) {
    return (
      <PageShell title="Webhook 端点">
        <p>
          这个账号还不属于任何工作区，先请平台管理员把账号加入工作区。当前登录：
          {scope.account.displayName}
        </p>
      </PageShell>
    );
  }

  const workspace = scope.active;
  const endpoints = await listWebhookEndpoints(workspace.id);
  const deliveries = await listRecentDeliveries(workspace.id);

  return (
    <PageShell title="Webhook 端点">
      <div className="stack">
        <div className="toast-stack">
          <Toast
            className="toast bad"
            role="alert"
            message={query.error === undefined ? null : `操作失败：${query.error}`}
          />
          <Toast
            className="toast ok"
            message={query.notice === undefined ? null : query.notice}
          />
        </div>

        <div>
          <div className="sec-hd">
            <h3>端点</h3>
            <span className="hint">构建状态变化时推送</span>
          </div>

          <form method="get" action="/webhooks" className="filters">
            <select
              className="select"
              name="workspace"
              defaultValue={workspace.slug}
              aria-label="工作区"
            >
              {scope.workspaces.map((item) => (
                <option key={item.id} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-sm">
              切换工作区
            </button>
            <div className="spacer" />
            <span className="result-n">
              共 {endpoints.length} 个端点，显示最近 {deliveries.length} 条投递
            </span>
          </form>

          {endpoints.length === 0 ? (
            <div className="empty">
              <div className="empty-ico" aria-hidden="true">◇</div>
              <div className="empty-t">这个工作区还没有端点</div>
              <div className="empty-d">在下面新增一个端点，选好订阅事件再保存。</div>
            </div>
          ) : (
            <div className="project-grid">
              {endpoints.map((endpoint) => (
                <div className="project-card" key={endpoint.id}>
                  <div className="pc-hd">
                    <div className="pc-ico" aria-hidden="true">
                      ⇢
                    </div>
                    <div className="pc-title">
                      <div className="pc-name">{endpoint.name}</div>
                      <div className="pc-key">{endpoint.url}</div>
                    </div>
                    <span className={`dot ${endpoint.enabled ? "is-ok" : "is-wait"}`}>
                      {endpoint.enabled ? "启用" : "停用"}
                    </span>
                  </div>
                  <div className="pc-body">
                    <div className="pc-chips">
                      {endpoint.eventTypes.map((type) => (
                        <span className="chip" key={type}>
                          {eventLabel(type)}
                        </span>
                      ))}
                    </div>
                    {endpoint.description === null ? null : <p>{endpoint.description}</p>}
                  </div>
                  <div className="pc-ft">
                    <form action={sendTestEventAction}>
                      <input type="hidden" name="id" value={endpoint.id} />
                      <input type="hidden" name="workspaceSlug" value={workspace.slug} />
                      <button
                        type="submit"
                        className="btn btn-sm"
                        disabled={!endpoint.enabled}
                      >
                        测试
                      </button>
                    </form>
                    <div className="spacer" />
                    <form action={toggleEndpointAction}>
                      <input type="hidden" name="id" value={endpoint.id} />
                      <input type="hidden" name="workspaceSlug" value={workspace.slug} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={endpoint.enabled ? "false" : "true"}
                      />
                      <button type="submit" className="btn btn-sm">
                        {endpoint.enabled ? "停用" : "启用"}
                      </button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-hd">
            <h2>新增端点</h2>
            <span className="hint">密钥保存后页面与日志都不再显示</span>
          </div>
          <div className="panel-bd">
            <form action={createEndpointAction}>
              <input type="hidden" name="workspaceId" value={workspace.id} />
              <input type="hidden" name="workspaceSlug" value={workspace.slug} />

              <div className="field">
                <label className="label" htmlFor="endpoint-name">
                  名称
                </label>
                <input
                  id="endpoint-name"
                  className="input"
                  name="name"
                  required
                  maxLength={100}
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="endpoint-url">
                  回调地址
                </label>
                <input
                  id="endpoint-url"
                  className="input"
                  name="url"
                  type="url"
                  required
                  placeholder="https://example.com/crp/webhook"
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="endpoint-secret">
                  签名密钥
                </label>
                <input
                  id="endpoint-secret"
                  className="input"
                  name="secret"
                  type="{{PASSWORD_2b2afe45}}"
                  required
                  minLength={8}
                  autoComplete="new-{{PASSWORD_2b2afe45}}"
                />
                <div className="note">自己填一段与接收方约定的字符串。保存后页面与日志都不再显示它。</div>
              </div>

              <fieldset className="field">
                <legend className="label">订阅事件</legend>
                {WEBHOOK_EVENT_TYPES.map((type) => (
                  <label key={type}>
                    <input type="checkbox" name="eventTypes" value={type} />{" "}
                    {WEBHOOK_EVENT_LABELS[type]}（{type}）
                  </label>
                ))}
              </fieldset>

              <div className="field">
                <label className="label" htmlFor="endpoint-description">
                  说明
                </label>
                <input id="endpoint-description" className="input" name="description" />
              </div>

              <button type="submit" className="btn btn-primary">
                保存端点
              </button>
            </form>
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <h2>投递日志</h2>
            <span className="hint">最近 20 条</span>
          </div>
          {deliveries.length === 0 ? (
            <div className="panel-bd">
              <div className="empty">
                <div className="empty-ico" aria-hidden="true">◇</div>
                <div className="empty-t">还没有投递记录</div>
                <div className="empty-d">端点收到第一条事件之后，这里会记下每次投递的结果与耗时。</div>
              </div>
            </div>
          ) : (
            <div className="panel-bd flush table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>端点</th>
                    <th>事件</th>
                    <th>关联记录</th>
                    <th>状态</th>
                    <th className="num">HTTP</th>
                    <th className="num">耗时</th>
                    <th className="num">尝试</th>
                    <th>响应摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td className="num col-mono">{formatTime(delivery.createdAt)}</td>
                      <td>{delivery.endpointName}</td>
                      <td>{eventLabel(delivery.eventType)}</td>
                      <td>{delivery.relatedRecord ?? "-"}</td>
                      <td>
                        <span className={`dot ${deliveryDotTone(delivery.status)}`}>
                          {delivery.status === "success"
                            ? "成功"
                            : delivery.status === "failed"
                              ? "失败"
                              : "进行中"}
                        </span>
                      </td>
                      <td className="num">{delivery.httpStatus ?? "-"}</td>
                      <td className="num">
                        {delivery.durationMs === null ? "-" : `${delivery.durationMs} ms`}
                      </td>
                      <td className="num">
                        {delivery.attempts}
                        {delivery.lastError === null ? null : `（${delivery.lastError}）`}
                      </td>
                      <td className="col-mono">{delivery.responseSnippet ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="tip">
          <span aria-hidden="true">⚠</span>
          <div>
            <b>签名要对得上。</b>
            每个请求带 <code>X-CRP-Signature</code>，由端点密钥与原始请求体算出。验签失败请先确认你用的是原始
            body，不要先解析再重新序列化。端点只收到它订阅的事件类型：停用的端点一条都不投，改完订阅要保存后
            下一条事件才生效。「测试」只验证连通性，不改变端点状态。密钥保存后页面与日志都不再回显，
            忘了只能换一把新的重配。算法见 <code>docs/WEBHOOK.md</code>。
          </div>
        </div>
      </div>
    </PageShell>
  );
}
