# 🐳 Docker Deployment Guide

## Quick Start

### 1. Build and Run with Docker Compose (Recommended)

```bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down

# Stop and remove volumes (WARNING: deletes conversation data)
docker-compose down -v
```

### 2. Build and Run with Docker CLI

```bash
# Build the image
docker build -t zapai-dvm .

# Run the container
docker run -d \
  --name zapai-bot \
  --env-file .env \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  zapai-dvm

# View logs
docker logs -f zapai-bot

# Stop the container
docker stop zapai-bot

# Remove the container
docker rm zapai-bot
```

## Configuration

Make sure your `.env` file is properly configured:

```env
BOT_PRIVATE_KEY=nsec1...
GEMINI_API_KEY=your_api_key
NOSTR_RELAYS=wss://relay.nostr.band,wss://relay.damus.io,wss://nos.lol
WEB_PORT=3000
MAX_CONCURRENT=10
MAX_QUEUE_SIZE=10000
RATE_LIMIT_MAX_TOKENS=50
RATE_LIMIT_REFILL_RATE=5
```

## Container Management

### View Container Status
```bash
docker-compose ps
```

### View Real-time Logs
```bash
docker-compose logs -f zapai-bot
```

### Restart the Bot
```bash
docker-compose restart
```

### Update and Rebuild
```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose up -d --build
```

### Access Container Shell
```bash
docker-compose exec zapai-bot sh
```

## Health Check

The container includes automatic health checks:

```bash
# Check container health
docker inspect --format='{{.State.Health.Status}}' zapai-dvm

# Manual health check
curl http://localhost:3000/health
```

Health statuses:
- `healthy` - Bot is running normally
- `unhealthy` - Bot has issues (queue full or circuit breaker open)
- `starting` - Container is starting up

## Data Persistence

Conversation data is stored in `./data` directory:
- Automatically mounted as volume
- Persists across container restarts
- Back up this directory regularly

```bash
# Backup conversation data
tar -czf backup-$(date +%Y%m%d).tar.gz data/

# Restore from backup
tar -xzf backup-20251015.tar.gz
```

## Monitoring

### Access Web Dashboard
```
http://localhost:3000
```

### Check Statistics via API
```bash
curl http://localhost:3000/api/status | jq
```

### View Resource Usage
```bash
docker stats zapai-dvm
```

## Troubleshooting

### Container Won't Start
```bash
# Check logs
docker-compose logs zapai-bot

# Verify environment variables
docker-compose config

# Check if port is already in use
lsof -i :3000
```

### High Memory Usage
```bash
# Check resource usage
docker stats zapai-dvm

# Adjust limits in docker-compose.yml
deploy:
  resources:
    limits:
      memory: 512M  # Reduce if needed
```

### Database Issues
```bash
# Stop container
docker-compose down

# Clear database (WARNING: loses all conversations)
rm -rf data/conversations

# Restart
docker-compose up -d
```

## Production Deployment

### Using Docker Swarm
```bash
docker stack deploy -c docker-compose.yml zapai
```

### Using Kubernetes
Convert with Kompose:
```bash
kompose convert -f docker-compose.yml
kubectl apply -f .
```

### Behind Reverse Proxy (Nginx)
```nginx
server {
    listen 80;
    server_name zapai.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Security Best Practices

1. **Never commit `.env` file**
   ```bash
   echo ".env" >> .gitignore
   ```

2. **Run as non-root user** (already configured)

3. **Limit resources** (configured in docker-compose.yml)

4. **Regular updates**
   ```bash
   docker-compose pull
   docker-compose up -d
   ```

5. **Monitor logs**
   ```bash
   docker-compose logs --tail=100 -f
   ```

## Multi-Instance Deployment

To run multiple instances:

```bash
# Instance 1
docker-compose -p zapai1 up -d

# Instance 2 (different port)
WEB_PORT=3001 docker-compose -p zapai2 up -d

# Instance 3 (different port)
WEB_PORT=3002 docker-compose -p zapai3 up -d
```

Then use a load balancer (Nginx/HAProxy) to distribute traffic.

## Container Size

Optimized multi-stage build:
- Base image: `node:20-alpine` (~180MB)
- Final image: ~250MB
- Memory usage: 200-500MB (depending on load)

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_PRIVATE_KEY` | - | Nostr private key (required) |
| `GEMINI_API_KEY` | - | Google Gemini API key (required) |
| `NOSTR_RELAYS` | - | Comma-separated relay URLs (required) |
| `BOT_NAME` | ZapAI | Bot display name |
| `WEB_PORT` | 3000 | Web dashboard port |
| `BOT_RESPONSE_DELAY` | 2000 | Delay before responding (ms) |
| `MAX_CONCURRENT` | 10 | Concurrent message processing |
| `MAX_QUEUE_SIZE` | 10000 | Maximum queue buffer |
| `RATE_LIMIT_MAX_TOKENS` | 50 | Requests per user per minute |
| `RATE_LIMIT_REFILL_RATE` | 5 | Token refill rate per second |

## Support

For issues or questions:
1. Check logs: `docker-compose logs -f`
2. Verify health: `curl http://localhost:3000/health`
3. Check stats: `curl http://localhost:3000/api/status`

---

**Your bot is now containerized and ready for production! 🐳**
