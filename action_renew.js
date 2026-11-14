let chromium;
try {
  ({ chromium } = require("patchright"));
  console.log("[Init] Using patchright");
} catch {
  const { chromium: pwChromium } = require("playwright-extra");
  const stealth = require("puppeteer-extra-plugin-stealth")();
  pwChromium.use(stealth);
  chromium = pwChromium;
  console.log("[Init] Using playwright-extra + stealth");
}

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const http = require("http");

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const DEBUG_PORT = 9222;
const USER_DATA_DIR = "/tmp/chrome_user_data";

const LOGIN_URL = "https://dashboard.katabump.com/auth/login";
const DASHBOARD_URL = "https://dashboard.katabump.com/dashboard";
const LOGOUT_URL = "https://dashboard.katabump.com/auth/logout";

const RENEW_ATTEMPTS = 20;

process.env.NO_PROXY = "localhost,127.0.0.1";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    });
    console.log("[Telegram] Text sent.");
  } catch (e) {
    console.error("[Telegram] Text failed:", e.message);
  }

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
      });
      console.log("[Telegram] Photo sent.");
    } catch (e) {
      console.error("[Telegram] Photo failed:", e.message);
    }
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
    console.log(
      `[Proxy] Server=${PROXY_CONFIG.server} Auth=${PROXY_CONFIG.username ? "Yes" : "No"}`,
    );
  } catch {
    console.error("[Proxy] Invalid HTTP_PROXY format.");
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
  console.log("[Proxy] Validating...");
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
    console.log("[Proxy] OK");
    return true;
  } catch (e) {
    console.error("[Proxy] Failed:", e.message);
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
    console.log("Chrome already running.");
    return;
  }

  console.log("Launching Chrome...");
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

  const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: "ignore" });
  chrome.unref();

  for (let i = 0; i < 20; i++) {
    if (await checkPort(DEBUG_PORT)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }

  try {
    chrome.kill();
  } catch {}
  throw new Error(`Chrome failed to open CDP on port ${DEBUG_PORT}`);
}

function getUsers() {
  try {
    const raw = process.env.USERS_JSON;
    if (!raw) {
      console.error("USERS_JSON not set.");
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
      console.warn(
        `[Config] ${arr.length - valid.length} malformed user(s) skipped.`,
      );
    }
    return valid;
  } catch (e) {
    console.error("Error parsing USERS_JSON:", e.message);
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
  const input = scope.locator('[name="cf-turnstile-response"]').first();
  if ((await input.count().catch(() => 0)) === 0) return null;
  const v = await input.inputValue().catch(() => "");
  return v && v.length > 20 ? v : null;
}

async function findTurnstileIframe(scope) {
  for (const sel of [
    'iframe[id^="cf-chl-widget"]',
    'iframe[src*="challenges.cloudflare.com"]',
  ]) {
    const loc = scope.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    const box = await loc.boundingBox().catch(() => null);
    if (box && box.width > 5 && box.height > 5) return { loc, box };
  }
  return null;
}

async function ensureTurnstileSolved(page, scope = page) {
  if (await getTurnstileToken(scope)) {
    console.log("   >> Turnstile already solved.");
    return "solved";
  }

  console.log("   >> Waiting up to 3s for auto-solve...");
  const autoDeadline = Date.now() + 3000;
  while (Date.now() < autoDeadline) {
    if (await getTurnstileToken(scope)) {
      console.log("   >> Turnstile auto-solved.");
      return "solved";
    }
    await page.waitForTimeout(300);
  }

  const widget = await findTurnstileIframe(scope);
  if (!widget) {
    console.log("   >> Turnstile widget not visible (crashed or missing).");
    return "no-widget";
  }

  const cx = widget.box.x + 22;
  const cy = widget.box.y + widget.box.height / 2;
  console.log(
    `   >> Clicking Turnstile at (${cx.toFixed(1)}, ${cy.toFixed(1)})...`,
  );
  await cdpClick(page, cx, cy);

  const solveDeadline = Date.now() + 15000;
  while (Date.now() < solveDeadline) {
    const token = await getTurnstileToken(scope);
    if (token) {
      console.log(`   >> Turnstile solved (${token.length}-char token).`);
      return "solved";
    }
    await page.waitForTimeout(500);
  }

  console.log("   >> Turnstile did not solve after click.");
  return "timeout";
}

async function loginToKatabump(page, user) {
  for (let loginAttempt = 1; loginAttempt <= 2; loginAttempt++) {
    console.log(`   [Login ${loginAttempt}/2]`);

    try {
      if (
        page.url().includes("dashboard") &&
        !page.url().includes("/auth/login")
      ) {
        await page.goto(LOGOUT_URL);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(1000);
      }

      await page.goto(LOGIN_URL);
      await page.waitForLoadState("domcontentloaded");

      const emailInput = page.getByRole("textbox", { name: "Email" });
      if (!(await isVisibleWithin(emailInput, 10000))) {
        console.log("   >> Login form not visible; retrying.");
        continue;
      }
      await emailInput.fill(user.username);
      await page.locator('input[type="password"]').fill(user.password);
      await page.waitForTimeout(500);

      const tsResult = await ensureTurnstileSolved(page);
      if (tsResult === "no-widget") {
        console.log("   >> Widget crashed; reloading.");
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        continue;
      }

      await page.getByRole("button", { name: "Login", exact: true }).click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(1500);

      const url = page.url();
      if (url.includes("error=captcha")) {
        console.log("   >> Login failed: server rejected captcha.");
        const shot = path.join(
          ensureScreenshotDir(),
          `${safeFilename(user.username)}_login_captcha.png`,
        );
        try {
          await page.screenshot({ path: shot, fullPage: true });
        } catch {}
        continue;
      }

      if (url.includes("/auth/login")) {
        if (
          await isVisibleWithin(
            page.getByText("Incorrect password or no account"),
            3000,
          )
        ) {
          const shot = path.join(
            ensureScreenshotDir(),
            `${safeFilename(user.username)}_login_fail.png`,
          );
          try {
            await page.screenshot({ path: shot, fullPage: true });
          } catch {}
          console.error(
            `   >> Bad credentials for ${redactUsername(user.username)}`,
          );
          await sendTelegramMessage(
            `❌ <b>Login failed</b>\nUser: <code>${escapeHtml(user.username)}</code>\nReason: bad credentials`,
            shot,
          );
          return "bad-creds";
        }
        console.log("   >> Still on login page after submit; retrying.");
        continue;
      }

      console.log("   >> Logged in.");
      return "ok";
    } catch (e) {
      console.log(`   >> Login attempt error: ${e.message}`);
    }
  }

  const shot = path.join(
    ensureScreenshotDir(),
    `${safeFilename(user.username)}_login_unclear.png`,
  );
  try {
    await page.screenshot({ path: shot, fullPage: true });
  } catch {}
  await sendTelegramMessage(
    `⚠️ <b>Login did not succeed</b>\nUser: <code>${escapeHtml(user.username)}</code>`,
    shot,
  );
  return "failed";
}

async function renewCurrentServer(page, user, serverIndex) {
  for (let attempt = 1; attempt <= RENEW_ATTEMPTS; attempt++) {
    console.log(
      `   [Server ${serverIndex}] [Attempt ${attempt}/${RENEW_ATTEMPTS}]`,
    );

    const renewBtn = page
      .getByRole("button", { name: "Renew", exact: true })
      .first();

    if (!(await isVisibleWithin(renewBtn, 5000))) {
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");

      const notYet = body.match(
        /You can't renew your server yet\.\s*You will be able to as of\s+([^(]+)/,
      );
      if (notYet) {
        const dateStr = notYet[1].trim();
        console.log(
          `   [Server ${serverIndex}] Not renewable until ${dateStr}`,
        );
        const shot = path.join(
          ensureScreenshotDir(),
          `${safeFilename(user.username)}_s${serverIndex}_notyet.png`,
        );
        try {
          await page.screenshot({ path: shot, fullPage: true });
        } catch {}
        await sendTelegramMessage(
          `⏳ <b>Not yet renewable</b>\nUser: <code>${escapeHtml(user.username)}</code>\nServer ${serverIndex}\nAvailable: ${escapeHtml(dateStr)}`,
          shot,
        );
        return "not-yet";
      }

      if (/suspended/i.test(body)) {
        console.log(`   [Server ${serverIndex}] SUSPENDED.`);
        const shot = path.join(
          ensureScreenshotDir(),
          `${safeFilename(user.username)}_s${serverIndex}_suspended.png`,
        );
        try {
          await page.screenshot({ path: shot, fullPage: true });
        } catch {}
        await sendTelegramMessage(
          `🚨 <b>SUSPENDED</b>\nUser: <code>${escapeHtml(user.username)}</code>\nServer ${serverIndex} — renew manually NOW.`,
          shot,
        );
        return "suspended";
      }

      console.log(
        `   [Server ${serverIndex}] Renew button missing. URL: ${page.url()}`,
      );
      const shot = path.join(
        ensureScreenshotDir(),
        `${safeFilename(user.username)}_s${serverIndex}_unknown.png`,
      );
      try {
        await page.screenshot({ path: shot, fullPage: true });
      } catch {}
      await sendTelegramMessage(
        `⚠️ <b>Renew button missing</b>\nUser: <code>${escapeHtml(user.username)}</code>\nServer ${serverIndex}`,
        shot,
      );
      return "unknown";
    }

    await renewBtn.click();
    console.log("   >> Renew clicked.");

    const modal = page.locator("#renew-modal");
    if (!(await isVisibleWithin(modal, 5000))) {
      console.log("   >> Modal did not appear; retrying.");
      continue;
    }

    try {
      const box = await modal.boundingBox();
      if (box)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
          steps: 5,
        });
    } catch {}

    const tsResult = await ensureTurnstileSolved(page, modal);
    if (tsResult === "no-widget") {
      console.log("   >> Widget crashed in modal; reloading.");
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      continue;
    }

    const confirmBtn = modal.getByRole("button", { name: "Renew" });
    if (!(await confirmBtn.isVisible().catch(() => false))) {
      console.log("   >> Confirm button not visible; reloading.");
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      continue;
    }

    const beforeShot = path.join(
      ensureScreenshotDir(),
      `${safeFilename(user.username)}_s${serverIndex}_attempt${attempt}.png`,
    );
    try {
      await page.screenshot({ path: beforeShot, fullPage: true });
    } catch {}

    console.log("   >> Clicking Renew confirm...");
    await confirmBtn.click();

    let outcome = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (
        await page
          .getByText("Please complete the captcha to continue")
          .isVisible()
          .catch(() => false)
      ) {
        outcome = "captcha";
        break;
      }
      const notTimeLoc = page.getByText("You can't renew your server yet");
      if (await notTimeLoc.isVisible().catch(() => false)) {
        const text = await notTimeLoc.innerText().catch(() => "");
        const m = text.match(/as of\s+(.*?)\s+\(/);
        console.log(`   >> Not renewable yet${m ? ": " + m[1] : ""}`);
        outcome = "not-yet";
        break;
      }
      await page.waitForTimeout(200);
    }

    if (outcome === "not-yet") return "not-yet";

    if (outcome === "captcha") {
      console.log("   >> Captcha error; reloading.");
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      continue;
    }

    await page.waitForTimeout(2000);
    if (!(await modal.isVisible().catch(() => false))) {
      console.log("   >> Renew succeeded.");
      const shot = path.join(
        ensureScreenshotDir(),
        `${safeFilename(user.username)}_s${serverIndex}_success.png`,
      );
      try {
        await page.screenshot({ path: shot, fullPage: true });
      } catch {}
      await sendTelegramMessage(
        `✅ <b>Renewed</b>\nUser: <code>${escapeHtml(user.username)}</code>\nServer ${serverIndex}`,
        shot,
      );
      return "success";
    }

    console.log("   >> Modal still open, no error. Reloading.");
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
  }

  console.log(`   [Server ${serverIndex}] Exhausted.`);
  const shot = path.join(
    ensureScreenshotDir(),
    `${safeFilename(user.username)}_s${serverIndex}_exhausted.png`,
  );
  try {
    await page.screenshot({ path: shot, fullPage: true });
  } catch {}
  await sendTelegramMessage(
    `❌ <b>Renewal exhausted</b>\nUser: <code>${escapeHtml(user.username)}</code>\nServer ${serverIndex}`,
    shot,
  );
  return "exhausted";
}

(async () => {
  const users = getUsers();
  if (users.length === 0) {
    console.error("No valid users. Exiting.");
    process.exit(1);
  }

  if (PROXY_CONFIG && !(await checkProxy())) {
    console.error("[Proxy] Invalid proxy. Exiting.");
    process.exit(1);
  }

  await launchChrome();

  let browser;
  for (let k = 0; k < 5; k++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
      console.log("Connected.");
      break;
    } catch {
      console.log(`Connection attempt ${k + 1} failed; retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!browser) {
    console.error("Failed to connect to Chrome. Exiting.");
    process.exit(1);
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
      console.log(
        `\n=== User ${i + 1}/${users.length}: ${redactUsername(user.username)} ===`,
      );

      try {
        if (page.isClosed()) {
          page = await context.newPage();
          page.setDefaultTimeout(60000);
        }

        const login = await loginToKatabump(page, user);
        if (login !== "ok") {
          summary.push({
            user: redactUsername(user.username),
            result: `login:${login}`,
          });
          continue;
        }

        await page.waitForLoadState("domcontentloaded").catch(() => {});
        const ready = await waitForDashboard(page);

        if (!ready) {
          const body = await page
            .locator("body")
            .innerText()
            .catch(() => "");
          console.log("No servers detected. URL:", page.url());
          console.log("Body preview:", body.slice(0, 400).replace(/\s+/g, " "));
          summary.push({
            user: redactUsername(user.username),
            result: "no-servers",
          });
          continue;
        }

        const seeLinks = await findSeeLocator(page);
        const serverCount = await seeLinks.count();
        console.log(`Found ${serverCount} server(s).`);

        const serverResults = [];
        for (let s = 0; s < serverCount; s++) {
          if (s > 0) {
            await page.goto(DASHBOARD_URL);
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await waitForDashboard(page);
          }
          try {
            const fresh = await findSeeLocator(page);
            await fresh.nth(s).click();
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await page.waitForTimeout(1000);
          } catch (e) {
            console.log(`   Could not open server ${s + 1}: ${e.message}`);
            serverResults.push(`s${s + 1}:open-failed`);
            continue;
          }
          const result = await renewCurrentServer(page, user, s + 1);
          serverResults.push(`s${s + 1}:${result}`);
        }
        summary.push({
          user: redactUsername(user.username),
          result: serverResults.join(", "),
        });
      } catch (err) {
        console.error(
          `Error processing user ${redactUsername(user.username)}:`,
          err.message,
        );
        summary.push({
          user: redactUsername(user.username),
          result: `error:${err.message}`,
        });
      } finally {
        try {
          if (page && !page.isClosed()) {
            await page.screenshot({
              path: path.join(
                ensureScreenshotDir(),
                `${safeFilename(user.username)}_final.png`,
              ),
              fullPage: true,
            });
          }
        } catch {}
      }
    }

    const hasFailure = summary.some((r) => !/success|not-yet/.test(r.result));
    if (summary.length > 0 && (hasFailure || summary.length > 1)) {
      const lines = summary.map(
        (r) => `• <code>${escapeHtml(r.user)}</code> — ${escapeHtml(r.result)}`,
      );
      await sendTelegramMessage(
        `<b>KataBump run summary</b>\n${lines.join("\n")}`,
      );
    }

    console.log("\nAll users processed.");
  } finally {
    if (browser) {
      try {
        if (typeof browser.close === "function") await browser.close();
      } catch {}
    }
  }
})();
