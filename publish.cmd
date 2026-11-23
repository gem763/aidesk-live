@echo off
rem aidesk-live: push the encrypted dashboard data to GitHub Pages. PAPER ONLY. Only data.enc.json (and site files) change.
rem Lives in the aidesk-live clone (C:\Users\BNK\Documents\GitHub\aidesk-live). Uses the PC's existing Git login. No keys printed.
chcp 65001 >nul
cd /d "%~dp0"
git add index.html core.js app.js data.enc.json robots.txt .nojekyll README.md 2>nul
git diff --cached --quiet && (echo [publish] no change & exit /b 0)
git commit -q -m "data update" || exit /b 1
git push -q origin main
set RC=%ERRORLEVEL%
echo [publish] rc=%RC%
exit /b %RC%
