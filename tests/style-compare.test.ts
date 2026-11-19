/**
 * 样式门禁的比对逻辑（A20）。
 *
 * 锁住四件事：
 *
 * - 单属性改动必须被抓到，且输出正好是「页面 / 锚点 / 属性 / 期望 / 实际」；
 * - 一个锚点的多个实例逐个比，实例数量变了也算失败（不能静默只比第一个）；
 * - 「锚点缺失」与「锚点还在但样式变了」是两种失败，不能混成一条；
 * - 几何差异只在超出容差时报，容差内的抖动不算样式被改坏。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PNG } from "pngjs";

import {
  compareAnchors,
  compareCssVariables,
  comparePng,
  formatFinding,
  type AnchorMap,
  type AnchorSample,
} from "../scripts/style-check/compare";

function sample(overrides: Partial<AnchorSample["style"]> = {}, box = {}): AnchorSample {
  return {
    style: {
      display: "block",
      position: "static",
      margin: "0px",
      padding: "0px",
      fontSize: "14px",
      fontWeight: "400",
      lineHeight: "22.4px",
      color: "rgb(31, 35, 41)",
      backgroundColor: "rgb(255, 255, 255)",
      border: "1px solid rgb(208, 211, 217)",
      borderRadius: "10px",
      boxShadow: "none",
      width: "1024px",
      height: "66px",
      ...overrides,
    },
    box: { x: 232, y: 221.95, width: 1024, height: 66, ...box },
  };
}

test("完全一致时没有任何差异", () => {
  const anchors: AnchorMap = { "releases.table": [sample()] };

  assert.deepEqual(
    compareAnchors({
      page: "提测记录",
      expected: anchors,
      actual: anchors,
      geometryTolerancePx: 2,
    }),
    [],
  );
});

test("单个属性改动报一条，字段顺序是 页面 / 锚点 / 属性 / 期望 / 实际", () => {
  const findings = compareAnchors({
    page: "提测记录",
    expected: { "releases.table": [sample({ borderRadius: "10px" })] },
    actual: { "releases.table": [sample({ borderRadius: "12px" })] },
    geometryTolerancePx: 2,
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    page: "提测记录",
    anchor: "releases.table",
    property: "borderRadius",
    expected: "10px",
    actual: "12px",
  });
  assert.equal(formatFinding(findings[0]!), "提测记录 / releases.table / borderRadius / 10px / 12px");
});

test("多实例锚点逐个比：第二个实例的样式变了也要抓到", () => {
  const findings = compareAnchors({
    page: "提测记录",
    expected: { "releases.row-status": [sample(), sample()] },
    actual: { "releases.row-status": [sample(), sample({ color: "rgb(0, 0, 0)" })] },
    geometryTolerancePx: 2,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.anchor, "releases.row-status#2");
  assert.equal(findings[0]?.property, "color");
});

test("实例数量变了算失败，且说清就是实例数这一项", () => {
  const findings = compareAnchors({
    page: "提测记录",
    expected: { "releases.row-status": [sample(), sample(), sample()] },
    actual: { "releases.row-status": [sample()] },
    geometryTolerancePx: 2,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.property, "实例数");
  assert.equal(findings[0]?.expected, "3");
  assert.equal(findings[0]?.actual, "1");
});

test("锚点缺失与样式不符分开报", () => {
  const missing = compareAnchors({
    page: "软件包",
    expected: { "packages.empty": [sample()], "packages.table": [sample()] },
    actual: { "packages.table": [sample({ height: "740px" })] },
    geometryTolerancePx: 2,
  });

  assert.deepEqual(
    missing.map((item) => [item.anchor, item.property]),
    [
      ["packages.empty", "锚点"],
      ["packages.table", "height"],
    ],
  );
  assert.equal(missing[0]?.actual, "缺失");
});

test("基线里没有的锚点算新增，不算通过", () => {
  const findings = compareAnchors({
    page: "工作台",
    expected: {},
    actual: { "dashboard.new-block": [sample()] },
    geometryTolerancePx: 2,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.property, "锚点");
  assert.equal(findings[0]?.actual, "新增（1 个实例）");
});

test("几何差异容差内不报，超出容差报单项", () => {
  const within = compareAnchors({
    page: "工作台",
    expected: { "dashboard.stats": [sample({}, { x: 232 })] },
    actual: { "dashboard.stats": [sample({}, { x: 234 })] },
    geometryTolerancePx: 2,
  });
  const beyond = compareAnchors({
    page: "工作台",
    expected: { "dashboard.stats": [sample({}, { x: 232 })] },
    actual: { "dashboard.stats": [sample({}, { x: 234.5 })] },
    geometryTolerancePx: 2,
  });

  assert.deepEqual(within, []);
  assert.equal(beyond.length, 1);
  assert.equal(beyond[0]?.property, "boundingBox.x");
  assert.equal(beyond[0]?.expected, "232px");
  assert.equal(beyond[0]?.actual, "234.5px");
});

function png(width: number, height: number, paint: (data: Buffer) => void): Buffer {
  const image = new PNG({ width, height });

  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = 255;
    image.data[index + 1] = 255;
    image.data[index + 2] = 255;
    image.data[index + 3] = 255;
  }

  paint(image.data);

  return PNG.sync.write(image);
}

test("同一张截图比例差为 0", () => {
  const shot = png(10, 10, () => undefined);
  const diff = comparePng(shot, shot);

  assert.equal(diff.sameSize, true);
  assert.equal(diff.diffPixels, 0);
  assert.equal(diff.ratio, 0);
  assert.equal(diff.totalPixels, 100);
});

test("像素变了就计入比例，差异图与原图同尺寸", () => {
  const before = png(10, 10, () => undefined);
  const after = png(10, 10, (data) => {
    data[0] = 0;
  });
  const diff = comparePng(before, after);

  assert.equal(diff.diffPixels, 1);
  assert.equal(diff.ratio, 0.01);
  assert.equal(PNG.sync.read(diff.diffPng).width, 10);
  assert.equal(PNG.sync.read(diff.diffPng).height, 10);
});

test("整页高度变了就没法逐像素比，直接判失败并报出两边的尺寸", () => {
  const diff = comparePng(
    png(10, 10, () => undefined),
    png(10, 12, () => undefined),
  );

  assert.equal(diff.sameSize, false);
  assert.equal(diff.ratio, 1);
  assert.equal(diff.expectedWidth, 10);
  assert.equal(diff.expectedHeight, 10);
  assert.equal(diff.width, 10);
  assert.equal(diff.height, 12);
});

test("设计变量只比值与删除，新增变量不算失败", () => {
  const findings = compareCssVariables({
    file: "app/globals.css",
    expected: { "--radius-lg": "10px", "--space-1": "4px" },
    actual: { "--radius-lg": "12px", "--space-2": "8px" },
  });

  assert.deepEqual(findings, [
    {
      page: "app/globals.css",
      anchor: "--radius-lg",
      property: "值",
      expected: "10px",
      actual: "12px",
    },
    {
      page: "app/globals.css",
      anchor: "--space-1",
      property: "变量",
      expected: "4px",
      actual: "被删掉了",
    },
  ]);
});
