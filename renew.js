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
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9222;
const USER_DATA_DIR = path.join(__dirname, "ChromeData_Katabump");
const LOGIN_URL = "https://dashboard.katabump.com/auth/login";
const DASHBOARD_URL = "https://dashboard.katabump.com/dashboard";
const LOGOUT_URL = "https://dashboard.katabump.com/auth/logout";

const WATCHDOG_TIMEOUT_MS =
  parseInt(process.env.WATCHDOG_TIMEOUT_MS, 10) || 12 * 60 * 1000;

const RENEW_OUTCOME_TIMEOUT_MS = 60000;

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

const PHOTO_DIR = path.join(__dirname, "photo");
function ensurePhotoDir() {
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });
  return PHOTO_DIR;
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
      serverWithAuth: u.username
        ? `${u.protocol}//${encodeURIComponent(decodeURIComponent(u.username))}:${encodeURIComponent(decodeURIComponent(u.password))}@${u.hostname}:${u.port}`
        : `${u.protocol}//${u.hostname}:${u.port}`,
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

async function detectAuthState(page) {
  const url = page.url();
  if (url.includes("/auth/login")) return "login-page";
  if (url.includes("/auth/logout")) return "logout-page";
  if (!url.includes("dashboard.katabump.com")) return "off-site";
  const pwdField = page.locator('input[type="password"]');
  const hasLoginForm =
    (await pwdField.count().catch(() => 0)) > 0 &&
    (await pwdField
      .first()
      .isVisible()
      .catch(() => false));
  if (hasLoginForm) return "login-page";
  const markers = await page
    .getByText("Your servers")
    .count()
    .catch(() => 0);
  const seeLinks = await page
    .getByRole("link", { name: "See", exact: true })
    .count()
    .catch(() => 0);
  if (markers > 0 || seeLinks > 0) return "dashboard";
  return "unknown";
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
    args.push(`--proxy-server=${PROXY_CONFIG.serverWithAuth}`);
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
    const data = fs.readFileSync(path.join(__dirname, "login.json"), "utf8");
    const json = JSON.parse(data);
    const raw = Array.isArray(json) ? json : json.users || [];
    const valid = raw.filter(
      (u) =>
        u &&
        typeof u.username === "string" &&
        u.username.length > 0 &&
        typeof u.password === "string" &&
        u.password.length > 0,
    );
    if (valid.length !== raw.length) {
      log(undefined, `${raw.length - valid.length} malformed user(s) skipped.`);
    }
    return valid;
  } catch (e) {
    log(undefined, `Error reading login.json: ${e.message}`);
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

async function loginToKatabump(page, user, isOnlyUser = false) {
  log(undefined, "Probing /dashboard for existing session...");
  await page.goto(DASHBOARD_URL, { timeout: 15000 }).catch(() => {});
  await page
    .waitForLoadState("domcontentloaded", { timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const probeState = await detectAuthState(page);
  log(undefined, `Auth probe: ${probeState}`);

  if (probeState === "dashboard") {
    if (isOnlyUser) {
      log(undefined, "Session valid (single user); reusing login.");
      return { status: "ok", reused: true };
    }
    log(undefined, "Session exists but multiple users; logging out first");
  }

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
      return { status: "ok", reused: false };
    } catch (e) {
      log(undefined, `Login attempt error: ${e.message}`);
    }
  }
  return { status: "failed" };
}

async function waitForRenewOutcome(page, modal, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const modalVisible = await modal
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (!modalVisible) {
      return { status: "success", elapsed: Date.now() - start };
    }

    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const notYetMatch = body.match(
      /You can't renew your server yet\.\s*You will be able to as of\s+([^(]+)/i,
    );
    if (notYetMatch) {
      return {
        status: "not-yet",
        date: notYetMatch[1].trim(),
        elapsed: Date.now() - start,
      };
    }
    if (/please complete|invalid.*captcha/i.test(body)) {
      return { status: "captcha", elapsed: Date.now() - start };
    }
    if (/incorrect/i.test(body)) {
      return { status: "altcha-rejected", elapsed: Date.now() - start };
    }
    if (/suspended/i.test(body)) {
      return { status: "suspended", elapsed: Date.now() - start };
    }

    await page.waitForTimeout(500);
  }
  return { status: "timeout", elapsed: timeoutMs };
}

async function renewCurrentServer(page, user, serverIndex) {
  let attempts = 0;
  const maxAttempts = 3;
  let modalRetries = 0;
  const maxModalRetries = 2;

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
      if (attempts >= maxAttempts) {
        log(serverIndex, "Renew button missing after max attempts");
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

    const confirmBtn = modal.getByRole("button", { name: "Renew" });
    if (!(await isVisibleWithin(confirmBtn, 5000))) {
      log(serverIndex, "Confirm button not visible, reloading");
      await page.reload({ timeout: 15000 }).catch(() => {});
      continue;
    }

    log(serverIndex, "Clicking Renew confirm (ALTCHA PoW runs on submit)...");
    await confirmBtn.click({ timeout: 5000 }).catch(() => {});

    log(
      serverIndex,
      `Polling outcome (up to ${RENEW_OUTCOME_TIMEOUT_MS / 1000}s for ALTCHA PoW + response)...`,
    );
    const outcome = await waitForRenewOutcome(
      page,
      modal,
      RENEW_OUTCOME_TIMEOUT_MS,
    );
    log(serverIndex, `Outcome: ${outcome.status} (${outcome.elapsed}ms)`);

    if (outcome.status === "not-yet") {
      return { status: "not-yet", date: outcome.date, attempts };
    }
    if (outcome.status === "suspended") {
      return { status: "suspended", attempts };
    }
    if (outcome.status === "captcha" || outcome.status === "altcha-rejected") {
      log(serverIndex, `Captcha rejected (${outcome.status}), reloading`);
      await page.reload({ timeout: 15000 }).catch(() => {});
      continue;
    }
    if (outcome.status === "success") {
      log(serverIndex, "Modal closed. Verifying on dashboard...");
      await page.goto(DASHBOARD_URL, { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});

      if (page.url().includes("/auth/")) {
        log(serverIndex, "Session lost after renewal");
        return { status: "session-lost", attempts };
      }

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

    log(serverIndex, `Outcome ${outcome.status}, reloading...`);
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

    const isOnlyUser = users.length === 1;
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

        const login = await loginToKatabump(page, user, isOnlyUser);
        if (login.status === "bad-creds") {
          const shot = path.join(
            ensurePhotoDir(),
            `${safeFilename(user.username)}_bad_creds.png`,
          );
          await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
          log(
            undefined,
            `Bad credentials for ${redactUsername(user.username)}`,
          );
          finalExitCode = 1;
          continue;
        }
        if (login.status !== "ok") {
          const shot = path.join(
            ensurePhotoDir(),
            `${safeFilename(user.username)}_login_failed.png`,
          );
          await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
          log(undefined, `Login failed for ${redactUsername(user.username)}`);
          finalExitCode = 1;
          continue;
        }

        await page.waitForLoadState("domcontentloaded").catch(() => {});
        const ready = await waitForDashboard(page);
        if (!ready) {
          log(undefined, `No servers detected. URL: ${page.url()}`);
          continue;
        }

        const seeLinks = await findSeeLocator(page);
        const serverCount = await seeLinks.count();
        log(undefined, `Found ${serverCount} server(s).`);

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
            continue;
          }

          const result = await renewCurrentServer(page, user, s + 1);

          const failureStatuses = new Set([
            "missing-renew-btn",
            "modal-missing",
            "exhausted",
            "session-lost",
          ]);

          if (result.status === "suspended") {
            const shot = path.join(
              ensurePhotoDir(),
              `${safeFilename(user.username)}_s${s + 1}_suspended.png`,
            );
            await page
              .screenshot({ path: shot, fullPage: true })
              .catch(() => {});
            log(s + 1, "SUSPENDED — renew manually NOW");
            finalExitCode = 1;
          } else if (failureStatuses.has(result.status)) {
            const shot = path.join(
              ensurePhotoDir(),
              `${safeFilename(user.username)}_s${s + 1}_${result.status}.png`,
            );
            await page
              .screenshot({ path: shot, fullPage: true })
              .catch(() => {});
            log(s + 1, `Failed: ${result.status}`);
            finalExitCode = 1;
          }

          log(s + 1, `Result: ${result.status}`);
        }
      } catch (err) {
        log(
          undefined,
          `Error processing user ${redactUsername(user.username)}: ${err.message}`,
        );
        finalExitCode = 1;
      } finally {
        try {
          if (page && !page.isClosed()) {
            await page
              .screenshot({
                path: path.join(
                  ensurePhotoDir(),
                  `${safeFilename(user.username)}_final.png`,
                ),
                fullPage: true,
              })
              .catch(() => {});
          }
        } catch {}
      }

      log(undefined, `Finished user ${redactUsername(user.username)}.\n`);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    log(undefined, `All users processed in ${duration}s.`);
  } finally {
    await cleanupAndExit(finalExitCode);
  }
})();
