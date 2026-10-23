#!/usr/bin/env bash
# Miubot 数据目录备份。
#
# ⚠️ 备份内容里有 config.json（QQ AppSecret 与各 Provider apiKey **明文**）、
#    api-token、admin-password（口令散列）、admin-sessions.json 与全部会话记录。
#    备份文件的保护级别必须与数据目录一致；出机器前建议再加密一层（age / gpg）。
#
# 用法：
#   MIUBOT_DATA_DIR=/var/lib/miubot ./deploy/backup.sh
#   crontab: 17 4 * * * MIUBOT_DATA_DIR=/var/lib/miubot /opt/miubot/deploy/backup.sh
#
# 恢复：停服务 → 解包回数据目录 → chmod 700 目录 / 600 文件 → 起服务。
# 旧浏览器 Cookie 在恢复后依然有效，必要时同时改口令并轮换令牌。

set -euo pipefail

DATA_DIR="${MIUBOT_DATA_DIR:-/var/lib/miubot}"
BACKUP_DIR="${MIUBOT_BACKUP_DIR:-/var/backups/miubot}"
KEEP_DAYS="${MIUBOT_BACKUP_KEEP_DAYS:-14}"

if [ ! -d "$DATA_DIR" ]; then
  echo "数据目录不存在：$DATA_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date +%F)"
target="$BACKUP_DIR/miubot-$stamp.tar.gz"

# -C 到父目录再打包末级目录：恢复时解到 /var/lib 即可还原目录名。
tar czf "$target" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
chmod 600 "$target"

# 轮转：只保留最近 KEEP_DAYS 天。
find "$BACKUP_DIR" -name 'miubot-*.tar.gz' -type f -mtime "+$KEEP_DAYS" -delete

echo "备份完成：$target"
