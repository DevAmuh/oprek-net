@echo off
cd /d "E:\Claude Code Projects\Mr.D"
echo Pulling latest...
git pull origin master --rebase
echo.
echo Staging graduation/...
git add graduation/index.html graduation/login.html graduation/chart.html
echo.
echo Committing...
git commit -m "graduation: update pages"
echo.
echo Pushing to master...
git push origin master
echo.
echo Done! Vercel will deploy in ~30-60 seconds.
pause
