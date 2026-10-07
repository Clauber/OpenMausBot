#!/bin/bash
# stealth-pw — Playwright CLI wrapper that connects to the stealth browser
#
# Usage:
#   stealth-pw screenshot https://example.com output.png [--full-page]
#   stealth-pw pdf https://example.com output.pdf [--paper-format A4]
#   stealth-pw eval https://example.com "document.title"
#   stealth-pw cdp-url [--route direct|vpn|residential]
#
# All commands connect to the running stealth browser service (with all
# evasions active: fingerprint injection, canvas/WebGL noise, WebRTC
# leak prevention, human-like behavior, etc.)

set -euo pipefail

STEALTH_URL="${CAMOFOX_URL:-http://localhost:9377}"

get_cdp_url() {
  local route="${1:-direct}"
  local response
  response=$(curl -sf "${STEALTH_URL}/cdp-url" 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo "Error: stealth browser not running or CDP not available" >&2
    echo "Make sure the stealth browser service is running at ${STEALTH_URL}" >&2
    exit 1
  fi
  echo "$response" | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    const url = data.endpoints?.['${route}'] || data.endpoints?.direct;
    if (!url) { console.error('No CDP endpoint for route: ${route}'); process.exit(1); }
    process.stdout.write(url);
  "
}

case "${1:-help}" in
  screenshot)
    shift
    if [ $# -lt 2 ]; then
      echo "Usage: stealth-pw screenshot <url> <output.png> [playwright options...]" >&2
      exit 1
    fi
    url="$1"; output="$2"; shift 2
    ws=$(get_cdp_url)
    node -e "
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.connect('${ws}');
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const fullPage = ${[[ " $* " == *"--full-page"* ]] && echo "true" || echo "false"};
        await page.screenshot({ path: '${output}', fullPage });
        await ctx.close();
        console.log('Screenshot saved to ${output}');
      })().catch(e => { console.error(e.message); process.exit(1); });
    "
    ;;

  pdf)
    shift
    if [ $# -lt 2 ]; then
      echo "Usage: stealth-pw pdf <url> <output.pdf> [playwright options...]" >&2
      exit 1
    fi
    url="$1"; output="$2"; shift 2
    ws=$(get_cdp_url)
    node -e "
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.connect('${ws}');
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto('${url}', { waitUntil: 'networkidle', timeout: 30000 });
        await page.pdf({ path: '${output}', format: 'A4' });
        await ctx.close();
        console.log('PDF saved to ${output}');
      })().catch(e => { console.error(e.message); process.exit(1); });
    "
    ;;

  eval)
    shift
    if [ $# -lt 2 ]; then
      echo "Usage: stealth-pw eval <url> <js-expression>" >&2
      exit 1
    fi
    url="$1"; expr="$2"; shift 2
    ws=$(get_cdp_url)
    node -e "
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.connect('${ws}');
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const result = await page.evaluate(() => { return ${expr}; });
        console.log(JSON.stringify(result, null, 2));
        await ctx.close();
      })().catch(e => { console.error(e.message); process.exit(1); });
    "
    ;;

  cdp-url)
    shift
    route="${1:-direct}"
    get_cdp_url "$route"
    echo
    ;;

  help|--help|-h)
    echo "stealth-pw — Playwright CLI wrapper connected to stealth browser"
    echo ""
    echo "Commands:"
    echo "  screenshot <url> <file.png> [--full-page]   Capture page screenshot"
    echo "  pdf <url> <file.pdf>                        Save page as PDF"
    echo "  eval <url> <js-expression>                  Evaluate JS on page"
    echo "  cdp-url [route]                             Get CDP WebSocket URL"
    echo ""
    echo "All commands use the stealth browser's evasions (fingerprint, canvas noise, etc.)"
    echo "Routes: direct (default), vpn, residential"
    ;;

  *)
    echo "Unknown command: $1. Run 'stealth-pw help' for usage." >&2
    exit 1
    ;;
esac
