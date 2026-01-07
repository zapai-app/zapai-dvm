#!/bin/bash

cd "$(dirname "$0")"

# Get port from .env file
WEB_PORT=$(grep "^WEB_PORT=" .env | cut -d '=' -f2)
WEB_PORT=${WEB_PORT:-8080}

# Kill any existing instance
pkill -9 -f "node.*index.js" 2>/dev/null
pkill -9 -f "node.*src/index.js" 2>/dev/null

# Wait for port to be freed
for i in {1..10}; do
  if ! lsof -i:$WEB_PORT > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "Starting ZapAI (Data Vending Machine)..."
echo "Specialized DVM for ZapAI Platform"

# Start the bot
nohup node src/index.js > bot.log 2>&1 &

PID=$!
echo "DVM started (PID: $PID)"
echo "Web UI: http://localhost:$WEB_PORT"
echo "Logs: tail -f bot.log"

# Wait a bit and check if it's still running
sleep 3

if ps -p $PID > /dev/null; then
    echo "Bot running"
else
    echo "Start failed. Check bot.log:"
    tail -20 bot.log
fi
