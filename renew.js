let chromium;
try {
  ({ chromium } = require("patchright"));
  console.log("[Init] Using patchright (recommended)");
} catch {
  const { chromium: pwChromium } = require("playwright-extra");
  const stealth = require("puppeteer-extra-plugin-stealth")();
  pwChromium.use(stealth);
  chromium = pwChromium;
  console.log("[Init] Using playwright-extra + stealth (legacy)");
}

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const http = require("http");

const CHROME_PATH =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const USER_DATA_DIR = path.join(__dirname, "ChromeData_Katabump");
const DEBUG_PORT = 9222;
const HEADLESS = false;
const LOGIN_URL = "https://dashboard.katabump.com/auth/login";
const DASHBOARD_URL = "https://dashboard.katabump.com/dashboard";
const LOGOUT_URL = "https://dashboard.katabump.com/auth/logout";

const RENEW_ATTEMPTS = 20;

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
  try {
    const proxyUrl = new URL(HTTP_PROXY);
    const username = proxyUrl.username
      ? decodeURIComponent(proxyUrl.username)
      : undefined;
    const password = proxyUrl.password
      ? decodeURIComponent(proxyUrl.password)
      : undefined;
    const server = `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`;
    const serverWithAuth =
      username && password
        ? `${proxyUrl.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${proxyUrl.hostname}:${proxyUrl.port}`
        : server;

    PROXY_CONFIG = { server, serverWithAuth, username, password };
    console.log(`[Proxy] Server=${server} Auth=${username ? "Yes" : "No"}`);
  } catch (e) {
    console.error(
      "[Proxy] Invalid HTTP_PROXY format. Expected: http://user:pass@host:port",
    );
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

function ensurePhotoDir() {
  const dir = path.join(__dirname, "photo");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
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
  console.log("[Proxy] Validating proxy connection...");
  try {
    const proxyUrl = new URL(PROXY_CONFIG.server);
    const axiosConfig = {
      proxy: { protocol: "http", host: proxyUrl.hostname, port: proxyUrl.port },
      timeout: 10000,
    };
    if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
      axiosConfig.proxy.auth = {
        username: PROXY_CONFIG.username,
        password: PROXY_CONFIG.password,
      };
    }
    await axios.get("https://www.cloudflare.com/cdn-cgi/trace", axiosConfig);
    console.log("[Proxy] Connection successful.");
    return true;
  } catch (error) {
    console.error(`[Proxy] Connection failed: ${error.message}`);
    return false;
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/version`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function launchNativeChrome() {
  console.log(
    "Checking if Chrome is already running on port " + DEBUG_PORT + "...",
  );
  if (await checkPort(DEBUG_PORT)) {
    console.log("Chrome is already open.");
    return;
  }

  console.log("Launching native Chrome...");
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
  ];

  if (PROXY_CONFIG) {
    args.push(`--proxy-server=${PROXY_CONFIG.serverWithAuth}`);
  }

  if (HEADLESS) args.push("--headless=new");

  const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: "ignore" });
  chrome.unref();

  console.log("Waiting for Chrome to initialize...");
  for (let i = 0; i < 20; i++) {
    if (await checkPort(DEBUG_PORT)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.error("Chrome failed to start on port " + DEBUG_PORT);
  try {
    chrome.kill();
  } catch {}
  throw new Error("Chrome launch failed");
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
      console.warn(
        `[Config] ${raw.length - valid.length} malformed user(s) skipped.`,
      );
    }
    return valid;
  } catch (e) {
    console.error("Error reading login.json:", e.message);
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
    console.log(`   [Login attempt ${loginAttempt}/2]`);

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
        console.log("   >> Login form not visible. Retrying...");
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
        const photoDir = ensurePhotoDir();
        try {
          await page.screenshot({
            path: path.join(
              photoDir,
              `${safeFilename(user.username)}_login_captcha.png`,
            ),
            fullPage: true,
          });
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
          console.error(
            `   >> Bad credentials for ${redactUsername(user.username)}`,
          );
          const photoDir = ensurePhotoDir();
          try {
            await page.screenshot({
              path: path.join(
                photoDir,
                `${safeFilename(user.username)}_login_fail.png`,
              ),
              fullPage: true,
            });
          } catch {}
          return false;
        }
        console.log("   >> Still on login page after submit; retrying.");
        continue;
      }

      console.log("   >> Logged in.");
      return true;
    } catch (e) {
      console.log(`   >> Login attempt error: ${e.message}`);
    }
  }

  return false;
}

async function renewCurrentServer(page, user, serverIndex) {
  for (let attempt = 1; attempt <= RENEW_ATTEMPTS; attempt++) {
    try {
      console.log(
        `\n   [Server ${serverIndex}] [Attempt ${attempt}/${RENEW_ATTEMPTS}]`,
      );

      const renewBtn = page
        .getByRole("button", { name: "Renew", exact: true })
        .first();

      if (!(await isVisibleWithin(renewBtn, 5000))) {
        const bodyText = await page
          .locator("body")
          .innerText()
          .catch(() => "");

        const notYet = bodyText.match(
          /You can't renew your server yet\.\s*You will be able to as of\s+([^(]+)/,
        );
        if (notYet) {
          console.log(
            `   [Server ${serverIndex}] Not renewable yet: ${notYet[1].trim()}`,
          );
          return "not-yet";
        }

        if (/suspended/i.test(bodyText)) {
          console.log(`   [Server ${serverIndex}] Server appears SUSPENDED.`);
          return "suspended";
        }

        console.log(
          `   [Server ${serverIndex}] Renew button not found. URL: ${page.url()}`,
        );
        console.log(
          `      Body preview: ${bodyText.slice(0, 200).replace(/\s+/g, " ")}`,
        );

        if (attempt < RENEW_ATTEMPTS) {
          await page.reload();
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await page.waitForTimeout(1000);
          continue;
        }
        return "unknown";
      }

      await renewBtn.click();
      console.log("   >> Renew clicked. Waiting for modal...");

      const modal = page.locator("#renew-modal");
      if (!(await isVisibleWithin(modal, 5000))) {
        console.log("   >> Modal did not appear. Retrying...");
        await page.reload();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
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
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }

      const confirmBtn = modal.getByRole("button", { name: "Renew" });
      if (!(await confirmBtn.isVisible().catch(() => false))) {
        console.log("   >> Confirm button not visible. Reloading...");
        await page.reload();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }

      const photoDir = ensurePhotoDir();
      try {
        await page.screenshot({
          path: path.join(
            photoDir,
            `${safeFilename(user.username)}_server${serverIndex}_attempt${attempt}.png`,
          ),
          fullPage: true,
        });
      } catch {}

      console.log("   >> Clicking Renew confirm...");
      await confirmBtn.click();

      let outcome = null;
      const checkStart = Date.now();
      while (Date.now() - checkStart < 3000) {
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
          console.log(
            `   >> Not renewable yet. ${m ? "Available: " + m[1] : ""}`,
          );
          outcome = "not-yet";
          break;
        }
        await page.waitForTimeout(200);
      }

      if (outcome === "not-yet") return "not-yet";

      if (outcome === "captcha") {
        console.log("   >> Captcha error. Reloading...");
        await page.reload();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }

      await page.waitForTimeout(2000);
      if (!(await modal.isVisible().catch(() => false))) {
        console.log("   >> Modal closed. Renew succeeded.");
        return "success";
      }

      console.log("   >> Modal still open, no error message. Reloading...");
      await page.reload();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    } catch (e) {
      console.log(`   [Server ${serverIndex}] Attempt error: ${e.message}`);
      if (attempt < RENEW_ATTEMPTS) {
        await page.reload().catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }
    }
  }

  return "exhausted";
}

(async () => {
  const users = getUsers();
  if (users.length === 0) {
    console.log("No valid users in login.json");
    return;
  }

  if (PROXY_CONFIG && !(await checkProxy())) {
    console.error("[Proxy] Aborting due to invalid proxy.");
    process.exit(1);
  }

  await launchNativeChrome();

  console.log("Connecting to Chrome...");
  let browser;
  for (let k = 0; k < 5; k++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
      console.log("Connected.");
      break;
    } catch {
      console.log(`Connection attempt ${k + 1} failed. Retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!browser) {
    console.error("Failed to connect. Exiting.");
    return;
  }

  try {
    const context = browser.contexts()[0];
    let page =
      context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

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

        const ok = await loginToKatabump(page, user);
        if (!ok) {
          console.log("Skipping user (login failed).");
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
          continue;
        }

        const seeLinks = await findSeeLocator(page);
        const serverCount = await seeLinks.count();
        console.log(`Found ${serverCount} server(s).`);

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
            continue;
          }

          let result;
          try {
            result = await renewCurrentServer(page, user, s + 1);
          } catch (e) {
            console.log(`   Server ${s + 1} threw: ${e.message}`);
            result = "error";
          }
          console.log(`   [Server ${s + 1}] Result: ${result}`);
        }
      } catch (err) {
        console.error(
          `Error processing user ${redactUsername(user.username)}:`,
          err.message,
        );
      } finally {
        try {
          if (page && !page.isClosed()) {
            const photoDir = ensurePhotoDir();
            await page.screenshot({
              path: path.join(
                photoDir,
                `${safeFilename(user.username)}_final.png`,
              ),
              fullPage: true,
            });
          }
        } catch {}
      }

      console.log(`Finished user ${redactUsername(user.username)}.\n`);
    }

    console.log("All users processed.");
  } finally {
    if (browser) {
      try {
        if (typeof browser.close === "function") await browser.close();
      } catch {}
    }
  }
})();
