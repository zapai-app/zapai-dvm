import { logger } from './logger.js';

/**
 * High-performance message queue for handling thousands of concurrent requests
 */
export class MessageQueue {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 10; // Process 10 messages simultaneously
    this.maxQueueSize = options.maxQueueSize || 10000; // Max 10k messages in queue
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelay = options.retryDelay || 1000; // 1 second
    this.timeout = options.timeout || 30000; // 30 seconds per message
    
    this.queue = [];
    this.processing = new Set();
    this.stats = {
      processed: 0,
      failed: 0,
      retried: 0,
      dropped: 0,
      avgProcessTime: 0,
      totalProcessTime: 0,
    };
    
    this.isRunning = false;
    this._drainScheduled = false;
  }

  /**
   * Add a message to the queue
   */
  async enqueue(task) {
    // Check queue size limit
    if (this.queue.length >= this.maxQueueSize) {
      logger.warn(`Queue full! Dropping message. Queue size: ${this.queue.length}`);
      this.stats.dropped++;
      throw new Error('Queue is full');
    }

    const queueItem = {
      task,
      attempts: 0,
      addedAt: Date.now(),
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    this.queue.push(queueItem);
    logger.debug(`Message queued. Queue size: ${this.queue.length}, Processing: ${this.processing.size}`);

    // Start processing if not already running
    if (!this.isRunning) {
      this.start();
    }

    // Trigger processing immediately (event-driven, no polling)
    this._wake();

    return queueItem.id;
  }

  /**
   * Start processing the queue
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    logger.info('Message queue started');

    // Process messages (event-driven)
    this._wake();
  }

  _wake() {
    if (!this.isRunning) return;
    if (this._drainScheduled) return;
    this._drainScheduled = true;
    setImmediate(() => {
      this._drainScheduled = false;
      this._drain();
    });
  }

  async _drain() {
    if (!this.isRunning) return;

    while (this.isRunning && this.processing.size < this.maxConcurrent && this.queue.length > 0) {
      const queueItem = this.queue.shift();
      if (!queueItem) break;

      this.processing.add(queueItem.id);

      this.processMessage(queueItem)
        .finally(() => {
          this.processing.delete(queueItem.id);
          this._wake();
        });
    }
  }

  /**
   * Process a single message with retry logic
   */
  async processMessage(queueItem) {
    const startTime = Date.now();
    queueItem.attempts++;

    try {
      logger.debug(`Processing message ${queueItem.id} (attempt ${queueItem.attempts}/${this.retryAttempts})`);

      // Execute the task with timeout
      await this.executeWithTimeout(queueItem.task, this.timeout);

      // Success
      const processTime = Date.now() - startTime;
      this.stats.processed++;
      this.stats.totalProcessTime += processTime;
      this.stats.avgProcessTime = this.stats.totalProcessTime / this.stats.processed;

      logger.debug(`Message ${queueItem.id} processed successfully in ${processTime}ms`);
      
    } catch (error) {
      logger.error(`Failed to process message ${queueItem.id}:`, error.message);

      // Retry logic
      if (queueItem.attempts < this.retryAttempts) {
        this.stats.retried++;
        logger.info(`Retrying message ${queueItem.id} (${queueItem.attempts}/${this.retryAttempts})`);
        
        // Add back to queue with delay
        await this.sleep(this.retryDelay * queueItem.attempts);
        this.queue.unshift(queueItem); // Add to front for priority
        
      } else {
        // Max retries reached
        this.stats.failed++;
        logger.error(`Message ${queueItem.id} failed after ${this.retryAttempts} attempts`);
      }
    }
  }

  /**
   * Execute task with timeout
   */
  async executeWithTimeout(task, timeout) {
    return Promise.race([
      task(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Task timeout')), timeout)
      ),
    ]);
  }

  /**
   * Stop the queue
   */
  async stop() {
    logger.info('Stopping message queue...');
    this.isRunning = false;

    // Wait for all processing messages to complete
    while (this.processing.size > 0) {
      logger.info(`Waiting for ${this.processing.size} messages to complete...`);
      await this.sleep(1000);
    }

    logger.info('Message queue stopped');
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      queueSize: this.queue.length,
      processing: this.processing.size,
      processed: this.stats.processed,
      failed: this.stats.failed,
      retried: this.stats.retried,
      dropped: this.stats.dropped,
      avgProcessTime: Math.round(this.stats.avgProcessTime),
      successRate: this.stats.processed > 0 
        ? ((this.stats.processed / (this.stats.processed + this.stats.failed)) * 100).toFixed(2) + '%'
        : 'N/A',
    };
  }

  /**
   * Clear the queue
   */
  clear() {
    const clearedCount = this.queue.length;
    this.queue = [];
    logger.info(`Cleared ${clearedCount} messages from queue`);
    return clearedCount;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
