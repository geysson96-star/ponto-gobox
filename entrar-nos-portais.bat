@echo off
chcp 65001 >nul
title GoBox - Entrar nos portais (robo)
cd /d "%~dp0"

if not exist node_modules\playwright-core\package.json (
  echo  Instalando dependencias...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( pause & exit /b 1 )
)

echo.
echo  Vai abrir o navegador do ROBO (Microsoft Edge, separado do seu).
echo.
echo  1. Faca login na aba da Shopee e na aba do Mercado Livre.
echo  2. Confira se a lista de pacotes aparece.
echo  3. FECHE a janela do navegador. Pronto, o robo usa essa sessao.
echo.
echo  Faca isso de novo sempre que o painel mostrar "sessao expirada".
echo.
call npm run robo:login
pause
