/**
 * Debian 软件包索引的解析函数。
 *
 * Shuttle 的 `GET /repo/info` 会给出基线仓库的 apt 源地址，形如
 * `deb http://aptly-dev.uniontech.com/pkg/eagle-1071/release unstable main`。
 * 软件包名与版本只能从这个源地址指向的 `Sources.gz` 索引里读出来，所以这里
 * 把「解析源地址」和「解析 Sources 索引」拆成纯函数，便于单独测试。
 */

import type { BaselinePackage } from "./types";

/** 一条 `deb` 源地址拆出来的三要素。 */
export type AptSource = {
  /** 仓库根地址，不含 `dists`。 */
  url: string;
  /** 发行版路径，例如 `eagle/1071`、`unstable`。 */
  dist: string;
  /** 组件列表，例如 `["main", "contrib", "non-free"]`。 */
  components: string[];
};

const SOURCE_LINE = /^deb\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)\s+(.+)$/;

/**
 * 解析一行 `deb` 源地址。方括号里的选项（例如 `[trusted=yes]`）会被忽略。
 * 无法识别的行返回 `null`，由调用方决定跳过还是报错。
 */
export function parseAptSourceLine(line: string): AptSource | null {
  const matched = SOURCE_LINE.exec(line.trim());

  if (!matched) {
    return null;
  }

  const [, url, dist, componentText] = matched;
  const components = componentText.trim().split(/\s+/).filter(Boolean);

  if (components.length === 0) {
    return null;
  }

  return { url: url.replace(/\/+$/, ""), dist, components };
}

/** 拼出某个组件的源码包索引地址。 */
export function sourcesIndexUrl(source: AptSource, component: string): string {
  return `${source.url}/dists/${source.dist}/${component}/source/Sources.gz`;
}

/**
 * 解析 Source 索引文本，取出「软件包名 → 版本」。
 *
 * 索引由空行分隔的段落组成，段落内 `字段: 值` 一行一个。缺 `Package` 或
 * `Version` 的段落直接跳过，不让残缺数据污染结果。
 */
export function parseSourcesIndex(text: string): BaselinePackage[] {
  const packages: BaselinePackage[] = [];

  for (const stanza of text.replace(/\r\n/g, "\n").split("\n\n")) {
    let name = "";
    let version = "";

    for (const line of stanza.split("\n")) {
      if (line.startsWith("Package: ")) {
        name = line.slice("Package: ".length).trim();
      } else if (line.startsWith("Version: ")) {
        version = line.slice("Version: ".length).trim();
      }
    }

    if (name && version) {
      packages.push({ name, version });
    }
  }

  return packages;
}
