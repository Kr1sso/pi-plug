#!/usr/bin/env bash
# pi-plug install script
# - Ensures qmd is installed globally
# - Idempotent; safe to re-run
set -euo pipefail

note() { printf "\033[1;36m[pi-plug]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[pi-plug]\033[0m %s\n" "$*" >&2; }

# 1. qmd
if command -v qmd >/dev/null 2>&1; then
  note "qmd already installed: $(qmd --version 2>/dev/null || echo 'unknown')"
else
  note "Installing qmd globally (npm i -g @tobilu/qmd)..."
  if command -v npm >/dev/null 2>&1; then
    npm install -g @tobilu/qmd || warn "qmd install failed — wiki search will be degraded. Install manually: npm i -g @tobilu/qmd"
  else
    warn "npm not found; cannot install qmd. Install Node + npm, then: npm i -g @tobilu/qmd"
  fi
fi

# 2. Per-project wiki bootstrap is handled at runtime by the extension
#    (it scans the project on first run and tailors the schema). Nothing to do here.

note "pi-plug install complete."
note "Add to a project's .pi/settings.json (or install globally with: pi install git:github.com/Kr1sso/pi-plug)."
