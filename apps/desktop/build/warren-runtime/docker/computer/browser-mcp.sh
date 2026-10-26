#!/bin/sh
# Playwright MCP on the desktop's own Chrome (the one people watch, with its sign-ins), started
# first if it isn't running. Warren hands this to agents as their browser tools.
export DISPLAY=:1
up() { curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; }
if ! up; then
  nohup google-chrome about:blank >/tmp/chrome.log 2>&1 &
  for _ in $(seq 1 150); do up && break; sleep 0.1; done
fi
exec playwright-mcp --cdp-endpoint http://127.0.0.1:9222 "$@"
