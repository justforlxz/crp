#!/usr/bin/env bash
#
# 在门禁镜像里跑样式检查（A20）。
#
# 为什么必须进容器：L2 的几何与 L3 的整页截图对字体敏感。换一套字体，软件包表格从 740px 变成
# 490px、工作台整页从 1740px 变成 1718px —— 那不是样式坏了，是环境不同。基线是在
# `mcr.microsoft.com/playwright:v1.65.1-noble` 里生成的，CI 也在同一个镜像里比对，本地要跟基线
# 对得上就得进同一个镜像。
#
# 用法（在仓库根，Linux 上执行）：
#
#   scripts/style-check/container.sh            # 比对
#   scripts/style-check/container.sh --update   # 重写基线（CI 里会被脚本自己拒绝）
#
# 前置条件：
#   - 本机装了 docker，能拉 `mcr.microsoft.com/playwright:v1.65.1-noble`；
#   - 有一个可连的库：`DATABASE_URL` 或仓库根的 `.env` 里那一行指向它，且已经 `pnpm db:migrate`
#     与 `pnpm db:seed`；
#   - 库里只有种子数据。跑过 `pnpm test` 的库会多出构建轮询事件，构建队列页会多出一张调度
#     事件表，基线比对就会报差异 —— 先用 `pnpm db:reset` 把库退回种子状态再跑。
#
# `--network host` 让容器直连本机的数据库；容器的 `node_modules` 挂在独立目录里，不覆盖本机那份。

set -euo pipefail

image="mcr.microsoft.com/playwright:v1.65.1-noble"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/crp-style-node-modules"

database_url="${DATABASE_URL:-}"
if [ -z "$database_url" ] && [ -f "$repo/.env" ]; then
  database_url="$(grep -E '^DATABASE_URL=' "$repo/.env" | tail -n 1 | cut -d= -f2- | tr -d '"')"
fi

if [ -z "$database_url" ]; then
  echo "缺少数据库连接串：设置 DATABASE_URL，或在 $repo/.env 里写一行 DATABASE_URL=…" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "找不到 docker：样式检查要在门禁镜像里跑，见 docs/STYLE-VERIFICATION.md 的「运行环境」。" >&2
  exit 2
fi

# pnpm 版本只认 package.json 的 packageManager，不在脚本里再写一份。
pnpm_version="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$repo/package.json" | head -n 1)"
if [ -z "$pnpm_version" ]; then
  echo "读不到 package.json 的 packageManager，无法确定 pnpm 版本" >&2
  exit 2
fi

mkdir -p "$cache"

# 容器里以 root 跑（要装全局 pnpm），`--update` 写出来的基线文件会变成 root 所有；
# `next build` 产出的 `.next/` 与 `next-env.d.ts` 也一样。这些都要交还给调用者：
# 留着 root 所有的 `.next/`，调用者下一次 `next build` 会直接失败
# （`EACCES: permission denied, open '.next/trace'` / `Build directory is not writeable`），
# 而普通用户没有 sudo 时连删都删不掉。

# 取样状态必须由门禁自己固定，不能由操作者机器上的 `.env` 决定。
# 仓库根一起挂进容器，Next 会自己加载 `/work/.env`：配了 CRP / Gerrit 凭据时，提测详情页
# 会多出「提交信息 / 工作流进度」那一段，整段下压 12.4px，基线就对不上（CI 没有这些凭据，
# 所以 CI 一直是绿的，而按 §3.3 配好凭据的人必然失败）。这里用一份**只含 DATABASE_URL** 的
# 文件只读盖住 `.env`，让取样结果与操作者有没有配业务凭据无关。
sampling_env="$cache/sampling.env"
printf 'DATABASE_URL="%s"\n' "$database_url" > "$sampling_env"
chmod 600 "$sampling_env"

# `scripts/style-check/index.ts` 文档化的 CRP_STYLE_* 开关按原样透传给容器；
# 业务凭据（CRP_* / GERRIT_* / SHUTTLE_* 的非 CRP_STYLE_ 变量）不在此列。
style_env=()
while IFS= read -r name; do
  if [ -n "$name" ]; then
    style_env+=( -e "$name=${!name}" )
  fi
done < <(compgen -e | grep -E '^CRP_STYLE_' || true)

docker run --rm --network host \
  -v "$repo":/work \
  -v "$sampling_env":/work/.env:ro \
  -v "$cache":/work/node_modules \
  -w /work \
  -e "DATABASE_URL=$database_url" \
  -e "STYLE_ARGS=$*" \
  -e "PNPM_VERSION=$pnpm_version" \
  -e "HOST_UID=$(id -u)" \
  -e "HOST_GID=$(id -g)" \
  -e NEXT_TELEMETRY_DISABLED=1 \
  ${style_env[@]+"${style_env[@]}"} \
  "$image" \
  bash -lc '
    npm i -g "pnpm@$PNPM_VERSION" >/dev/null 2>&1
    pnpm install --frozen-lockfile >/dev/null 2>&1 || exit 1
    # 种子脚本会核对每张表的记录数与它声明的一致：跑过 pnpm test 的库会多出构建轮询事件，
    # 构建队列页多一张调度事件表，比对必然失败。这里先挡一道，把「环境不对」与「样式坏了」分开。
    if ! pnpm db:seed >/dev/null 2>&1; then
      echo "库里的数据与种子声明不一致：先跑 pnpm db:reset 把库退回种子状态再重试。" >&2
      exit 2
    fi
    pnpm test:style $STYLE_ARGS
    status=$?
    # `pnpm install` 的 postinstall 会以 root 跑 `prisma generate` 写 /work/generated：
    # 不交还所有权，调用者下一次 `prisma generate` 会 EACCES。
    chown -R "$HOST_UID:$HOST_GID" /work/tests/visual /work/.next /work/generated 2>/dev/null || true
    chown "$HOST_UID:$HOST_GID" /work/next-env.d.ts 2>/dev/null || true
    exit $status
  '
