/**
 * 界面用例的测量工具（MKACG-985）。
 *
 * 界面组的断言几乎都是「量出来的数对不对」：宽高、圆角、边框、字号、对比度、有效命中区。
 * 这些都放在这里实现一次，用例里只写「量什么、期望多少」，不重复写 `evaluate`。
 */

import type { Page } from "@playwright/test";

import { AcceptanceFailure } from "./report";

/** 取第一个匹配元素的外框；没有元素返回 `null`（用例据此报「元素不存在」）。 */
export async function rectOf(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((query) => {
    const element = document.querySelector(query);

    if (element === null) {
      return null;
    }

    const rect = element.getBoundingClientRect();

    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
}

/** 取第一个匹配元素的计算样式（只要点名的属性，日志才好读）。 */
export async function styleOf(
  page: Page,
  selector: string,
  properties: readonly string[],
): Promise<Record<string, string> | null> {
  return page.evaluate(
    (input) => {
      const element = document.querySelector(input.selector);

      if (element === null) {
        return null;
      }

      const computed = getComputedStyle(element);
      const result: Record<string, string> = {};

      for (const property of input.properties) {
        result[property] = String(computed[property as keyof CSSStyleDeclaration] ?? "");
      }

      return result;
    },
    { selector, properties },
  );
}

/**
 * 提测记录页上第一个「详情」链接的路径。
 *
 * 不能取「第一个 `/releases/` 开头的链接」：页头先渲染「从 CRP 导入」(`/releases/import`) 与
 * 「＋ 创建提测」(`/releases/new`)，行内详情链接在后面。取错就会把导入页当成详情页量，
 * `.detail-cols` 永远不存在，失败信息还会把人指向详情页结构。
 */
async function firstDetailPath(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const anchor of document.querySelectorAll('a[href^="/releases/"]')) {
      const path = new URL((anchor as HTMLAnchorElement).href).pathname;
      const match = /^\/releases\/([^/]+)$/u.exec(path);

      if (match !== null && match[1] !== "new" && match[1] !== "import") {
        return path;
      }
    }

    return null;
  });
}

/** 取详情页路径；取不到就按用例格式报出来，而不是悄悄打开列表页。 */
export async function requireDetailPath(id: string, page: Page): Promise<string> {
  const path = await firstDetailPath(page);

  if (path === null) {
    throw new AcceptanceFailure(
      id,
      "提测记录页上的详情链接",
      "存在 /releases/<id> 形式的链接",
      "只找到 /releases/new、/releases/import，或没有链接",
    );
  }

  return path;
}

/** 匹配元素的数量。 */
export function countOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

/** 匹配元素的文本，去首尾空白、丢掉空串。 */
export async function textsOf(page: Page, selector: string): Promise<string[]> {
  const raw = await page.locator(selector).allInnerTexts();

  return raw.map((text) => text.trim()).filter((text) => text !== "");
}

/** 页面是否有横向溢出：`scrollWidth > clientWidth` 即溢出。 */
export function overflowOf(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/**
 * 有效命中区的边长。
 *
 * 原型里 32px 的小按钮靠伪元素把可点范围扩到 40px，而伪元素没有自己的盒子可量。
 * 所以这里从元素中心向外探测：`elementFromPoint` 仍然命中这个元素（或它的子元素）的最远距离
 * 就算有效半径 —— 伪元素扩出来的区域在命中测试里就是这样生效的。
 *
 * 只探测到 `PROBE_LIMIT` 像素：判据是「≥40px」，探到 40 就够，不必知道到底能扩多远。
 */
const PROBE_LIMIT = 40;

export async function hitBoxOf(
  page: Page,
  selector: string,
): Promise<{ width: number; height: number } | null> {
  const locator = page.locator(selector).first();

  if ((await locator.count()) === 0) {
    return null;
  }

  await locator.scrollIntoViewIfNeeded();

  return page.evaluate(
    (input) => {
      const element = document.querySelector(input.selector);

      if (element === null) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const hits = (x: number, y: number): boolean => {
        const target = document.elementFromPoint(x, y);
        return target !== null && (target === element || element.contains(target));
      };

      let right = rect.width / 2;
      let left = rect.width / 2;
      let down = rect.height / 2;
      let up = rect.height / 2;

      for (let step = 1; step <= input.limit; step += 1) {
        if (hits(centerX + step, centerY)) {
          right = Math.max(right, step);
        }

        if (hits(centerX - step, centerY)) {
          left = Math.max(left, step);
        }

        if (hits(centerX, centerY + step)) {
          down = Math.max(down, step);
        }

        if (hits(centerX, centerY - step)) {
          up = Math.max(up, step);
        }
      }

      return { width: right + left, height: down + up };
    },
    { selector, limit: PROBE_LIMIT },
  );
}

export type Rgb = { r: number; g: number; b: number; a: number };

/** 解析 `rgb()` / `rgba()`；解析不出来时抛错（别把解析失败当成通过）。 */
export function parseColor(value: string): Rgb {
  const match = /rgba?\(([^)]+)\)/u.exec(value);

  if (match === null) {
    throw new Error(`解析不了颜色：${value}`);
  }

  const parts = (match[1] ?? "").split(",").map((part) => Number(part.trim()));

  return {
    r: parts[0] ?? 0,
    g: parts[1] ?? 0,
    b: parts[2] ?? 0,
    a: parts[3] ?? 1,
  };
}

/** WCAG 2.1 的相对亮度。 */
function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 两色对比度（WCAG 2.1）。 */
export function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(luminance(parseColor(foreground)), luminance(parseColor(background)));
  const dark = Math.min(luminance(parseColor(foreground)), luminance(parseColor(background)));

  return (light + 0.05) / (dark + 0.05);
}

/** 一组元素里叠起来的最大宽度，用来验「一行四个统计卡」。 */
export function sameRow(boxes: ReadonlyArray<{ y: number }>): boolean {
  const [first, ...rest] = boxes;

  if (first === undefined) {
    return false;
  }

  return rest.every((box) => Math.abs(box.y - first.y) <= 1);
}
