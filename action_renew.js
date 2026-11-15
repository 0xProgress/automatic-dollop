let chromium;
try {
  ({ chromium } = require("patchright"));
} catch {
  const { chromium: pwChromium } = require("playwright-extra");
  const stealth = require("puppeteer-extra-plugin-stealth")();
  pwChromium.use(stealth);
  chromium = pwChromium;
}
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const http = require("http");
const https = require("https");

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const DEBUG_PORT = 9222;
const USER_DATA_DIR = "/tmp/chrome_user_data";
const LOGIN_URL = "https://dashboard.katabump.com/auth/login";
const DASHBOARD_URL = "https://dashboard.katabump.com/dashboard";
const LOGOUT_URL = "https://dashboard.katabump.com/auth/logout";
process.env.NO_PROXY = "localhost,127.0.0.1";

const WATCHDOG_TIMEOUT_MS =
  parseInt(process.env.WATCHDOG_TIMEOUT_MS, 10) || 12 * 60 * 1000;

let chromeProcess = null;
let browser = null;
let finalExitCode = 0;

const watchdogTimer = setTimeout(() => {
  console.error(
    `\n[${new Date().toISOString()}] [Global] Run exceeded ${WATCHDOG_TIMEOUT_MS / 1000} seconds. Forcing exit.`,
  );
  sendTelegramMessageSync(
    `🚨 <b>Watchdog Timeout</b>\nThe KataBump renewal run exceeded ${WATCHDOG_TIMEOUT_MS / 1000} seconds and was forcefully terminated.`,
  );
  cleanupAndExit(2);
}, WATCHDOG_TIMEOUT_MS);
watchdogTimer.unref();

function log(serverIndex, msg) {
  const prefix =
    serverIndex !== undefined ? `[Server ${serverIndex}]` : "[Global]";
  console.log(`[${new Date().toISOString()}] ${prefix} ${msg}`);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function redactUsername(u) {
  if (!u) return "<unknown>";
  const at = u.indexOf("@");
  return at > 0
    ? u.slice(0, Math.min(3, at)) + "***" + u.slice(at)
    : u.slice(0, 3) + "***";
}

function safeFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9@._-]/g, "_");
}

const SCREENSHOT_DIR = path.join(process.cwd(), "screenshots");
function ensureScreenshotDir() {
  if (!fs.existsSync(SCREENSHOT_DIR))
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return SCREENSHOT_DIR;
}

function sendTelegramMessageSync(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const data = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: "HTML",
  });
  const options = {
    hostname: "api.telegram.org",
    port: 443,
    path: `/bot${TG_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": data.length,
    },
  };
  const req = https.request(options, () => {});
  req.on("error", () => {});
  req.write(data);
  req.end();
}

async function sendTelegramMessage(text, imagePath = null) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }).catch(() => {});
  } catch (e) {}

  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const buf = fs.readFileSync(imagePath);
      const form = new FormData();
      form.append("chat_id", TG_CHAT_ID);
      form.append(
        "photo",
        new Blob([buf], { type: "image/png" }),
        path.basename(imagePath),
      );
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        body: form,
      }).catch(() => {});
    } catch (e) {}
  }
}

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
if (HTTP_PROXY) {
  try {
    const u = new URL(HTTP_PROXY);
    PROXY_CONFIG = {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
    log(
      undefined,
      `Proxy Server=${PROXY_CONFIG.server} Auth=${PROXY_CONFIG.username ? "Yes" : "No"}`,
    );
  } catch {
    log(undefined, "Invalid HTTP_PROXY format.");
    process.exit(1);
  }
}

async function isVisibleWithin(locator, timeoutMs) {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function findSeeLocator(page) {
  for (const fn of [
    () => page.getByRole("link", { name: "See", exact: true }),
    () => page.getByRole("button", { name: "See", exact: true }),
    () => page.locator("a, button").filter({ hasText: /^See$/ }),
  ]) {
    const loc = fn();
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return page.getByRole("link", { name: "See", exact: true });
}

async function waitForDashboard(page, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const url = page.url();
    if (url.includes("/auth/")) return false;
    if (!url.includes("dashboard.katabump.com")) return false;
    const loc = await findSeeLocator(page);
    if ((await loc.count().catch(() => 0)) > 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function checkProxy() {
  if (!PROXY_CONFIG) return true;
  log(undefined, "Validating proxy...");
  try {
    const u = new URL(PROXY_CONFIG.server);
    const cfg = {
      proxy: { protocol: "http", host: u.hostname, port: u.port },
      timeout: 10000,
    };
    if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
      cfg.proxy.auth = {
        username: PROXY_CONFIG.username,
        password: PROXY_CONFIG.password,
      };
    }
    await axios.get("https://www.cloudflare.com/cdn-cgi/trace", cfg);
    log(undefined, "Proxy OK");
    return true;
  } catch (e) {
    log(undefined, `Proxy Failed: ${e.message}`);
    return false;
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/version`, () =>
      resolve(true),
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function launchChrome() {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Chrome not found at ${CHROME_PATH}`);
  }
  if (await checkPort(DEBUG_PORT)) {
    log(undefined, "Chrome already running.");
    return;
  }
  log(undefined, "Launching Chrome...");
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1280,720",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-background-networking",
  ];
  if (PROXY_CONFIG) {
    args.push(`--proxy-server=${PROXY_CONFIG.server}`);
    args.push("--proxy-bypass-list=<-loopback>");
  }
  chromeProcess = spawn(CHROME_PATH, args, { detached: true, stdio: "ignore" });
  chromeProcess.unref();
  for (let i = 0; i < 20; i++) {
    if (await checkPort(DEBUG_PORT)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    chromeProcess.kill("SIGKILL");
  } catch {}
  throw new Error(`Chrome failed to open CDP on port ${DEBUG_PORT}`);
}

function getUsers() {
  try {
    const raw = process.env.USERS_JSON;
    if (!raw) {
      log(undefined, "USERS_JSON not set.");
      return [];
    }
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed.users || [];
    const valid = arr.filter(
      (u) =>
        u &&
        typeof u.username === "string" &&
        u.username.length > 0 &&
        typeof u.password === "string" &&
        u.password.length > 0,
    );
    if (valid.length !== arr.length) {
      log(undefined, `${arr.length - valid.length} malformed user(s) skipped.`);
    }
    return valid;
  } catch (e) {
    log(undefined, `Error parsing USERS_JSON: ${e.message}`);
    return [];
  }
}

async function cdpClick(page, x, y) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  } finally {
    await client.detach().catch(() => {});
  }
}

async function getTurnstileToken(scope) {
  const inputs = scope.locator('[name="cf-turnstile-response"]');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const v = await inputs
      .nth(i)
      .inputValue()
      .catch(() => "");
    if (v && v.length > 20) return v;
  }
  return null;
}

async function findTurnstileIframe(page, scope) {
  const scopes = scope && scope !== page ? [scope, page] : [page];
  const sels = [
    'iframe[id^="cf-chl-widget"]',
    'iframe[src*="challenges.cloudflare.com"]',
  ];
  for (const s of scopes) {
    for (const sel of sels) {
      const loc = s.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.width > 5 && box.height > 5) return { loc, box };
    }
  }
  return null;
}

async function ensureTurnstileSolved(
  page,
  scope = page,
  serverIndex = undefined,
) {
  const hasToken = async () =>
    (await getTurnstileToken(scope)) ||
    (scope !== page ? await getTurnstileToken(page) : null);

  const widgetDeadline = Date.now() + 8000;
  let widgetSeen = false;
  while (Date.now() < widgetDeadline) {
    if (await hasToken()) {
      log(serverIndex, "Turnstile solved automatically.");
      return "solved";
    }
    if (await findTurnstileIframe(page, scope)) {
      widgetSeen = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  if (!widgetSeen) {
    log(serverIndex, "No Turnstile widget present.");
    return "no-widget";
  }

  log(serverIndex, "Widget present; waiting up to 20s for auto-solve...");
  const solveDeadline = Date.now() + 20000;
  while (Date.now() < solveDeadline) {
    if (await hasToken()) {
      log(serverIndex, "Turnstile auto-solved.");
      return "solved";
    }
    await page.waitForTimeout(250);
  }

  const widget = await findTurnstileIframe(page, scope);
  if (!widget) return "no-widget";
  const cx = widget.box.x + 22;
  const cy = widget.box.y + widget.box.height / 2;
  log(
    serverIndex,
    `Clicking Turnstile at (${cx.toFixed(1)}, ${cy.toFixed(1)})...`,
  );
  await cdpClick(page, cx, cy);

  const clickDeadline = Date.now() + 15000;
  while (Date.now() < clickDeadline) {
    if (await hasToken()) {
      log(serverIndex, "Turnstile solved after click.");
      return "solved";
    }
    await page.waitForTimeout(250);
  }
  log(serverIndex, "Turnstile did not solve after click.");
  return "timeout";
}

async function loginToKatabump(page, user) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(
      undefined,
      `Login attempt ${attempt}/2 for ${redactUsername(user.username)}`,
    );
    try {
      if (
        page.url().includes("dashboard") &&
        !page.url().includes("/auth/login")
      ) {
        await page.goto(LOGOUT_URL, { timeout: 15000 }).catch(() => {});
        await page
          .waitForLoadState("domcontentloaded", { timeout: 15000 })
          .catch(() => {});
        await page.waitForTimeout(1000);
      }
      await page.goto(LOGIN_URL, { timeout: 15000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 });

      const emailInput = page.getByRole("textbox", { name: "Email" });
      if (!(await isVisibleWithin(emailInput, 10000))) {
        log(undefined, "Login form not visible; retrying.");
        continue;
      }

      await emailInput.fill(user.username, { timeout: 5000 });
      await page
        .locator('input[type="password"]')
        .fill(user.password, { timeout: 5000 });
      await page.waitForTimeout(500);

      const tsResult = await ensureTurnstileSolved(page, page, undefined);
      if (tsResult === "no-widget") {
        log(undefined, "Widget not found; reloading.");
        await page.reload({ timeout: 15000 }).catch(() => {});
        continue;
      }

      await page
        .getByRole("button", { name: "Login", exact: true })
        .click({ timeout: 5000 });
      await page
        .waitForLoadState("domcontentloaded", { timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(1500);

      const url = page.url();
      if (url.includes("error=captcha")) {
        log(undefined, "Server rejected captcha; retrying.");
        continue;
      }

      if (url.includes("/auth/login")) {
        if (
          await isVisibleWithin(
            page.getByText("Incorrect password or no account"),
            3000,
          )
        ) {
          log(
            undefined,
            `Bad credentials for ${redactUsername(user.username)}`,
          );
          return { status: "bad-creds" };
        }
        log(undefined, "Still on login page after submit; retrying.");
        continue;
      }

      log(undefined, "Logged in successfully.");
      return { status: "ok" };
    } catch (e) {
      log(undefined, `Login attempt error: ${e.message}`);
    }
  }
  return { status: "failed" };
}

async function renewCurrentServer(page, user, serverIndex) {
  let attempts = 0;
  const maxAttempts = 3;
  let modalRetries = 0;
  const maxModalRetries = 2;
  let turnstileRetries = 0;
  const maxTurnstileRetries = 2;

  while (attempts < maxAttempts) {
    attempts++;
    log(serverIndex, `Attempt ${attempts}/${maxAttempts}`);

    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const notYetMatch = bodyText.match(
      /You can't renew your server yet\.\s*You will be able to as of\s+([^(]+)/,
    );
    if (notYetMatch) {
      const dateStr = notYetMatch[1].trim();
      log(serverIndex, `Not renewable until ${dateStr}`);
      return { status: "not-yet", date: dateStr, attempts };
    }

    if (/suspended/i.test(bodyText)) {
      log(serverIndex, "Server appears SUSPENDED");
      return { status: "suspended", attempts };
    }

    const renewBtn = page
      .getByRole("button", { name: "Renew", exact: true })
      .first();
    if (!(await isVisibleWithin(renewBtn, 5000))) {
      if (attempts >= 3) {
        log(serverIndex, "Renew button missing after 3 attempts");
        return {
          status: "missing-renew-btn",
          url: page.url(),
          excerpt: bodyText.slice(0, 200),
          attempts,
        };
      }
      log(serverIndex, "Renew button not found, reloading");
      await page.reload({ timeout: 15000 }).catch(() => {});
      continue;
    }

    await renewBtn.click({ timeout: 5000 }).catch(() => {});
    log(serverIndex, "Renew clicked. Waiting for modal...");

    const modal = page.locator("#renew-modal");
    if (!(await isVisibleWithin(modal, 5000))) {
      modalRetries++;
      if (modalRetries >= maxModalRetries) {
        log(serverIndex, "Modal did not appear after max retries");
        return { status: "modal-missing", attempts };
      }
      log(serverIndex, "Modal did not appear, reloading");
      await page.reload({ timeout: 15000 }).catch(() => {});
      continue;
    }

    const tsResult = await ensureTurnstileSolved(page, modal, serverIndex);
    if (tsResult === "timeout") {
      turnstileRetries++;
      if (turnstileRetries >= maxTurnstileRetries) {
        log(serverIndex, "Turnstile timeout after max retries");
        return { status: "turnstile-timeout", attempts };
      }
      log(serverIndex, "Turnstile timeout, reloading");
      await page.reload({ timeout: 15000 }).catch(() => {});
      continue;
    }

    const confirmBtn = modal.getByRole("button", { name: "Renew" });
    if (!(await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      log(serverIndex, "Confirm button not visible, reloading");
      await page.reload({ timeout: 15000 }).catch(() => {});
      continue;
    }

    log(serverIndex, "Clicking Renew confirm...");
    await confirmBtn.click({ timeout: 5000 }).catch(() => {});

    let outcome = null;
    const checkStart = Date.now();
    while (Date.now() - checkStart < 5000) {
      if (
        await page
          .getByText("Please complete the captcha to continue")
          .isVisible({ timeout: 1000 })
          .catch(() => false)
      ) {
        outcome = "captcha";
        break;
      }
      const notTimeLoc = page.getByText("You can't renew your server yet");
      if (await notTimeLoc.isVisible({ timeout: 1000 }).catch(() => false)) {
        const text = await notTimeLoc.innerText().catch(() => "");
        const m = text.match(/as of\s+(.*?)\s+\(/);
        log(serverIndex, `Not renewable yet: ${m ? m[1] : ""}`);
        outcome = "not-yet";
        break;
      }
      await page.waitForTimeout(500);
    }

    if (outcome === "not-yet") {
      return { status: "not-yet", attempts };
    }
    if (outcome === "captcha") {
      log(serverIndex, "Captcha error after confirm, reloading");
      await page.reload({ timeout: 15000 }).catch(() => {});
      continue;
    }

    await page.waitForTimeout(2000);
    if (!(await modal.isVisible({ timeout: 2000 }).catch(() => false))) {
      log(serverIndex, "Modal closed. Verifying success on dashboard...");
      await page.goto(DASHBOARD_URL, { timeout: 15000 }).catch(() => {});
      await waitForDashboard(page, 10000);

      const dashboardBody = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const expiryMatch =
        dashboardBody.match(
          /(?:expires|valid until|renewal|next billing)[:\s]+([A-Za-z0-9\s,]+)/i,
        ) ||
        dashboardBody.match(/(\d{2}\/\d{2}\/\d{4})/) ||
        dashboardBody.match(/(\d{4}-\d{2}-\d{2})/);
      const expiryText = expiryMatch ? expiryMatch[0].trim() : null;

      return {
        status: expiryText ? "success" : "success-unverified",
        expiry: expiryText,
        attempts,
      };
    }

    log(serverIndex, "Modal still open, no error. Reloading...");
    await page.reload({ timeout: 15000 }).catch(() => {});
  }

  return { status: "exhausted", attempts };
}

async function cleanupAndExit(code) {
  clearTimeout(watchdogTimer);
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  if (chromeProcess) {
    try {
      chromeProcess.kill("SIGKILL");
    } catch {}
  }
  process.exit(code);
}

(async () => {
  const startTime = Date.now();
  const users = getUsers();
  if (users.length === 0) {
    log(undefined, "No valid users. Exiting.");
    await cleanupAndExit(1);
  }
  if (PROXY_CONFIG && !(await checkProxy())) {
    log(undefined, "Invalid proxy. Exiting.");
    await cleanupAndExit(1);
  }

  await launchChrome();
  for (let k = 0; k < 5; k++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
      log(undefined, "Connected to Chrome.");
      break;
    } catch {
      log(undefined, `Connection attempt ${k + 1} failed; retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!browser) {
    log(undefined, "Failed to connect to Chrome. Exiting.");
    await cleanupAndExit(1);
  }

  try {
    const context = browser.contexts()[0];
    let page =
      context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
      await context.setHTTPCredentials({
        username: PROXY_CONFIG.username,
        password: PROXY_CONFIG.password,
      });
    } else {
      await context.setHTTPCredentials(null).catch(() => {});
    }

    const summary = [];
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      log(
        undefined,
        `=== User ${i + 1}/${users.length}: ${redactUsername(user.username)} ===`,
      );

      try {
        if (page.isClosed()) {
          page = await context.newPage();
          page.setDefaultTimeout(60000);
        }

        const login = await loginToKatabump(page, user);
        if (login.status === "bad-creds") {
          const shot = path.join(
            ensureScreenshotDir(),
            `${safeFilename(user.username)}_bad_creds.png`,
          );
          await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
          await sendTelegramMessage(
            `❌ <b>Bad Credentials</b>\nUser: <code>${escapeHtml(user.username)}</code>\nAction: Update USERS_JSON`,
            shot,
          );
          summary.push({
            user: redactUsername(user.username),
            status: "bad-creds",
            servers: [],
          });
          finalExitCode = 1;
          continue;
        }
        if (login.status !== "ok") {
          const shot = path.join(
            ensureScreenshotDir(),
            `${safeFilename(user.username)}_login_failed.png`,
          );
          await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
          await sendTelegramMessage(
            `❌ <b>Login Failed</b>\nUser: <code>${escapeHtml(user.username)}</code>`,
            shot,
          );
          summary.push({
            user: redactUsername(user.username),
            status: "login-failed",
            servers: [],
          });
          finalExitCode = 1;
          continue;
        }

        await page.waitForLoadState("domcontentloaded").catch(() => {});
        const ready = await waitForDashboard(page);
        if (!ready) {
          const body = await page
            .locator("body")
            .innerText()
            .catch(() => "");
          log(undefined, `No servers detected. URL: ${page.url()}`);
          summary.push({
            user: redactUsername(user.username),
            status: "no-servers",
            servers: [],
          });
          continue;
        }

        const seeLinks = await findSeeLocator(page);
        const serverCount = await seeLinks.count();
        log(undefined, `Found ${serverCount} server(s).`);

        const serverResults = [];
        for (let s = 0; s < serverCount; s++) {
          if (s > 0) {
            await page.goto(DASHBOARD_URL, { timeout: 15000 }).catch(() => {});
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await waitForDashboard(page, 10000);
          }

          try {
            const fresh = await findSeeLocator(page);
            await fresh.nth(s).click({ timeout: 5000 });
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await page.waitForTimeout(1000);
          } catch (e) {
            log(s + 1, `Could not open server: ${e.message}`);
            serverResults.push({
              index: s + 1,
              result: "open-failed",
              attempts: 1,
            });
            continue;
          }

          const serverBody = await page
            .locator("body")
            .innerText()
            .catch(() => "");
          const expiryMatchBefore =
            serverBody.match(
              /(?:expires|valid until|renewal|next billing)[:\s]+([A-Za-z0-9\s,]+)/i,
            ) ||
            serverBody.match(/(\d{2}\/\d{2}\/\d{4})/) ||
            serverBody.match(/(\d{4}-\d{2}-\d{2})/);
          const expiryBefore = expiryMatchBefore
            ? expiryMatchBefore[0].trim()
            : null;

          const result = await renewCurrentServer(page, user, s + 1);

          if (result.status === "suspended") {
            const shot = path.join(
              ensureScreenshotDir(),
              `${safeFilename(user.username)}_s${s + 1}_suspended.png`,
            );
            await page
              .screenshot({ path: shot, fullPage: true })
              .catch(() => {});
            await sendTelegramMessage(
              `🚨 <b>SUSPENDED</b>\nUser: <code>${escapeHtml(user.username)}</code>\nServer ${s + 1} — renew manually NOW.`,
              shot,
            );
            finalExitCode = 1;
          } else if (
            result.status === "captcha-exhausted" ||
            result.status === "missing-renew-btn" ||
            result.status === "modal-missing" ||
            result.status === "turnstile-timeout"
          ) {
            const shot = path.join(
              ensureScreenshotDir(),
              `${safeFilename(user.username)}_s${s + 1}_${result.status}.png`,
            );
            await page
              .screenshot({ path: shot, fullPage: true })
              .catch(() => {});
            await sendTelegramMessage(
              `⚠️ <b>Server Action Failed</b>\nUser: <code>${escapeHtml(user.username)}</code>\nServer ${s + 1}\nReason: ${result.status}\nURL: ${result.url || "N/A"}`,
              shot,
            );
            finalExitCode = 1;
          }

          serverResults.push({
            index: s + 1,
            result: result.status,
            attempts: result.attempts,
            expiryBefore,
            expiryAfter: result.expiry || null,
          });
        }
        summary.push({
          user: redactUsername(user.username),
          status: "processed",
          servers: serverResults,
        });
      } catch (err) {
        log(
          undefined,
          `Error processing user ${redactUsername(user.username)}: ${err.message}`,
        );
        summary.push({
          user: redactUsername(user.username),
          status: `error:${err.message}`,
          servers: [],
        });
        finalExitCode = 1;
      } finally {
        try {
          if (page && !page.isClosed()) {
            await page
              .screenshot({
                path: path.join(
                  ensureScreenshotDir(),
                  `${safeFilename(user.username)}_final.png`,
                ),
                fullPage: true,
              })
              .catch(() => {});
          }
        } catch {}
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    let runUrl = "";
    if (
      process.env.GITHUB_SERVER_URL &&
      process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_RUN_ID
    ) {
      runUrl = `\nRun: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    }

    let text = `<b>KataBump Renewal Summary</b>\nDuration: ${duration}s${runUrl}\n\n`;
    for (const userSummary of summary) {
      text += `<b>User:</b> <code>${escapeHtml(userSummary.user)}</code>\n`;
      if (userSummary.status === "bad-creds") {
        text += `  Result: Bad credentials\n`;
      } else if (userSummary.status === "login-failed") {
        text += `  Result: Login failed\n`;
      } else if (userSummary.status === "no-servers") {
        text += `  Result: No servers detected\n`;
      } else {
        for (const srv of userSummary.servers) {
          text += `  Server ${srv.index}: ${escapeHtml(srv.result)}`;
          if (srv.attempts) text += ` (${srv.attempts} attempts)`;
          if (srv.expiryBefore)
            text += `\n    Before: ${escapeHtml(srv.expiryBefore)}`;
          if (srv.expiryAfter)
            text += `\n    After: ${escapeHtml(srv.expiryAfter)}`;
          text += `\n`;
        }
      }
      text += `\n`;
    }

    await sendTelegramMessage(text);
    log(undefined, "All users processed.");
  } finally {
    await cleanupAndExit(finalExitCode);
  }
})();
