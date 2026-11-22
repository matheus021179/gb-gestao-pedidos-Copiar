@echo off
setlocal
cd /d "%~dp0"
title GB Gestao de Pedidos - Atualizado
echo ============================================
echo      GB GESTAO DE PEDIDOS - ATUALIZADO
echo ============================================
if not exist data mkdir data
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 (
    echo Falha ao instalar dependencias.
    pause
    exit /b 1
  )
)
echo Iniciando aplicativo...
call npm start
pause
