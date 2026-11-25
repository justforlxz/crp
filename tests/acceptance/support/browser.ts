/**
 * 界面组的浏览器（MKACG-985）。
 *
 * 启动与登录取 `scripts/style-check/measure.ts` 的 `openStyleBrowser` 与会话签发，不新起一套：
 * 用例集要求如此，也确实该如此 —— 视口、locale、时区、动效偏好差一项，量出来的布局就会不同，
 * 那时「样式门禁通过、验收失败」会变成没法解释的常态。
 *
 * 用例集还要求界面组每条在 1440 与 375 两个宽度各跑一次，所以入口是 `eachWidth`：
 * 一个宽度一个上下文，页面在结束时统一关掉。
 */

import type { Page } from "@playwright/test";

import { openStyleBrowser } from "../../../scripts/style-check/measure";
import { mintSession } from "./http";
import { AcceptanceFailure } from "./report";

/** 用例集规定的两个宽度。 */
export const UI_WIDTHS = [1440, 375] as const;

export type UiContext = {
  /** 打开一页：等网络空闲、等字体就位，再交给断言。 */
  open(path: string): Promise<Page>;
  /** 当前宽度，报告里写清楚是哪个视口坏了。 */
  readonly width: number;
};

/**
 * 按宽度逐轮跑一条用例。
 *
 * 会话只签一次（两个宽度共用一个账号没问题：会话行的 `active_workspace_id` 不随视口变），
 * 每个宽度单独开一个上下文，宽度之间互不影响。
 */
export async function eachWidth(
  id: string,
  body: (context: UiContext, width: number) => Promise<void>,
  options: { widths?: readonly number[]; workspaceSlug?: string } = {},
): Promise<void> {
  const widths = options.widths ?? UI_WIDTHS;
  const { baseUrl } = await requireBaseUrl();
  const session = await mintSession({ workspaceSlug: options.workspaceSlug });

  try {
    for (const width of widths) {
      const browser = await openStyleBrowser({
        viewport: { width, height: 900 },
        baseUrl,
        sessionToken: session.cookie.split("=")[1] ?? "",
      });

      try {
        const context: UiContext = {
          width,
          async open(path) {
            const page = await browser.context.newPage();
            const response = await page.goto(`${baseUrl}${path}`, {
              waitUntil: "networkidle",
            });

            if (response !== null && response.status() >= 400) {
              throw new AcceptanceFailure(
                id,
                `${path} 的响应`,
                "HTTP < 400",
                `HTTP ${String(response.status())}`,
              );
            }

            const landed = new URL(page.url()).pathname;

            if (landed !== path.split("?")[0]) {
              throw new AcceptanceFailure(
                id,
                `${path} 落地路径`,
                path.split("?")[0] ?? path,
                landed,
              );
            }

            await page.evaluate(() => document.fonts.ready.then(() => undefined));

            return page;
          },
        };

        try {
          await body(context, width);
        } catch (error) {
          if (error instanceof AcceptanceFailure) {
            throw new AcceptanceFailure(
              error.id,
              `${error.label}（${String(width)}px 视口）`,
              error.expected,
              error.actual,
            );
          }

          throw error;
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await session.cleanup();
  }
}

/** 只跑一个宽度时的简写（少量用例写明「只说 1440」）。 */
export async function atWidth(
  id: string,
  width: number,
  body: (context: UiContext) => Promise<void>,
): Promise<void> {
  await eachWidth(id, (context) => body(context), { widths: [width] });
}

/** 取 base URL；调用方已经过 `acceptanceWithEnv` 把关，这里只是把 `null` 挡掉。 */
async function requireBaseUrl(): Promise<{ baseUrl: string }> {
  const { baseUrl } = await import("./env");
  const value = baseUrl();

  if (value === null) {
    throw new Error("缺少 BASE_URL：界面用例不应该在缺环境时被调用");
  }

  return { baseUrl: value };
}
