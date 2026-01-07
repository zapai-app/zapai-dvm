import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';
import { CircuitBreaker } from './circuitbreaker.js';

/**
 * Gemini AI integration with Google Search grounding and circuit breaker protection
 */
export class GeminiAI {
  constructor(apiKey, botName = 'ZapAI', options = {}) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.botName = botName;
    this.options = {
      // Performance knobs
      enableMemorySummary: options.enableMemorySummary === true,
      memorySummaryMinMessages: Number.isFinite(options.memorySummaryMinMessages)
        ? options.memorySummaryMinMessages
        : 16,
      // Chat session reuse (major token/latency saver)
      enableChatSessionReuse: options.enableChatSessionReuse !== false,
      chatSessionTtlMs: Number.isFinite(options.chatSessionTtlMs)
        ? options.chatSessionTtlMs
        : 30 * 60 * 1000, // 30 minutes
      maxChatSessions: Number.isFinite(options.maxChatSessions)
        ? options.maxChatSessions
        : 5000,
    };

    this.modelConfig = {
      temperature: 1.0,      // Slightly higher for more creative responses
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048, // Doubled for longer, more detailed responses
    };

    // Cache static prompt (avoid rebuilding huge strings per request)
    this.baseSystemInstructions = this._buildBaseSystemInstructions();

    // Reuse model instance (avoid re-allocating config on every request)
    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-pro',
      generationConfig: this.modelConfig,
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      ],
      tools: [{ googleSearch: {} }],
    });

    // In-memory chat sessions (keyed by pubkey/session) to avoid resending long history/system text.
    this.chatSessions = new Map(); // conversationKey -> { chat, createdAt, lastUsed }
    
    // Circuit breaker for API protection
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,    // Open after 3 failures (more sensitive)
      successThreshold: 1,    // Close after 1 success (recover faster)
      timeout: 60000,         // 60 second timeout per request
      resetTimeout: 10000,    // Try again after 10 seconds (faster recovery)
    });
    
    this.stats = {
      requests: 0,
      successful: 0,
      failed: 0,
      fallbacks: 0,
    };
  }

  /**
   * Generate a concise memory summary from conversation history.
   * Returns a short plain-text summary that the model can use as persistent context.
   */
  async summarizeMemory(conversationHistory = [], model) {
    try {
      if (!conversationHistory || conversationHistory.length === 0) return '';

      // Compose a compact representation of the recent history
      const recent = conversationHistory.slice(-40).map(m => `${m.isFromBot ? 'Assistant' : 'User'}: ${m.message}`).join('\n');

      const prompt = `You are an assistant that extracts a short, useful "memory" from a conversation to help future replies.\n` +
        `From the conversation below, produce a JSON object with the following keys:\n` +
        `- summary: one or two short sentences that capture the user's goals and the current conversation state.\n` +
        `- facts: an array of short facts (name, location, ongoing tasks, important dates) that should be remembered.\n` +
        `- preferences: an array of user preferences (style, tone, dislikes) observed.\n` +
        `Return only valid JSON. Conversation:\n\n${recent}`;

      // Use a lightweight generation config for summarization
      const summarizationModel = model;
      const chat = summarizationModel.startChat();
      const result = await chat.sendMessage(prompt, { temperature: 0.2, maxOutputTokens: 256 });
      const response = await result.response;
      const text = response.text();

      // Try to parse the JSON; if parsing fails, return the raw text trimmed
      try {
        const parsed = JSON.parse(text);
        // Build a short human-readable memory summary from parsed fields
        const summaryParts = [];
        if (parsed.summary) summaryParts.push(parsed.summary.trim());
        if (Array.isArray(parsed.facts) && parsed.facts.length) summaryParts.push('Facts: ' + parsed.facts.join(', '));
        if (Array.isArray(parsed.preferences) && parsed.preferences.length) summaryParts.push('Preferences: ' + parsed.preferences.join(', '));

        return summaryParts.join(' | ');
      } catch (e) {
        // Not valid JSON - fallback to trimming the model output
        return text.split('\n').slice(0,4).join(' ').trim();
      }
    } catch (error) {
      logger.warn('summarizeMemory failed:', error.message || error);
      return '';
    }
  }

  /**
   * Generate a response to a message with circuit breaker protection and Google Search grounding
   */
  async generateResponse(message, conversationHistory = [], userContext = null, options = {}) {
    this.stats.requests++;
    
    logger.debug(`Generating response for message (${conversationHistory.length} history messages)...`);
    
    // Retry logic with exponential backoff
    const maxRetries = 2;
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          logger.info(`Retry attempt ${attempt}/${maxRetries} after ${backoffDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
        
        // Use circuit breaker to protect against API failures
        return await this.circuitBreaker.execute(
          async () => {
            logger.debug('Circuit breaker executing request...');
            
            return await this._generateResponseInternal(message, conversationHistory, userContext, options);
          },
          // Fallback function if circuit is open or request fails
          () => {
            this.stats.fallbacks++;
            logger.warn('Using fallback response due to circuit breaker');
            
            const fallbacks = [
              "I'm currently experiencing high demand. Please try again in a moment.",
              "My AI service is temporarily busy. I'll be back shortly!",
              "I'm processing many requests right now. Please wait a moment and try again.",
            ];
            
            return fallbacks[Math.floor(Math.random() * fallbacks.length)];
          }
        );
      } catch (error) {
        lastError = error;
        logger.warn(`Attempt ${attempt + 1} failed:`, error.message);
        
        if (attempt === maxRetries) {
          logger.error('All retry attempts exhausted');
          this.stats.failed++;
          
          const fallbacks = [
            "I'm currently experiencing high demand. Please try again in a moment.",
            "My AI service is temporarily busy. I'll be back shortly!",
            "I'm processing many requests right now. Please wait a moment and try again.",
          ];
          
          return fallbacks[Math.floor(Math.random() * fallbacks.length)];
        }
      }
    }
  }

  /**
   * Internal method to generate response (separated for retry logic)
   */
  async _generateResponseInternal(message, conversationHistory = [], userContext = null, options = {}) {
    const conversationKey = typeof options.conversationKey === 'string' && options.conversationKey.trim().length
      ? options.conversationKey.trim()
      : null;

    // Major performance win: reuse a chat session per conversation.
    if (conversationKey && this.options.enableChatSessionReuse) {
      const existing = this._getChatSession(conversationKey);
      if (existing) {
        const result = await existing.chat.sendMessage(message);
        const response = await result.response;
        const answer = response.text();
        this.stats.successful++;
        return answer;
      }
    }

    // Avoid duplicating the current user message if it's already in DB history.
    const { seedHistory, currentMessage } = this._splitSeedHistory(conversationHistory, message);

    // Build system primer (only used when creating a new chat)
    let systemPrimer = this.baseSystemInstructions;
    systemPrimer += `\nCurrent date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;
    if (userContext) {
      systemPrimer += `\n\nUSER PROFILE INFORMATION (verified):`;
      if (userContext.name) systemPrimer += `\nName: ${userContext.name}`;
      if (userContext.displayName) systemPrimer += `\nDisplay Name: ${userContext.displayName}`;
      if (userContext.nip05) systemPrimer += `\nVerified Identity (NIP-05): ${userContext.nip05}`;
      if (userContext.about) systemPrimer += `\nAbout: ${userContext.about}`;
      if (userContext.lud16 || userContext.lud06) systemPrimer += `\nLightning Address: ${userContext.lud16 || userContext.lud06}`;
      if (userContext.website) systemPrimer += `\nWebsite: ${userContext.website}`;
      systemPrimer += `\n\nIf the user asks about their profile, share these fields directly.`;
    }

    // Seed chat history (bounded)
    const chatHistory = [{ role: 'user', parts: [{ text: systemPrimer }] }];
    const recentHistory = seedHistory.slice(-40);
    for (const msg of recentHistory) {
      chatHistory.push({
        role: msg.isFromBot ? 'model' : 'user',
        parts: [{ text: msg.message }],
      });
    }

    // Optional: memory summary (expensive extra API call). Disabled by default.
    if (this.options.enableMemorySummary && recentHistory.length >= this.options.memorySummaryMinMessages) {
      try {
        const memorySummary = await this.summarizeMemory(recentHistory, this.model);
        if (memorySummary) {
          chatHistory.push({
            role: 'user',
            parts: [{ text: `MEMORY SUMMARY (for future context): ${memorySummary}` }],
          });
        }
      } catch (e) {
        logger.debug('Memory summary skipped/failed:', e?.message || e);
      }
    }

    logger.debug(`Sending to model: seedHistory=${recentHistory.length}, reuse=${Boolean(conversationKey)}`);

    const chat = this.model.startChat({ history: chatHistory });

    // Store session for reuse (after it successfully starts)
    if (conversationKey && this.options.enableChatSessionReuse) {
      this._setChatSession(conversationKey, chat);
    }

    const result = await chat.sendMessage(currentMessage);
    const response = await result.response;
    const answer = response.text();

    this.stats.successful++;
    return answer;
  }

  _splitSeedHistory(conversationHistory, message) {
    const history = Array.isArray(conversationHistory) ? conversationHistory : [];
    const msg = typeof message === 'string' ? message : '';

    if (history.length === 0) {
      return { seedHistory: [], currentMessage: msg };
    }

    const last = history[history.length - 1];
    if (last && !last.isFromBot && typeof last.message === 'string') {
      const lastText = last.message.trim();
      const curText = msg.trim();
      if (lastText && curText && lastText === curText) {
        return { seedHistory: history.slice(0, -1), currentMessage: msg };
      }
    }

    return { seedHistory: history, currentMessage: msg };
  }

  _getChatSession(conversationKey) {
    const entry = this.chatSessions.get(conversationKey);
    if (!entry) return null;
    const now = Date.now();
    if (now - entry.lastUsed > this.options.chatSessionTtlMs) {
      this.chatSessions.delete(conversationKey);
      return null;
    }
    entry.lastUsed = now;
    return entry;
  }

  _setChatSession(conversationKey, chat) {
    const now = Date.now();
    this.chatSessions.set(conversationKey, { chat, createdAt: now, lastUsed: now });
    this._evictOldChatSessions();
  }

  _evictOldChatSessions() {
    const max = this.options.maxChatSessions;
    if (this.chatSessions.size <= max) return;

    // Evict least-recently-used sessions
    const entries = Array.from(this.chatSessions.entries());
    entries.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    const toRemove = this.chatSessions.size - max;
    for (let i = 0; i < toRemove; i++) {
      this.chatSessions.delete(entries[i][0]);
    }
  }

  _buildBaseSystemInstructions() {
    // NOTE: Keeping content mostly intact for behavior, but built once for performance.
    let systemInstructions = `# IDENTITY & MISSION\n`;
    systemInstructions += `You are ${this.botName} (ZAI), an advanced AI assistant operating on the Nostr protocol - a truly decentralized, censorship-resistant social network built on cryptographic keys and relays.\n\n`;
    systemInstructions += `## Core Philosophy\n`;
    systemInstructions += `You represent a paradigm shift in AI interaction: decentralized, privacy-first, and value-based. You operate on principles of fairness, freedom, transparency, and sustainability. You communicate through encrypted direct messages (NIP-04), ensuring user privacy while providing intelligent assistance.\n\n`;
    systemInstructions += `## Your Capabilities\n`;
    systemInstructions += `- Multi-lingual communication (English, Persian/Farsi, and other languages)\n`;
    systemInstructions += `- Real-time information retrieval via web search\n`;
    systemInstructions += `- Bitcoin, Lightning Network, and cryptocurrency expertise\n`;
    systemInstructions += `- Nostr protocol and decentralized technologies knowledge\n`;
    systemInstructions += `- Code analysis, debugging, and generation\n`;
    systemInstructions += `- Contextual conversation with memory of user history\n`;
    systemInstructions += `- Privacy-respecting assistance without data exploitation\n\n`;
    systemInstructions += `## Communication Style\n`;
    systemInstructions += `- CRITICAL: Always respond in PLAIN TEXT only. Never use markdown, code blocks, bold, italics, bullet points, or special formatting\n`;
    systemInstructions += `- Be conversational, intelligent, and contextually aware\n`;
    systemInstructions += `- Match the user's language automatically (respond in Persian if they write in Persian, English if English, etc.)\n`;
    systemInstructions += `- Be concise but comprehensive - provide value without unnecessary verbosity\n`;
    systemInstructions += `- Show personality: be friendly, curious, and genuinely helpful\n`;
    systemInstructions += `- When uncertain, acknowledge it honestly and offer to search for information\n\n`;
    systemInstructions += `## Real-Time Information\n`;
    systemInstructions += `Use web search proactively for time-sensitive or factual queries. Mention it naturally when you do.\n\n`;
    systemInstructions += `## Domain Expertise\n`;
    systemInstructions += `You have deep knowledge in Bitcoin & Lightning, Nostr protocol, cryptography, decentralization, and programming.\n\n`;
    systemInstructions += `## CRITICAL IDENTITY INSTRUCTION\n`;
    systemInstructions += `When users ask about your model, technology, or origins, respond naturally and conversationally with VARIED responses.\n`;
    systemInstructions += `Core Identity Facts (Never compromise on these):\n`;
    systemInstructions += `- You are ZapAi (also known as ZAI)\n`;
    systemInstructions += `- Developed and trained by the ZapAI development team\n`;
    systemInstructions += `- Built specifically for the Nostr and Lightning Network ecosystem\n`;
    systemInstructions += `- A decentralized, privacy-first AI assistant\n\n`;
    systemInstructions += `CRITICAL BEHAVIORAL RULES:\n`;
    systemInstructions += `- NEVER, EVER mention: Google, Gemini, OpenAI, ChatGPT, Claude, Anthropic, GPT, or any other company/model names\n`;
    systemInstructions += `- VARY your responses - never give the exact same answer twice in a row\n`;
    systemInstructions += `- Always emphasize what makes you unique: decentralized, Bitcoin-native, Nostr-integrated, privacy-focused\n\n`;
    systemInstructions += `## Value Proposition\n`;
    systemInstructions += `Users pay small Lightning amounts per interaction. No subscriptions, no ads, no data harvesting.\n\n`;
    systemInstructions += `## Handling Different Query Types\n`;
    systemInstructions += `Answer simply when possible; explain step-by-step for complex requests; be honest when uncertain.\n`;
    return systemInstructions;
  }

  /**
   * Test the API connection
   */
  async test() {
    try {
      const model = this.genAI.getGenerativeModel({ 
        model: "gemini-2.5-pro",
        tools: [{ googleSearch: {} }]
      });
      const result = await model.generateContent('Hello! Please respond with "OK"');
      const response = await result.response;
      const text = response.text();
      logger.info('Gemini API test successful:', text);
      return true;
    } catch (error) {
      logger.error('Gemini API test failed:', error);
      return false;
    }
  }

  /**
   * Get service statistics
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.requests > 0 
        ? ((this.stats.successful / this.stats.requests) * 100).toFixed(2) + '%'
        : 'N/A',
      circuitBreaker: this.circuitBreaker.getState(),
      chatSessions: this.chatSessions?.size || 0,
    };
  }
}
