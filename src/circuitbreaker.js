import { logger } from './logger.js';

/**
 * Circuit breaker states
 */
const STATE = {
  CLOSED: 'CLOSED',     // Normal operation
  OPEN: 'OPEN',         // Blocking requests due to failures
  HALF_OPEN: 'HALF_OPEN', // Testing if service recovered
};

/**
 * Circuit breaker for protecting against cascading failures
 */
export class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5; // Open after 5 failures
    this.successThreshold = options.successThreshold || 2; // Close after 2 successes
    this.timeout = options.timeout || 60000; // 1 minute
    this.resetTimeout = options.resetTimeout || 30000; // Try again after 30 seconds
    
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    
    this.stats = {
      totalRequests: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      totalRejected: 0,
      stateChanges: 0,
    };
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute(fn, fallback = null) {
    this.stats.totalRequests++;

    // Check if circuit is open
    if (this.state === STATE.OPEN) {
      if (Date.now() < this.nextAttempt) {
        this.stats.totalRejected++;
        logger.warn('Circuit breaker is OPEN. Request rejected.');
        
        if (fallback) {
          return fallback();
        }
        
        throw new Error('Service temporarily unavailable. Circuit breaker is open.');
      }
      
      // Try half-open state
      this.state = STATE.HALF_OPEN;
      this.stats.stateChanges++;
      logger.info('Circuit breaker entering HALF_OPEN state');
    }

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(fn, this.timeout);
      
      // Success
      this.onSuccess();
      return result;
      
    } catch (error) {
      // Failure
      this.onFailure();
      
      if (fallback) {
        logger.warn('Circuit breaker failure, using fallback');
        return fallback();
      }
      
      throw error;
    }
  }

  /**
   * Execute with timeout
   */
  async executeWithTimeout(fn, timeout) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Circuit breaker timeout')), timeout)
      ),
    ]);
  }

  /**
   * Handle successful execution
   */
  onSuccess() {
    this.failures = 0;
    this.stats.totalSuccesses++;

    if (this.state === STATE.HALF_OPEN) {
      this.successes++;
      
      if (this.successes >= this.successThreshold) {
        this.close();
      }
    }
  }

  /**
   * Handle failed execution
   */
  onFailure() {
    this.failures++;
    this.successes = 0;
    this.stats.totalFailures++;

    logger.warn(`Circuit breaker failure count: ${this.failures}/${this.failureThreshold}`);

    if (this.failures >= this.failureThreshold) {
      this.open();
    }
  }

  /**
   * Open the circuit (block requests)
   */
  open() {
    if (this.state === STATE.OPEN) return;
    
    this.state = STATE.OPEN;
    this.nextAttempt = Date.now() + this.resetTimeout;
    this.stats.stateChanges++;
    
    logger.error(`Circuit breaker OPENED. Will retry after ${this.resetTimeout}ms`);
  }

  /**
   * Close the circuit (allow requests)
   */
  close() {
    if (this.state === STATE.CLOSED) return;
    
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.stats.stateChanges++;
    
    logger.info('Circuit breaker CLOSED. Service recovered.');
  }

  /**
   * Get circuit breaker state
   */
  getState() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      nextAttempt: this.state === STATE.OPEN 
        ? new Date(this.nextAttempt).toISOString()
        : null,
      stats: this.stats,
    };
  }

  /**
   * Force reset the circuit breaker
   */
  reset() {
    this.close();
    logger.info('Circuit breaker manually reset');
  }
}
