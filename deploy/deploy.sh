#!/bin/zsh
# 部署到 EC2：打包前端、上傳前端和伺服器程式、重啟服務
# 用法：deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=ubuntu@13.231.218.149
KEY=~/.ssh/stock-key
SSH=(ssh -i $KEY -o BatchMode=yes $HOST)

echo "▶ 打包前端"
npm run build

echo "▶ 上傳前端 → /var/www/pixel-arena"
rsync -az --delete -e "ssh -i $KEY" dist/client/ $HOST:/var/www/pixel-arena/

echo "▶ 上傳伺服器程式 → ~/pixel-arena"
rsync -az --delete -e "ssh -i $KEY" \
  --include='src/***' --include='package.json' --include='package-lock.json' --exclude='*' \
  ./ $HOST:pixel-arena/

echo "▶ 安裝伺服器套件、重啟服務"
$SSH 'cd ~/pixel-arena && npm ci --omit=dev --no-audit --no-fund && sudo systemctl restart pixel-arena && sleep 2 && systemctl is-active pixel-arena'

echo "✅ 完成：https://arena.holin.cc/"
