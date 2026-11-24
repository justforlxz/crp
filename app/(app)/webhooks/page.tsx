import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { Toast } from "@/components/toast";
import { listWebhookEndpoints } from "@/lib/webhook/endpoints";
import { isWebhookEventType, WEBHOOK_EVENT_LABELS, WEBHOOK_EVENT_TYPES } from "@/lib/webhook/events";
import { listRecentDeliveries } from "@/lib/webhook/service";

import { resolveWorkspaceScope } from "../workspaceScope";
import { createEndpointAction, sendTestEventAction, toggleEndpointAction } from "./actions";

/**
 * Webhook 端点管理。
 *
 * 当前工作区走 `workspaceScope`，与提测记录、项目、项目经理、构建队列同一套解析与同一套排序：
 * 页面里列的「（当前）」必须和侧栏之外的那几页指向同一个工作区。以前这里自己按 slug 取第一个，
 * 同一个会话下别的页面显示「安全组（当前）」、这一页显示「桌面核心组（当前）」，而平台上没有
 * 全局的工作区切换控件，用户看不出工作区已经变了。
 */

/** 数据来自数据库，不参与静态化。 */
export const dynamic = "force-dynamic";

type WebhooksPageProps = {
  searchParams: Promise<{ workspace?: string; notice?: string; error?: string }>;
};

function eventLabel(type: string): string {
  return isWebhookEventType(type) ? WEBHOOK_EVENT_LABELS[type] : type;
}

/** 投递结果的徽标档位：只决定颜色，文案不变。 */
function deliveryBadgeClass(status: string): string {
  if (status === "success") {
    return "badge badge--success";
  }

  return status === "failed" ? "badge badge--danger" : "badge badge--warn";
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
      <p>
        提测与构建事件按端点订阅推给外部系统。每次投递都留记录，签名可被外部独立复算，
        算法见 <code>docs/WEBHOOK.md</code>。
      </p>

      <p>
        工作区：
        {scope.workspaces.map((item) => (
          <span key={item.id}>
            <Link href={`/webhooks?workspace=${encodeURIComponent(item.slug)}`}>
              {item.name}
            </Link>
            {item.id === workspace.id ? "（当前）" : null}{" "}
          </span>
        ))}
      </p>

      <Toast
        className="toast alert alert--error"
        role="alert"
        message={query.error === undefined ? null : `操作失败：${query.error}`}
      />
      <Toast
        className="toast alert alert--info"
        message={query.notice === undefined ? null : query.notice}
      />

      <h2>新建端点</h2>
      <form action={createEndpointAction}>
        <input type="hidden" name="workspaceId" value={workspace.id} />
        <input type="hidden" name="workspaceSlug" value={workspace.slug} />

        <p>
          <label>
            名称 <input name="name" required maxLength={100} />
          </label>
        </p>
        <p>
          <label>
            回调地址{" "}
            <input name="url" type="url" required placeholder="https://example.com/crp/webhook" />
          </label>
        </p>
        <p>
          <label>
            签名密钥{" "}
            <input
              name="secret"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>{" "}
          自己填一段与接收方约定的字符串。保存后页面与日志都不再显示它。
        </p>

        <fieldset>
          <legend>订阅事件</legend>
          {WEBHOOK_EVENT_TYPES.map((type) => (
            <label key={type}>
              <input type="checkbox" name="eventTypes" value={type} />{" "}
              {WEBHOOK_EVENT_LABELS[type]}（{type}）
            </label>
          ))}
        </fieldset>

        <p>
          <label>
            说明 <input name="description" />
          </label>
        </p>
        <p>
          <button type="submit" className="btn btn-primary">
            保存端点
          </button>
        </p>
      </form>

      <h2>端点清单</h2>
      {endpoints.length === 0 ? (
        <p className="empty">这个工作区还没有端点。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>回调地址</th>
                <th>订阅事件</th>
                <th>状态</th>
                <th>签名密钥</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td>{endpoint.name}</td>
                  <td>
                    <code>{endpoint.url}</code>
                  </td>
                  <td>{endpoint.eventTypes.map(eventLabel).join("、")}</td>
                  <td>
                    <span className={endpoint.enabled ? "badge badge--success" : "badge"}>
                      {endpoint.enabled ? "启用" : "停用"}
                    </span>
                  </td>
                  <td>已设置（不回显）</td>
                  <td>
                    <form action={toggleEndpointAction}>
                      <input type="hidden" name="id" value={endpoint.id} />
                      <input type="hidden" name="workspaceSlug" value={workspace.slug} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={endpoint.enabled ? "false" : "true"}
                      />
                      <button type="submit" className="btn btn-secondary btn-sm">
                        {endpoint.enabled ? "停用" : "启用"}
                      </button>
                    </form>
                    <form action={sendTestEventAction}>
                      <input type="hidden" name="id" value={endpoint.id} />
                      <input type="hidden" name="workspaceSlug" value={workspace.slug} />
                      <button type="submit" className="btn btn-secondary btn-sm" disabled={!endpoint.enabled}>
                        发送测试事件
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="tip">
        <div className="tip-icon" aria-hidden="true">
          ✦
        </div>
        <div>
          <b>事件订阅与签名校验</b>
          <p>
            端点只收到它订阅的事件类型：停用的端点一条都不投，改完订阅要保存后下一条事件才生效。
            「发送测试事件」只验证连通性，不改变端点状态。接收方要按 <code>docs/WEBHOOK.md</code> 的算法
            用签名密钥复算一遍请求头，再决定是否采信；密钥保存后页面与日志都不再回显，忘了只能换一把新的重配。
          </p>
        </div>
      </div>
      <h2>投递日志（最近 20 条）</h2>
      {deliveries.length === 0 ? (
        <p className="empty">还没有投递记录。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>端点</th>
                <th>事件</th>
                <th>关联记录</th>
                <th>状态</th>
                <th>HTTP</th>
                <th>耗时</th>
                <th>尝试</th>
                <th>响应摘要</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{formatTime(delivery.createdAt)}</td>
                  <td>{delivery.endpointName}</td>
                  <td>{eventLabel(delivery.eventType)}</td>
                  <td>{delivery.relatedRecord ?? "-"}</td>
                  <td>
                    <span className={deliveryBadgeClass(delivery.status)}>
                      {delivery.status === "success" ? "成功" : delivery.status === "failed" ? "失败" : "进行中"}
                    </span>
                  </td>
                  <td>{delivery.httpStatus ?? "-"}</td>
                  <td>{delivery.durationMs === null ? "-" : `${delivery.durationMs}ms`}</td>
                  <td>
                    {delivery.attempts} 次{delivery.lastError === null ? "" : `（${delivery.lastError}）`}
                  </td>
                  <td>
                    <code>{delivery.responseSnippet ?? "-"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
