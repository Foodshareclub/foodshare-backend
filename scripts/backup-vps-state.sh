#!/usr/bin/env bash
# Manual VPS backup — delegates to deploy.sh
set -euo pipefail
exec "$(dirname "$0")/deploy.sh" backup --daily "$@"
