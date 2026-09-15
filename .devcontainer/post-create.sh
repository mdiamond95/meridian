#!/usr/bin/env bash
# Installs both projects plus the tools the pipeline shells out to.
set -euo pipefail

UV_VERSION=0.12.13
MAPSHAPER_VERSION=0.7.61

echo "→ Claude Code config volume (Docker creates it root-owned)"
sudo chown -R "$(id -u):$(id -g)" /home/vscode/.claude

echo "→ git hooks (secret scan on commit)"
git config core.hooksPath .githooks

echo "→ uv ${UV_VERSION}"
curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh
export PATH="$HOME/.local/bin:$PATH"

echo "→ mapshaper ${MAPSHAPER_VERSION}"
npm install -g "mapshaper@${MAPSHAPER_VERSION}"

echo "→ app (npm ci + Playwright Chromium)"
npm ci
npx -w app playwright install --with-deps chromium

echo "→ pipeline (uv sync)"
make install

echo "Ready: npm test · npm run build · npm run smoke · make dry-run"
