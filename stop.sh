#!/bin/bash

# Get port from .env file
WEB_PORT=$(grep "^WEB_PORT=" .env | cut -d '=' -f2)
WEB_PORT=${WEB_PORT:-8080}

echo "Stopping bot..."
pkill -9 -f "node.*index.js"
pkill -9 -f "node.*src/index.js"
sleep 1
# Wait for port to be freed
for i in {1..10}; do
  if ! lsof -i:$WEB_PORT > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
echo "Bot stopped"
