"use client";

/**
 * 「新增端点」改成弹窗（MKACG-1002）。
 *
 * 原型把新增端点放在弹窗里（`prototype.html` 的 `openWebhookForm`）：`.sec-hd` 右侧一个按钮，
 * 点开是 `.modal`。MKACG-984 把它做成了 `.panel` 里的内嵌表单，六个未套设计类的控件直接摊在
 * 页面上，看起来像没排版。这里按原型挪进弹窗：
 *
 *   `.sec-hd` 的「新增端点」按钮 → `Modal`（`components/modal.tsx`，遮罩、×、Esc 三种关闭）
 *   → `.field` + `.label` + `.input` / `.textarea` 的表单
 *   → 订阅事件用 `.pick-list` 里的 `.pick` + `aria-pressed`，不用裸 checkbox
 *
 * 订阅事件为什么是按钮而不是 checkbox：原型只给了 `.pick[aria-pressed="true"]` 这一套选中样式，
 * 没有给 checkbox 写过任何外观。按钮按下时把事件标识写进隐藏域，提交时仍然是同一份
 * `eventTypes` 表单字段，`createEndpointAction` 一行都不用改。
 *
 * 弹窗只在打开时才挂载：关掉就整棵子树消失，不需要清空表单状态。
 */

import { useState } from "react";

import { Icon } from "@/components/icons";
import { Modal } from "@/components/modal";
import { WEBHOOK_EVENT_LABELS, WEBHOOK_EVENT_TYPES } from "@/lib/webhook/events";

import { createEndpointAction } from "./actions";

/** 表单与底部「保存」按钮靠 `form` 属性配对：按钮在 `.modal-ft` 里，不在 `<form>` 里。 */
const FORM_ID = "new-endpoint-form";

export type EndpointFormProps = {
  workspaceId: string;
  workspaceSlug: string;
};

/**
 * 新增端点的表单本体。单独导出是为了能直接渲染它做结构断言 —— 弹窗不打开时它不在 DOM 里。
 */
export function EndpointForm({ workspaceId, workspaceSlug }: EndpointFormProps) {
  const [eventTypes, setEventTypes] = useState<readonly string[]>([]);

  function toggle(type: string): void {
    setEventTypes((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  }

  return (
    <form id={FORM_ID} action={createEndpointAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />

      <div className="field">
        <label className="label" htmlFor="endpoint-name">
          名称
        </label>
        <input id="endpoint-name" className="input" name="name" required maxLength={100} />
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
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <div className="note">自己填一段与接收方约定的字符串。保存后页面与日志都不再显示它。</div>
      </div>

      <div className="field">
        <span className="label">订阅事件</span>
        <div className="pick-list" role="group" aria-label="订阅事件">
          {WEBHOOK_EVENT_TYPES.map((type) => {
            const pressed = eventTypes.includes(type);

            return (
              <button
                key={type}
                type="button"
                className="pick"
                aria-pressed={pressed}
                onClick={() => toggle(type)}
              >
                <span className="check" aria-hidden="true">
                  {pressed ? <Icon name="check" /> : null}
                </span>
                <span className="pick-t">{WEBHOOK_EVENT_LABELS[type]}</span>
                <span className="spacer" />
                <span className="pick-d">{type}</span>
              </button>
            );
          })}
        </div>
        {eventTypes.map((type) => (
          <input key={type} type="hidden" name="eventTypes" value={type} />
        ))}
        <div className="note">没选任何事件的端点保存不了；端点只收到它订阅的事件。</div>
      </div>

      <div className="field">
        <label className="label" htmlFor="endpoint-description">
          说明
        </label>
        <textarea id="endpoint-description" className="textarea" name="description" />
      </div>
    </form>
  );
}

export type NewEndpointDialogProps = EndpointFormProps;

/** 「新增端点」按钮 + 点开后挂载的弹窗。 */
export function NewEndpointDialog({ workspaceId, workspaceSlug }: NewEndpointDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        新增端点
      </button>

      {open ? (
        // `.modal-root` 是原型里的弹层容器（固定定位 + `z-index: 100`）。少了它，`.scrim`
        // 的 `z-index` 是 auto，会被表格吸顶表头（`table.grid th` 是 `z-index: 1`）压在上面，
        // 实测 /managers 的吸顶表头正好横穿弹窗顶部，那一条竖带点不动。
        <div className="modal-root">
          <Modal
            className="modal"
            title="新增端点"
            onClose={() => setOpen(false)}
            footer={
              <>
                <div className="spacer" />
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  取消
                </button>
                <button type="submit" form={FORM_ID} className="btn btn-primary">
                  保存端点
                </button>
              </>
            }
          >
            <EndpointForm workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
          </Modal>
        </div>
      ) : null}
    </>
  );
}
