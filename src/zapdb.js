import { open } from 'lmdb';
import { logger } from './logger.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Database for managing Zap payments and user balances
 */
export class ZapDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Initialize the database
   */
  async init() {
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });

      this.db = open({
        path: this.dbPath,
        compression: true,
      });

      logger.info('Zap database initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize zap database:', error);
      throw error;
    }
  }

  /**
   * Save a received zap
   * @param {object} zapData - Zap information
   * @param {string} zapData.sender - Sender's public key
   * @param {number} zapData.amount - Amount in satoshis
   * @param {string} zapData.zapRequest - Zap request event ID
   * @param {string} zapData.zapReceipt - Zap receipt event ID
   * @param {string} zapData.bolt11 - Lightning invoice
   */
  async saveZap(zapData) {
    try {
      const timestamp = Date.now();
      const zapId = `zap:${zapData.sender}:${timestamp}`;
      
      await this.db.put(zapId, {
        sender: zapData.sender,
        amount: zapData.amount,
        timestamp,
        zapRequest: zapData.zapRequest || null,
        zapReceipt: zapData.zapReceipt || null,
        bolt11: zapData.bolt11 || null,
        description: zapData.description || null,
      });

      // Update user balance
      await this.addToBalance(zapData.sender, zapData.amount);

      logger.info(`Zap saved: ${zapData.amount} sats from ${zapData.sender.substring(0, 8)}...`);
      return zapId;
    } catch (error) {
      logger.error('Failed to save zap:', error);
      return false;
    }
  }

  /**
   * Add amount to user's balance
   */
  async addToBalance(pubkey, amount) {
    try {
      const balanceKey = `balance:${pubkey}`;
      const currentBalance = await this.db.get(balanceKey) || { balance: 0, lastUpdated: 0 };
      
      const newBalance = {
        pubkey,
        balance: (currentBalance.balance || 0) + amount,
        lastUpdated: Date.now(),
      };

      await this.db.put(balanceKey, newBalance);
      
      logger.info(`Balance updated for ${pubkey.substring(0, 8)}...: ${newBalance.balance} sats`);
      return newBalance.balance;
    } catch (error) {
      logger.error('Failed to update balance:', error);
      return null;
    }
  }

  /**
   * Get user's balance
   */
  async getBalance(pubkey) {
    try {
      const balanceKey = `balance:${pubkey}`;
      const balanceData = await this.db.get(balanceKey);
      
      if (!balanceData) {
        return 0;
      }

      return balanceData.balance || 0;
    } catch (error) {
      logger.error('Failed to get balance:', error);
      return 0;
    }
  }

  /**
   * Get all zaps for a user
   */
  async getUserZaps(pubkey, limit = 50) {
    try {
      const zaps = [];
      const prefix = `zap:${pubkey}:`;

      for (const { key, value } of this.db.getRange({
        start: prefix,
        end: `${prefix}\xFF`,
        limit,
        reverse: true,
      })) {
        zaps.push(value);
      }

      return zaps;
    } catch (error) {
      logger.error('Failed to get user zaps:', error);
      return [];
    }
  }

  /**
   * Get all zaps (for admin/stats)
   */
  async getAllZaps(limit = 100) {
    try {
      const zaps = [];

      for (const { key, value } of this.db.getRange({
        start: 'zap:',
        end: 'zap:\xFF',
        limit,
        reverse: true,
      })) {
        zaps.push(value);
      }

      return zaps;
    } catch (error) {
      logger.error('Failed to get all zaps:', error);
      return [];
    }
  }

  /**
   * Get balance summary for all users
   */
  async getAllBalances() {
    try {
      const balances = [];

      for (const { key, value } of this.db.getRange({
        start: 'balance:',
        end: 'balance:\xFF',
      })) {
        balances.push(value);
      }

      return balances;
    } catch (error) {
      logger.error('Failed to get all balances:', error);
      return [];
    }
  }

  /**
   * Deduct amount from user's balance
   */
  async deductFromBalance(pubkey, amount) {
    try {
      const balanceKey = `balance:${pubkey}`;
      const currentBalance = await this.db.get(balanceKey) || { balance: 0 };
      
      if (currentBalance.balance < amount) {
        logger.warn(`Insufficient balance for ${pubkey.substring(0, 8)}...`);
        return false;
      }

      const newBalance = {
        pubkey,
        balance: currentBalance.balance - amount,
        lastUpdated: Date.now(),
      };

      await this.db.put(balanceKey, newBalance);
      
      logger.info(`Balance deducted for ${pubkey.substring(0, 8)}...: -${amount} sats, new balance: ${newBalance.balance} sats`);
      return newBalance.balance;
    } catch (error) {
      logger.error('Failed to deduct from balance:', error);
      return false;
    }
  }

  /**
   * Close the database
   */
  async close() {
    if (this.db) {
      await this.db.close();
      logger.info('Zap database closed');
    }
  }
}
