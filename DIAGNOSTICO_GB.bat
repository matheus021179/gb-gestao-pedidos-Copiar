@echo off
setlocal
cd /d "%~dp0"
title Diagnostico GB Gestao de Pedidos
node -v
npm -v
if not exist node_modules call npm install
node --check server.js
if errorlevel 1 echo ERRO DE SINTAXE NO server.js
if exist public\index.html echo OK - interface encontrada
if exist data\store.json echo OK - banco local encontrado
pause
