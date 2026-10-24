@echo off
REM Sets up a virtual environment on first run, then starts VoxBridge.
cd /d "%~dp0"
if not exist .venv (
  python -m venv .venv
  .venv\Scripts\pip install -q -r requirements.txt
)
.venv\Scripts\python main.py
