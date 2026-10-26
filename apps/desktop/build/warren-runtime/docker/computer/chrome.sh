#!/bin/sh
# Google Chrome the way Warren's VMs run it, however it's opened (the dock, a link, an agent):
#   --no-sandbox     containers don't give Chrome user namespaces; --test-type hides the bar about it
#   a profile of its own, because Chrome refuses its debugging port on the default profile; the
#   port listens only inside the VM, for the agents' browser tools (Playwright MCP)
#   maximized, so agents and people see the whole page above the dock
exec /opt/google/chrome/google-chrome \
  --no-sandbox --test-type --no-first-run --no-default-browser-check --password-store=basic \
  --start-maximized --user-data-dir=/home/warren/.config/warren-browser \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "$@"
