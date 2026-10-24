#!/usr/bin/env bash
# Sets up a virtual environment on first run, then starts VoxBridge.
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
.venv/bin/python main.py
