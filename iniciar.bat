@echo off
chcp 65001 >nul
title GoBox - Consulta de pacotes
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js nao foi encontrado neste computador.
  echo  Instale a versao LTS em https://nodejs.org e depois abra este arquivo de novo.
  echo.
  pause
  exit /b 1
)

set PRECISA_INSTALAR=0
if not exist node_modules\express\package.json set PRECISA_INSTALAR=1
if "%PRECISA_INSTALAR%"=="1" (
  echo.
  echo  Instalando dependencias ^(so na primeira vez, pode levar 1 ou 2 minutos^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  A instalacao falhou. Copie a mensagem acima e mande para o Claude.
    pause
    exit /b 1
  )
)

findstr /r /c:"^ADMIN_PASSWORD_HASH='\$" .env >nul 2>nul
if errorlevel 1 (
  call npm run configurar
  if errorlevel 1 ( pause & exit /b 1 )
)

echo.
echo  Abrindo o site no navegador...
echo  Consulta publica: http://localhost:3000
echo  Painel:           http://localhost:3000/admin/
echo.
echo  Para desligar o site, feche esta janela.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000/admin/ & start http://localhost:3000"
call npm start
pause
