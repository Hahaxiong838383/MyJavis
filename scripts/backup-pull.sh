#!/bin/bash
# MyJavis DB 备份异地拉取 —— 跑在川哥 Air(launchd com.myjavis.backup-pull,每日 04:40,睡眠错过则唤醒补跑)
# 源: 47.239 /opt/myjavis/backups/ (服务器 cron 4:10 backup-db.sh 生成,本机滚动 7 份)
# 目的: ~/.mycc-global/backups/myjavis/db/ 本地保留 30 份(比服务器久,防整机故障)
# 监控: 成功刷新 last-success.txt;告警兜底(Uptime Kuma push)待接,见 HANDOFF
set -euo pipefail

DEST="$HOME/.mycc-global/backups/myjavis"
LOG="$DEST/pull.log"
mkdir -p "$DEST/db"

{
  echo "$(date '+%F %T') pull start"
  rsync -az --timeout=90 \
    -e "ssh -i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15" \
    root@47.239.204.68:/opt/myjavis/backups/ "$DEST/db/"
  # 本地保留最近 30 份(服务器只滚 7 份;rsync 不带 --delete,故本地可存更久)
  ls -1t "$DEST"/db/*.gz 2>/dev/null | tail -n +31 | xargs rm -f -- 2>/dev/null || true
  echo "$(date '+%F %T') pull OK ($(ls "$DEST/db" | wc -l | tr -d ' ') 份在库)"
  date '+%F %T' > "$DEST/last-success.txt"
} >> "$LOG" 2>&1
