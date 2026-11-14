#!/usr/bin/env node
/**
 * Screenshot the running dsh-hydro panel through headless Chrome (CDP).
 *
 * Usage:
 *   node test/client/screenshot.mjs <page-url> <out-dir>
 *
 * Produces light full-page screenshots (plugin + DSH sidebar): overview,
 * site-accounts, services (pm2), and one per embedded/troubleshooting page.
 * carries the login token (open the URL once is not needed: the token query
 * authenticates the page load). Used for manual visual review; never part of
 * `npm test`.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import WebSocket from 'ws'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const url = process.argv[2]
const outDir = resolve(process.argv[3] ?? 'screenshots')
const captureUpgrade = process.argv.includes('--upgrade')
if (!url) {
  console.error('usage: node test/client/screenshot.mjs <page-url> [out-dir]')
  process.exit(2)
}
const port = 9333
const userDataDir = `/tmp/dsh-hydro-chrome-${String(process.pid)}`
await mkdir(outDir, { recursive: true })
await mkdir(userDataDir, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${String(port)}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--lang=zh-CN',
  '--accept-lang=zh-CN',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1440,960',
  url,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page
    } catch {
      // chrome still starting
    }
    await sleep(500)
  }
  throw new Error('Chrome DevTools page target not found')
}

const target = await pageTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
await new Promise((resolveReady, rejectReady) => {
  ws.once('open', resolveReady)
  ws.once('error', rejectReady)
})
let nextId = 1
const pending = new Map()
ws.on('message', (data) => {
  const message = JSON.parse(data.toString())
  if (message.method === 'Page.javascriptDialogOpening') {
    void send('Page.handleJavaScriptDialog', { accept: true })
    return
  }
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolveSend, rejectSend) => {
    pending.set(id, { resolve: resolveSend, reject: rejectSend })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.value
}
async function screenshot(name) {
  // Full-page capture: include the DSH conversation sidebar as well as the
  // plugin panel, matching the product's real layout.
  await evaluate("document.body.removeAttribute('data-ds-dark-theme'); true")
  // Documentation screenshots must not leak the real test-host identity.
  await evaluate(`(() => {
    const replacements = [
      [/10\\.0\\.0\\.99/g, '203.0.113.10'],
      [/PVE LXC \\(persistent\\)/g, 'Demo LXC'],
      [/PVE LXC/g, 'Demo LXC'],
      [/dsh-hydro E2E/g, 'Demo Site'],
      [/dsh-hydro-test/g, 'demo-host'],
    ]
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) !== null) {
      let text = node.nodeValue ?? ''
      for (const [pattern, value] of replacements) text = text.replace(pattern, value)
      if (text !== node.nodeValue) node.nodeValue = text
    }
    return true
  })()`)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outDir, name)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  console.log(`wrote ${path}`)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })

// Wait for the DSH shell + the Hydro panel to render.
let ready = false
for (let attempt = 0; attempt < 60; attempt++) {
  await sleep(500)
  const text = await evaluate('document.body ? document.body.innerText : ""')
  if (typeof text === 'string' && (text.includes('Hydro') || text.includes('主机') || text.includes('Hosts'))) {
    ready = true
    break
  }
}
if (!ready) console.warn('panel text not detected; capturing anyway')
// The shell starts on the New Session landing page; open the Hydro panel from
// the sidebar (or the shell's main navigation) before waiting for its status.
await evaluate(`(() => {
  const nodes = Array.from(document.querySelectorAll('button,a,[role=button]'))
  const hit = nodes.find(node => /^\s*Hydro\s*$/.test((node.textContent || '').trim()))
    ?? nodes.find(node => /Hydro|主机|Hosts/.test(node.textContent || ''))
  hit?.click()
  return Boolean(hit)
})()`)
await sleep(1500)
// Dismiss the preview-notice modal some hosts show on first launch.
for (let attempt = 0; attempt < 6; attempt++) {
  const clicked = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find(entry => /^(Continue|继续)$/.test((entry.textContent || '').trim()))
    button?.click()
    return Boolean(button)
  })()`)
  if (clicked === true) break
  await sleep(500)
}
// Make sure a host is active so the overview page has data: if the top-right
// host switcher (first <select>) is empty, pick its first real option.
await evaluate(`(() => {
  const root = document.querySelector('[data-hydro-console]')
  const select = root ? root.querySelector('select') : null
  if (!select || select.value !== '' || select.options.length < 2) return false
  select.value = select.options[1].value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(800)
// The overview page auto-collects status; wait for the status card to settle so
// the screenshot shows the real data instead of only the loading state.
for (let attempt = 0; attempt < 90; attempt++) {
  const text = await evaluate('document.body ? document.body.innerText : ""')
  if (typeof text === 'string' && (text.includes('采集于') || text.includes('collected at') || text.includes('未安装 Hydro') || text.includes('Hydro not installed'))) break
  await sleep(500)
}
// Pick a site account before the first screenshot so the header shows the real
// account instead of the loading placeholder.
await evaluate(`(() => {
  const root = document.querySelector('[data-hydro-console]')
  const select = root ? root.querySelectorAll('select')[1] : null
  if (!select || select.value !== '' || select.options.length < 2) return false
  select.value = select.options[1].value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(800)
// Open the Hydro main panel if the shell landed on a different one. Layout v2
// uses a hierarchical menu (`[data-page]`) instead of tabs.
await evaluate(`(() => {
  const item = document.querySelector('[data-page="ops/overview"]')
    ?? Array.from(document.querySelectorAll('button')).find(label => /概览|Overview/.test(label.textContent || ''))
  item?.click()
  return Boolean(item)
})()`)
// Screenshot-only conversation titles for supported capabilities. These are
// injected into the sidebar tree at capture time; no app state is written.
await evaluate(`(() => {
  const tree = document.querySelector('[role="tree"][aria-label="会话"]') ?? document.querySelector('[role="tree"][aria-label="Sessions"]')
  const row = tree ? tree.querySelector('[data-row-key^="session:"]') : null
  const parent = row ? row.parentElement : null
  if (!tree || !row || !parent) return false
  const titles = [
    '排查 Hydro 启动失败',
    '写比赛公告',
    '给题目加测试数据',
    '修改题面',
    '升级 Hydro 包',
    '回复社区讨论',
    '配置 Caddy',
  ]
  for (const title of titles) {
    const clone = row.cloneNode(true)
    clone.classList.remove('JoiKIa_selected')
    clone.setAttribute('aria-selected', 'false')
    clone.setAttribute('data-row-key', 'session:mock-' + title)
    const label = clone.querySelector('[class*="_title"]')
    if (label) label.textContent = title
    parent.appendChild(clone)
  }
  return true
})()`)
await evaluate("document.body.removeAttribute('data-ds-dark-theme'); true")
// Let the 5s metrics poll collect a second sample so the sparklines render.
await sleep(6500)
await screenshot('light.png')

if (captureUpgrade) {
  // Screenshot helper only: accept the confirmation dialog deterministically.
  await evaluate('window.confirm = () => true; true')
  const clicked = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const target = buttons.find(button => /Run upgrade|执行升级|立即升级|Upgrade now/i.test(button.textContent || ''))
    if (target) {
      target.scrollIntoView({ block: 'center' })
      target.click()
    }
    return Boolean(target)
  })()`)
  if (clicked === true) {
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(500)
      const text = await evaluate('document.body ? document.body.innerText : ""')
      if (typeof text === 'string' && (text.includes('Completed') || text.includes('已完成') || text.includes('Failed') || text.includes('失败'))) break
    }
    await sleep(800)
    // Bring the terminal card into view (the panel has its own scroll surface).
    await evaluate(`(() => {
      for (const element of document.querySelectorAll('*')) {
        if (element.scrollHeight > element.clientHeight + 20) element.scrollTop = element.scrollHeight
      }
      const target = Array.from(document.querySelectorAll('*'))
        .find(node => /Terminal|终端|Completed|已完成|Failed|失败/.test(node.textContent || '') && node.children.length === 0)
      target?.scrollIntoView({ block: 'center' })
      return true
    })()`)
    await sleep(600)
    await screenshot('upgrade-terminal.png')
  } else {
    console.warn('upgrade button not found; skipping terminal screenshot')
  }
}

// Pick a site account in the top-right switcher when one exists and none is
// active yet (the second header <select>).
await evaluate(`(() => {
  const root = document.querySelector('[data-hydro-console]')
  const selects = root ? Array.from(root.querySelectorAll('select')) : []
  const select = selects[1]
  if (!select || select.value !== '' || select.options.length < 2) return false
  select.value = select.options[1].value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(500)
// Switch to Settings → Hydro accounts (left menu, layout v3).
await evaluate(`(() => {
  const item = document.querySelector('[data-page="settings/site-accounts"]')
    ?? Array.from(document.querySelectorAll('button')).find(label => /站点账号|Site accounts/.test(label.textContent || ''))
  item?.click()
  return Boolean(item)
})()`)
for (let attempt = 0; attempt < 40; attempt++) {
  await sleep(500)
  const text = await evaluate('document.body ? document.body.innerText : ""')
  if (typeof text === 'string' && (/keep several Hydro web accounts|每个主机可以有多个 Hydro Web 账号/.test(text))) break
}
await sleep(800)
await screenshot('site-accounts.png')

// Capture the services page (visual pm2 monitor).
await evaluate(`(() => {
  const item = document.querySelector('[data-page="ops/services"]')
    ?? Array.from(document.querySelectorAll('button')).find(label => /服务|Services/.test(label.textContent || ''))
  item?.click()
  return Boolean(item)
})()`)
for (let attempt = 0; attempt < 40; attempt++) {
  await sleep(500)
  const text = await evaluate('document.body ? document.body.innerText : ""')
  if (typeof text === 'string' && (text.includes('Processes') || text.includes('进程'))) break
}
await sleep(800)
await screenshot('services.png')

// Open the first process log viewer on the services page (cheap extra shot).
await evaluate(`(() => {
  const root = document.querySelector('[data-hydro-console]')
  const button = root ? Array.from(root.querySelectorAll('button')).find(entry => /^(日志|Logs)$/.test((entry.textContent || '').trim())) : null
  button?.click()
  return Boolean(button)
})()`)
await sleep(1500)
await screenshot('services-logs.png')

// Capture the embedded Hydro pages (header/hint at minimum; iframes may stay
// blank in headless when the remote GUI is not reachable).
async function capturePage(pageId, labelPattern) {
  await evaluate(`(() => {
    const item = document.querySelector('[data-page="${pageId}"]')
      ?? Array.from(document.querySelectorAll('button')).find(label => ${labelPattern}.test(label.textContent || ''))
    item?.click()
    return Boolean(item)
  })()`)
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(400)
    const current = await evaluate(`document.querySelector('[data-page="${pageId}"][aria-current="page"]') !== null`)
    if (current === true) break
  }
  await sleep(900)
  await screenshot(`${pageId.replace('/', '-')}.png`)
}

await capturePage('site/domain', /域管理|Domains/)
await capturePage('site/problems', /题目|Problems/)
await capturePage('site/contests', /比赛|Contests/)
await capturePage('site/community', /社区互动|Community/)
// Select the first discussion so the community shot shows its domain/source/
// author metadata and the "open in embedded browser" action.
await evaluate(`(() => {
  const root = document.querySelector('[data-hydro-console]')
  const row = root ? Array.from(root.querySelectorAll('button')).find(button => button.querySelector('strong')) : null
  row?.click()
  return Boolean(row)
})()`)
await sleep(1800)
await screenshot('site-community.png')
await capturePage('ops/plugins', /插件|Plugins/)
await capturePage('ops/caddy', /Caddy/)
await capturePage('ops/cli', /Hydro CLI/)
await capturePage('ops/troubleshoot', /智能排障|Troubleshoot/)

// MongoDB page → oplog tab (the standalone Oplog menu entry is gone).
await capturePage('ops/mongodb', /MongoDB/)
await evaluate(`(() => {
  const root = document.querySelector('[data-hydro-console]')
  const button = root ? Array.from(root.querySelectorAll('button')).find(entry => /^(日志|Oplog)$/.test((entry.textContent || '').trim())) : null
  button?.click()
  return Boolean(button)
})()`)
for (let attempt = 0; attempt < 40; attempt++) {
  await sleep(500)
  const text = await evaluate('document.body ? document.body.innerText : ""')
  if (typeof text === 'string' && (/Audit log|审计日志|Hydro audit|来源|Source/.test(text))) break
}
await sleep(800)
await screenshot('oplog.png')

await send('Browser.close').catch(() => undefined)
ws.close()
chrome.kill('SIGTERM')
console.log('done')
process.exit(0)
