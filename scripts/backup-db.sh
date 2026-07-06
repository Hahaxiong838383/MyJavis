#!/usr/bin/env bash
# MyJavis SQLite 每日备份(在线安全备份,WAL 兼容),保留 7 天
set -e
TS=$(date +%Y%m%d)
sqlite3 /opt/myjavis/data/myjavis-memory.db ".backup /opt/myjavis/backups/myjavis-memory-$TS.db"
gzip -f /opt/myjavis/backups/myjavis-memory-$TS.db
ls -t /opt/myjavis/backups/myjavis-memory-*.db.gz | tail -n +8 | xargs -r rm
