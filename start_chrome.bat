@echo off
setlocal

set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "USER_DATA_DIR=%LOCALAPPDATA%\ChromeData_Katabump"
set "DEBUG_PORT=9222"

start "" "%CHROME_PATH%" ^
    --remote-debugging-port=%DEBUG_PORT% ^
    --remote-allow-origins=* ^
    --user-data-dir="%USER_DATA_DIR%" ^
    --no-first-run ^
    --no-default-browser-check ^
    --disable-blink-features=AutomationControlled

echo [OK] Chrome launched with CDP on port %DEBUG_PORT%.
endlocal
