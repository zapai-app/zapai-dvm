import { logger } from './logger.js';

/**
 * Token bucket rate limiter for preventing API abuse
 */
export class RateLimiter {
  constructor(options = {}) {
    this.maxTokens = options.maxTokens || 100; // Max requests per window
    this.refillRate = options.refillRate || 10; // Tokens added per second
    this.windowMs = options.windowMs || 60000; // 1 minute window
    
    this.buckets = new Map(); // Per-user token buckets
    this.globalBucket = {
      tokens: this.maxTokens,
      lastRefill: Date.now(),
    };
    
    // Start refill interval
    this.startRefillInterval();
  }

  /**
   * Check if request is allowed for a user
   */
  async checkLimit(userId, cost = 1) {
    // Check global rate limit first
    if (!this.checkGlobalLimit(cost)) {
      logger.warn('Global rate limit exceeded');
      return {
        allowed: false,
        reason: 'Global rate limit exceeded. Please try again later.',
        retryAfter: this.getRetryAfter(this.globalBucket),
      };
    }

    // Check per-user rate limit
    const bucket = this.getUserBucket(userId);
    
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      logger.debug(`Rate limit OK for ${userId}. Tokens remaining: ${bucket.tokens}`);
      return { allowed: true };
    }

    logger.warn(`Rate limit exceeded for user ${userId}`);
    return {
      allowed: false,
      reason: 'Rate limit exceeded. Please wait before sending more messages.',
      retryAfter: this.getRetryAfter(bucket),
    };
  }

  /**
   * Check global rate limit
   */
  checkGlobalLimit(cost) {
    this.refillBucket(this.globalBucket);
    
    if (this.globalBucket.tokens >= cost) {
      this.globalBucket.tokens -= cost;
      return true;
    }
    
    return false;
  }

  /**
   * Get or create user bucket
   */
  getUserBucket(userId) {
    if (!this.buckets.has(userId)) {
      this.buckets.set(userId, {
        tokens: this.maxTokens,
        lastRefill: Date.now(),
      });
    }
    
    const bucket = this.buckets.get(userId);
    this.refillBucket(bucket);
    
    return bucket;
  }

  /**
   * Refill bucket based on time elapsed
   */
  refillBucket(bucket) {
    const now = Date.now();
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = (timePassed / 1000) * this.refillRate;
    
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  /**
   * Calculate retry after time in seconds
   */
  getRetryAfter(bucket) {
    const tokensNeeded = 1 - bucket.tokens;
    const secondsToWait = Math.ceil(tokensNeeded / this.refillRate);
    return Math.max(1, secondsToWait);
  }

  /**
   * Start automatic refill interval
   */
  startRefillInterval() {
    this.refillInterval = setInterval(() => {
      this.cleanupOldBuckets();
    }, 60000); // Cleanup every minute
  }

  /**
   * Cleanup old user buckets to prevent memory leaks
   */
  cleanupOldBuckets() {
    const now = Date.now();
    const maxAge = 3600000; // 1 hour
    
    let cleaned = 0;
    for (const [userId, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > maxAge) {
        this.buckets.delete(userId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} old rate limit buckets`);
    }
  }

  /**
   * Get rate limiter statistics
   */
  getStats() {
    return {
      activeBuckets: this.buckets.size,
      globalTokens: Math.floor(this.globalBucket.tokens),
      maxTokens: this.maxTokens,
      refillRate: this.refillRate,
    };
  }

  /**
   * Stop the rate limiter
   */
  stop() {
    if (this.refillInterval) {
      clearInterval(this.refillInterval);
    }
  }
}
