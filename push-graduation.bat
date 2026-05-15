@echo off
cd /d "E:\Claude Code Projects\Mr.D"
echo Pulling latest...
git pull origin master --rebase
echo.
echo Staging graduation/index.html...
git add graduation/index.html
echo.
echo Committing...
git commit -m "graduation: update index.html"
echo.
echo Pushing to master...
git push origin master
echo.
echo Done! Vercel will deploy in ~30-60 seconds.
pause
