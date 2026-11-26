@echo off
rem Lanzador de la CLI: LefortConnector.cmd status | queue | test-sqlserver | test-webhook | diagnostics --output soporte.zip
"%~dp0runtime\node.exe" "%~dp0app\dist\index.js" %*
