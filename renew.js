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

const TURNSTILE_FIND_ATTEMPTS = 8;
const TURNSTILE_FIND_DELAY_MS = 1500;
const TURNSTILE_SUCCESS_POLLS = 8;
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

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    try {
        const originalAttachShadow = Element.prototype.attachShadow;

        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (!shadowRoot) return shadowRoot;

            const checkAndReport = () => {
                const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                if (!checkbox) return false;
                const rect = checkbox.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                    window.__turnstile_data = {
                        xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                        yRatio: (rect.top + rect.height / 2) / window.innerHeight,
                    };
                    return true;
                }
                return false;
            };

            if (!checkAndReport()) {
                const observer = new MutationObserver(() => {
                    if (checkAndReport()) observer.disconnect();
                });
                observer.observe(shadowRoot, { childList: true, subtree: true });
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[Injected] attachShadow hook failed:', e);
    }
})();
`;

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
    if ((await loc.count()) > 0) return loc;
  }
  return page.getByRole("link", { name: "See", exact: true });
}

async function waitForDashboard(page, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!page.url().includes("dashboard")) return false;
    const loc = await findSeeLocator(page);
    if ((await loc.count()) > 0) return true;
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

async function attemptTurnstileCdp(page) {
  const frames = page.frames();
  for (const frame of frames) {
    let client = null;
    try {
      const data = await frame
        .evaluate(() => window.__turnstile_data)
        .catch(() => null);
      if (!data) continue;

      console.log("   >> Found Turnstile. Ratios:", data);

      const iframeElement = await frame.frameElement();
      if (!iframeElement) continue;
      const box = await iframeElement.boundingBox();
      if (!box) continue;

      const clickX = box.x + box.width * data.xRatio;
      const clickY = box.y + box.height * data.yRatio;
      console.log(
        `   >> Click coords: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`,
      );

      client = await page.context().newCDPSession(page);

      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: clickX,
        y: clickY,
        button: "left",
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: clickX,
        y: clickY,
        button: "left",
        clickCount: 1,
      });

      console.log("   >> CDP click sent.");
      return true;
    } catch {
    } finally {
      if (client) await client.detach().catch(() => {});
    }
  }
  return false;
}

async function isTurnstileSolved(page) {
  for (const f of page.frames()) {
    if (!f.url().includes("cloudflare")) continue;
    try {
      if (
        await f
          .getByText("Success!", { exact: false })
          .isVisible()
          .catch(() => false)
      ) {
        return true;
      }
      const solved = await f
        .evaluate(() => {
          const widget =
            document.querySelector('[data-testid="cf-turnstile"]') ||
            document.querySelector(".cf-turnstile");
          if (widget && widget.getAttribute("data-state") === "success")
            return true;
          return !!document.querySelector('svg[data-icon="success"]');
        })
        .catch(() => false);
      if (solved) return true;
    } catch {}
  }
  return false;
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

      let clicked = false;
      for (let a = 0; a < TURNSTILE_FIND_ATTEMPTS; a++) {
        clicked = await attemptTurnstileCdp(page);
        if (clicked) break;
        await page.waitForTimeout(TURNSTILE_FIND_DELAY_MS);
      }
      if (clicked) {
        for (let i = 0; i < 10; i++) {
          await page.waitForTimeout(1000);
          if (await isTurnstileSolved(page)) {
            console.log("   >> Turnstile solved.");
            break;
          }
        }
      } else {
        console.log(
          "   >> No Turnstile checkbox found (may be invisible mode). Proceeding.",
        );
      }

      await page.getByRole("button", { name: "Login", exact: true }).click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});

      const badCreds = await isVisibleWithin(
        page.getByText("Incorrect password or no account"),
        5000,
      );
      if (badCreds) {
        console.error(
          `   >> ❌ Bad credentials for ${redactUsername(user.username)}`,
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

      if (page.url().includes("dashboard")) {
        console.log("   >> ✅ Logged in.");
        return true;
      }

      console.log("   >> Login outcome unclear. URL:", page.url());
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
        `\n   [Server ${serverIndex}] [Attempt ${attempt}/${RENEW_ATTEMPTS}] Looking for Renew button...`,
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
            `   [Server ${serverIndex}] ⏳ Not renewable yet: ${notYet[1].trim()}`,
          );
          return "not-yet";
        }

        if (/suspended/i.test(bodyText)) {
          console.log(
            `   [Server ${serverIndex}] ⚠️ Server appears SUSPENDED — manual intervention required.`,
          );
          return "suspended";
        }

        console.log(
          `   [Server ${serverIndex}] ⚠️ Renew button not found. URL: ${page.url()}`,
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

      console.log("   >> Checking for Turnstile...");
      let clicked = false;
      for (let a = 0; a < TURNSTILE_FIND_ATTEMPTS; a++) {
        clicked = await attemptTurnstileCdp(page);
        if (clicked) break;
        await page.waitForTimeout(TURNSTILE_FIND_DELAY_MS);
      }

      if (clicked) {
        console.log("   >> Waiting for Cloudflare...");
        for (let i = 0; i < TURNSTILE_SUCCESS_POLLS; i++) {
          await page.waitForTimeout(1000);
          if (await isTurnstileSolved(page)) {
            console.log("   >> Turnstile solved.");
            break;
          }
        }
      } else {
        console.log("   >> Turnstile checkbox not found within retry budget.");
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
        console.log("   >> 📸 Snapshot saved.");
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
            `   >> ⏳ Not renewable yet. ${m ? "Available: " + m[1] : ""}`,
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
        console.log("   >> ✅ Modal closed. Renew succeeded.");
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

    await page.goto("about:blank").catch(() => {});
    await page.addInitScript(INJECTED_SCRIPT);
    console.log("Injection script added.");

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      console.log(
        `\n=== User ${i + 1}/${users.length}: ${redactUsername(user.username)} ===`,
      );

      try {
        if (page.isClosed()) {
          page = await context.newPage();
          page.setDefaultTimeout(60000);
          await page.addInitScript(INJECTED_SCRIPT);
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
