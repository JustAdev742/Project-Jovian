@echo off
title Authorize Claude access to the Nova server
echo ============================================================
echo   Authorizing Claude / Nova access to your server:
echo   admin_home@2001:8003:2291:a501:2af1:eff:fe28:da6
echo.
echo   When prompted below, type YOUR SERVER PASSWORD and press Enter.
echo   Claude does NOT see what you type here.
echo ============================================================
echo.
ssh -o StrictHostKeyChecking=accept-new admin_home@2001:8003:2291:a501:2af1:eff:fe28:da6 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDLsM3YblgEi3en1Yo1swg1chaWiZ/LacjAUZzPpdSiC nova-claude-access' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo NOVA_KEY_INSTALLED"
echo.
echo ------------------------------------------------------------
echo   If you see NOVA_KEY_INSTALLED just above, it worked.
echo   You can close this window and tell Claude it is done.
echo ------------------------------------------------------------
pause
