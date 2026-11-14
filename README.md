# katabump auto-renew

Renews free KataBump servers before they expire, so you don't have to remember.

Runs on GitHub Actions (set it once, forget it) or locally on Windows.

---

## Credit where it's due

This is a fork of [DsTansice/katabump](https://github.com/DsTansice/katabump). The CDP + Turnstile trick is theirs.

I rewrote the scripts to stop them from silently eating failures:

- Renews **every server** per account, not just the first one
- Tells you the actual outcome (`success` / `not-yet` / `suspended` / `unknown` / `exhausted` / `bad-creds`) instead of marking everything "success"
- Fixed a crash on bad passwords that meant **no Telegram alert ever fired**
- Fixed `isVisible({ timeout })` calls that were never actually waiting
- Added `--remote-allow-origins=*` so CDP works on Chrome 111+
- Killed the `screenX`/`screenY` spoof — it was a bigger bot signal than doing nothing
- Lockfile committed, CI uses `npm ci` so deps don't drift
- More Telegram alerts, proper cleanup, tighter retry limits

That's it. Everything below is how to use it.

---

## Cloud (recommended)

1. Fork this repo or push it to a new empty one.
2. Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
3. Add `USERS_JSON`. One line:

   ```json
   [{ "username": "you@example.com", "password": "yourpass" }]
   ```

4. Go to **Actions** → **Katabump Auto Renew** → **Run workflow** to test.
5. Done. It runs daily at 00:00 UTC (08:00 Beijing).

### Secrets

| Secret         | Needed? | What it is                                                   |
| -------------- | ------- | ------------------------------------------------------------ |
| `USERS_JSON`   | **yes** | JSON array of `{"username","password"}`                      |
| `TG_BOT_TOKEN` | no      | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `TG_CHAT_ID`   | no      | Your Telegram chat ID                                        |
| `HTTP_PROXY`   | no      | `http://[user:pass@]host:port`                               |

`GITHUB_TOKEN` is automatic — you only need `REPO_TOKEN` if your branch protection blocks it from pushing.

---

## Local (Windows)

```bash
npm ci
```

Create `login.json`:

```json
[{ "username": "you@example.com", "password": "yourpass" }]
```

```bash
node renew.js
```

If Chrome isn't at `C:\Program Files\Google\Chrome\Application\chrome.exe`, edit `CHROME_PATH` at the top of `renew.js` (or `start_chrome.bat`).

Proxy:

```powershell
$env:HTTP_PROXY = "http://user:pass@host:port"
node renew.js
```

Screenshots land in `photo/`.

---

## Renewal window

KataBump lets you renew starting **2 days before expiry**. The server dies **4 days** after its last renewal. So daily checks are enough — no need to run more often.

If a run says `suspended`, you have ~24 hours to renew manually before files get deleted.

---

## What you'll see in the logs

```
=== User 1/1: abc***@example.com ===
   [Login 1/2]
   >> Turnstile solved.
   >> Logged in.
Found 2 server(s).
   [Server 1] [Attempt 1/20]
   >> Renew clicked.
   >> Turnstile solved.
   >> Renew succeeded.
   [Server 1] Result: success
   [Server 2] [Attempt 1/20]
   [Server 2] Result: not-yet
```

`not-yet` is fine. It means KataBump said "not in the renewal window yet" — the next run will catch it.

---

## License

Same as upstream: [DsTansice/katabump](https://github.com/DsTansice/katabump).
