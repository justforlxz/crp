/**
 * L2 / L3 的比对逻辑。
 *
 * 这一层是纯函数：不碰浏览器、不碰数据库、不读文件，输入输出都是普通对象，所以能直接单测。
 *
 * 锚点的形状是「名字 → 按文档顺序排列的所有实例」。一个名字可能对应多个元素：提测记录表的行内
 * 状态徽标一行一个，种子数据当前是 3 个。比对按实例逐个进行，实例数量本身也参与比对，不能
 * 假设「锚点名字 → 唯一元素」——那样要么选择器报错，要么静默只比到第一个。
 */
import { PNG } from "pngjs";

/** L2 固定的属性集：不增不减，改动要同步改 `docs/STYLE-VERIFICATION.md`。 */
export const STYLE_PROPERTIES = [
  "display",
  "position",
  "margin",
  "padding",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "color",
  "backgroundColor",
  "border",
  "borderRadius",
  "boxShadow",
  "width",
  "height",
] as const;

export type StyleProperty = (typeof STYLE_PROPERTIES)[number];

/** 锚点的文档坐标与尺寸（相对整页左上角），单位 CSS 像素。 */
export type Box = { x: number; y: number; width: number; height: number };

export type AnchorSample = {
  style: Record<StyleProperty, string>;
  box: Box;
};

/** 一页的锚点快照：名字 → 按文档顺序排列的实例。 */
export type AnchorMap = Record<string, AnchorSample[]>;

/**
 * 一条差异。字段顺序就是对外输出的顺序：`页面 / 锚点 / 属性 / 期望 / 实际`。
 *
 * 定位信息必须一眼够用：不打印 DOM，也不打印整张快照。
 */
export type Finding = {
  page: string;
  anchor: string;
  property: string;
  expected: string;
  actual: string;
};

/** 一条差异的单行形式。所有失败都走这一个格式，便于 grep 与贴进 issue。 */
export function formatFinding(finding: Finding): string {
  return [
    finding.page,
    finding.anchor,
    finding.property,
    finding.expected,
    finding.actual,
  ].join(" / ");
}

function formatPx(value: number): string {
  return `${value}px`;
}

/**
 * 比对一页的计算样式、几何与实例数量。
 *
 * 四类差异分开报，便于分辨「锚点没了」和「锚点还在但样式变了」：
 *
 * - `锚点`：基线有的锚点这次一个实例都没量到；
 * - `实例数`：锚点还在，但实例数量变了；
 * - 属性名：单个属性的计算值不同（严格相等，不做模糊匹配）；
 * - `boundingBox.x/y/width/height`：几何偏移超过容差。
 */
export function compareAnchors(input: {
  page: string;
  expected: AnchorMap;
  actual: AnchorMap;
  /** 几何容差，单位 CSS 像素，默认由调用方从环境变量读出来。 */
  geometryTolerancePx: number;
}): Finding[] {
  const { page, expected, actual, geometryTolerancePx } = input;
  const findings: Finding[] = [];

  for (const [anchor, wanted] of Object.entries(expected)) {
    const found = actual[anchor] ?? [];

    if (found.length === 0) {
      findings.push({
        page,
        anchor,
        property: "锚点",
        expected: `存在（${wanted.length} 个实例）`,
        actual: "缺失",
      });
      continue;
    }

    if (found.length !== wanted.length) {
      findings.push({
        page,
        anchor,
        property: "实例数",
        expected: String(wanted.length),
        actual: String(found.length),
      });
    }

    const shared = Math.min(found.length, wanted.length);

    for (let index = 0; index < shared; index += 1) {
      const want = wanted[index] as AnchorSample;
      const got = found[index] as AnchorSample;
      const suffix = wanted.length > 1 ? `#${index + 1}` : "";

      for (const property of STYLE_PROPERTIES) {
        const wantValue = want.style[property] ?? "";
        const gotValue = got.style[property] ?? "";

        if (wantValue !== gotValue) {
          findings.push({
            page,
            anchor: `${anchor}${suffix}`,
            property,
            expected: wantValue,
            actual: gotValue,
          });
        }
      }

      for (const key of ["x", "y", "width", "height"] as const) {
        const delta = Math.abs(want.box[key] - got.box[key]);

        if (delta > geometryTolerancePx) {
          findings.push({
            page,
            anchor: `${anchor}${suffix}`,
            property: `boundingBox.${key}`,
            expected: formatPx(want.box[key]),
            actual: formatPx(got.box[key]),
          });
        }
      }
    }
  }

  for (const [anchor, found] of Object.entries(actual)) {
    if (expected[anchor] !== undefined) {
      continue;
    }

    findings.push({
      page,
      anchor,
      property: "锚点",
      expected: "基线里没有这个锚点",
      actual: `新增（${found.length} 个实例）`,
    });
  }

  return findings;
}

/**
 * 比对 `app/globals.css` 里 `:root` 的设计变量。
 *
 * 为什么单独比一层：锚点只覆盖被标注的元素，改一个没有锚点落在上面的变量（例如卡片圆角
 * `--radius-lg`，它只影响登录、注册与导入页的 `.card`）在锚点层面看不出来，像素差也可能低于
 * 阈值。变量是样式的最小单位，改值就当成一次样式改动，必须显式写进基线。
 *
 * 只报「值变了」「变量被删了」：新增变量是加法，不影响既有页面。
 */
export function compareCssVariables(input: {
  /** 报告里的文件名，固定是 `app/globals.css`。 */
  file: string;
  expected: Record<string, string>;
  actual: Record<string, string>;
}): Finding[] {
  const { file, expected, actual } = input;
  const findings: Finding[] = [];

  for (const [name, value] of Object.entries(expected)) {
    const current = actual[name];

    if (current === undefined) {
      findings.push({
        page: file,
        anchor: name,
        property: "变量",
        expected: value,
        actual: "被删掉了",
      });
      continue;
    }

    if (current !== value) {
      findings.push({
        page: file,
        anchor: name,
        property: "值",
        expected: value,
        actual: current,
      });
    }
  }

  return findings;
}

export type PixelDiff = {
  /** 两张图的尺寸是否一致；不一致时无法逐像素比，直接算失败。 */
  sameSize: boolean;
  /** 基线图的宽高。 */
  expectedWidth: number;
  expectedHeight: number;
  /** 本次截图的宽高。 */
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  /** 差异像素占整页像素的比例，0–1。 */
  ratio: number;
  /** 标出差异位置的图（白底、差异像素标红），超阈值时写盘。 */
  diffPng: Buffer;
};

/**
 * 逐像素比两张整页截图。
 *
 * 只比像素是否完全相同，不做「看起来差不多」的模糊判据；容差体现在比例阈值上，由调用方判断
 * `ratio` 是否超限。差异图用白底红点，便于人眼定位是哪个区块变了。
 */
export function comparePng(expected: Buffer, actual: Buffer): PixelDiff {
  const want = PNG.sync.read(expected);
  const got = PNG.sync.read(actual);
  const sameSize = want.width === got.width && want.height === got.height;
  const width = got.width;
  const height = got.height;
  const totalPixels = sameSize ? width * height : want.width * want.height;
  const diffImage = new PNG({ width, height, fill: true });
  const diff = diffImage.data;

  // 白底：没差异的地方保持白色，差异点标红。
  for (let index = 0; index < diff.length; index += 4) {
    diff[index] = 255;
    diff[index + 1] = 255;
    diff[index + 2] = 255;
    diff[index + 3] = 255;
  }

  if (!sameSize) {
    // 尺寸不同就没法对齐坐标，整张图标红，并在报告里说清是哪一维不同。
    for (let index = 0; index < diff.length; index += 4) {
      diff[index] = 255;
      diff[index + 1] = 0;
      diff[index + 2] = 0;
    }

    return {
      sameSize,
      expectedWidth: want.width,
      expectedHeight: want.height,
      width,
      height,
      diffPixels: totalPixels,
      totalPixels,
      ratio: 1,
      diffPng: PNG.sync.write(diffImage),
    };
  }

  let diffPixels = 0;

  for (let index = 0; index < want.data.length; index += 4) {
    const changed =
      want.data[index] !== got.data[index] ||
      want.data[index + 1] !== got.data[index + 1] ||
      want.data[index + 2] !== got.data[index + 2] ||
      want.data[index + 3] !== got.data[index + 3];

    if (!changed) {
      continue;
    }

    diffPixels += 1;
    diff[index] = 255;
    diff[index + 1] = 0;
    diff[index + 2] = 0;
  }

  return {
    sameSize,
    expectedWidth: want.width,
    expectedHeight: want.height,
    width,
    height,
    diffPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    diffPng: PNG.sync.write(diffImage),
  };
}
