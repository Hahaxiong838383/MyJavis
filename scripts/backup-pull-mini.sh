#!/bin/bash
# MyJavis DB 备份异地拉取 —— 主拉方 Mini(launchd com.myjavis.backup-pull,每日 04:40)
# 服务端 47.239 authorized_keys 对 Mini 这把 key 是 restrict+固定命令(tar cf /opt/myjavis/backups):
#   客户端输入完全被忽略 → 拿不到 shell、读不了备份目录以外、写不进任何东西(零参数解析,攻击面最小)。
#   注:不用 rrsync 是因为 macOS 自带 openrsync 客户端语法不被其白名单认(2026-07-07 实测)。
# Air 上另有同名 launchd 任务(scripts/backup-pull.sh,rsync 走全权 key)作双保险。
# canonical 在 MyJavis 仓 scripts/backup-pull-mini.sh,部署位 Mini ~/bin/myjavis-backup-pull.sh。
set -euo pipefail

DEST="$HOME/Backups/myjavis"
LOG="$DEST/pull.log"
mkdir -p "$DEST/db"

{
  echo "$(date '+%F %T') pull start"
  ssh -o BatchMode=yes -o ConnectTimeout=15 root@47.239.204.68 backup | tar xf - -C "$DEST/db/"
  # 本地保留最近 30 份(服务器只滚 7 份;tar 只增不删,故本地可存更久)
  ls -1t "$DEST"/db/*.gz 2>/dev/null | tail -n +31 | xargs rm -f -- 2>/dev/null || true
  echo "$(date '+%F %T') pull OK ($(ls "$DEST/db" | wc -l | tr -d ' ') 份在库)"
  date '+%F %T' > "$DEST/last-success.txt"
  # Kuma push 心跳(待 Codex 交 push URL 后取消注释):
  # curl -fsS -m 10 "https://ops.hahaxiong.top/api/push/<token>" >/dev/null || true
} >> "$LOG" 2>&1
