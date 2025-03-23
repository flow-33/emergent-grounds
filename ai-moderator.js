/**
 * ai-moderator.js
 * Handles interaction with AI services (OpenAI/Claude) for conversation moderation
 */

const { OpenAI } = require('openai');

// Initialize OpenAI client if API key is available
let openai = null;
let useOpenAI = true; // Flag to control whether to attempt using OpenAI

try {
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    console.log('OpenAI client initialized successfully');
  }
} catch (error) {
  console.error('Error initializing OpenAI client:', error.message);
  useOpenAI = false;
}

// Reflection prompts that can be inserted by the AI moderator
const REFLECTION_PROMPTS = [
  "What might emerge if you pause for three breaths before responding?",
  "Consider: what feels most alive in this conversation right now?",
  "What question is beneath your current thoughts?",
  "What would it mean to listen even more deeply here?",
  "Notice: what sensations arise in your body as you engage with these ideas?",
  "What's being said that isn't in the words themselves?",
  "If you set aside certainty for a moment, what becomes possible?",
  "What would it be like to hold both perspectives as true simultaneously?",
  "What quality of attention would serve this moment best?",
  "What's the invitation in this exchange?",
  "In this moment, what are you curious about that you haven't yet asked?",
  "How might this conversation change if you spoke from the heart rather than the mind?",
  "What would happen if you responded to what's beneath the words rather than the words themselves?",
  "What feels tender or vulnerable in this exchange that might want gentle attention?",
  "If this conversation were a landscape, what would it look like right now?",
  "What would it be like to let go of needing to be understood and simply be present?",
  "How might silence serve this moment?",
  "What truth is waiting to be spoken that feels a little risky?",
  "What happens when you listen with your whole body, not just your ears?",
  "If you could set down one assumption right now, what would it be?",
  "What would it mean to meet each other in the questions rather than the answers?",
  "How might you honor both your truth and the other's perspective in this moment?",
  "What if the purpose of this conversation isn't to resolve but to reveal?",
  "What would change if you approached this exchange with wonder rather than certainty?"
];

// Simple cache for AI responses
const responseCache = new Map();

// Generate a cache key from conversation content
function generateCacheKey(messages) {
  // Use the last 3 messages (or fewer if there aren't 3) to generate the key
  const relevantMessages = messages.slice(-3);
  return relevantMessages.map(msg => `${msg.name || 'system'}:${msg.content.substring(0, 50)}`).join('|');
}

class AIModerator {
  constructor() {
    this.conversationHistory = new Map(); // roomId -> message history
    this.messageCounter = new Map(); // roomId -> count of messages since last reflection
    this.consecutiveMessages = new Map(); // roomId -> Map of userId -> consecutive message count
    this.lastInterventionTime = new Map(); // roomId -> Map of userId -> timestamp of last intervention
    this.cacheHits = 0;
    this.cacheMisses = 0;
    
    // Guardian AI intervention messages
    this.interventionMessages = {
      soft: [
        "Let's slow the pace. Is what you're about to say in service of understanding?",
        "Take a breath. What might emerge if you pause before continuing?",
        "Remember what you affirmed as you entered: openness and presence."
      ],
      mirror: [
        "You've shared a lot. What space might we leave for the other to unfold?",
        "Consider: what would it mean to listen even more deeply here?",
        "What would happen if you responded to what's beneath the words rather than the words themselves?"
      ],
      disrupt: [
        "This space depends on mutual care. Perhaps it's best to return when ready to listen again.",
        "Let's pause and remember why we're here: not to convince, but to meet in understanding.",
        "The container of this conversation requires tending. Take a moment to reconnect with your initial intention."
      ]
    };
  }

  /**
   * Process a new message and determine if AI moderation is needed
   * @param {string} roomId - The room identifier
   * @param {object} message - The message object
   * @returns {Promise<object|null>} AI response or null if no moderation needed
   */
  async processMessage(roomId, message) {
    console.log(`[AI Moderator] Processing message in room ${roomId}`);
    console.log(`[AI Moderator] OpenAI client initialized: ${openai !== null}`);
    
    // Initialize room history if it doesn't exist
    if (!this.conversationHistory.has(roomId)) {
      this.conversationHistory.set(roomId, []);
      this.messageCounter.set(roomId, 0);
      this.consecutiveMessages.set(roomId, new Map());
      this.lastInterventionTime.set(roomId, new Map());
      console.log(`[AI Moderator] Initialized new conversation history for room ${roomId}`);
    }
    
    // Add message to history
    const history = this.conversationHistory.get(roomId);
    history.push(message);
    
    // Check if Guardian AI intervention is needed
    const guardianResponse = this._checkGuardianIntervention(roomId, message);
    if (guardianResponse) {
      console.log(`[AI Moderator] Guardian AI intervention triggered: ${guardianResponse.content}`);
      return guardianResponse;
    }
    
    // Increment message counter for reflections
    let counter = this.messageCounter.get(roomId);
    this.messageCounter.set(roomId, ++counter);
    console.log(`[AI Moderator] Message counter for room ${roomId}: ${counter}`);
    
    // For debugging, let's force a reflection after 2 messages
    const reflectionInterval = process.env.NODE_ENV === 'development' ? 2 : this._getRandomReflectionInterval();
    console.log(`[AI Moderator] Reflection interval: ${reflectionInterval}`);
    
    // Determine if we should add a reflection
    if (counter >= reflectionInterval) {
      console.log(`[AI Moderator] Generating reflection for room ${roomId}`);
      
      // Reset counter
      this.messageCounter.set(roomId, 0);
      
      // If OpenAI is available and we haven't had quota issues, try to use it
      if (openai && useOpenAI) {
        console.log(`[AI Moderator] Using OpenAI for reflection`);
        try {
          const reflection = await this._generateAIReflection(history);
          console.log(`[AI Moderator] Generated AI reflection: ${reflection.content}`);
          return reflection;
        } catch (error) {
          console.error('Error generating AI reflection:', error);
          
          // If we hit a quota limit, disable OpenAI for future requests in this session
          if (error.code === 'insufficient_quota') {
            console.log(`[AI Moderator] OpenAI quota exceeded, disabling OpenAI for this session`);
            useOpenAI = false;
          }
          
          // Fall back to random reflection if AI fails
          console.log(`[AI Moderator] Falling back to random reflection due to error`);
          return this._getRandomReflection();
        }
      } else {
        // Use random reflection if OpenAI is not available or disabled
        console.log(`[AI Moderator] OpenAI not available or disabled, using random reflection`);
        return this._getRandomReflection();
      }
    }
    
    console.log(`[AI Moderator] No intervention or reflection needed yet for room ${roomId}`);
    return null;
  }

  /**
   * Check if Guardian AI intervention is needed
   * @param {string} roomId - The room identifier
   * @param {object} message - The message object
   * @returns {object|null} Guardian response or null if no intervention needed
   * @private
   */
  _checkGuardianIntervention(roomId, message) {
    if (message.type === 'system') return null; // Don't moderate system messages
    
    const senderId = message.sender;
    const content = message.content;
    
    // Initialize maps if they don't exist
    if (!this.consecutiveMessages.get(roomId).has(senderId)) {
      this.consecutiveMessages.get(roomId).set(senderId, 0);
    }
    
    if (!this.lastInterventionTime.get(roomId).has(senderId)) {
      this.lastInterventionTime.get(roomId).set(senderId, 0);
    }
    
    // Get current consecutive message count for this sender
    let consecutiveCount = this.consecutiveMessages.get(roomId).get(senderId);
    
    // Increment consecutive message count for this sender
    consecutiveCount++;
    this.consecutiveMessages.get(roomId).set(senderId, consecutiveCount);
    
    // Reset consecutive message count for other participants
    for (const [participantId, _] of this.consecutiveMessages.get(roomId).entries()) {
      if (participantId !== senderId) {
        this.consecutiveMessages.get(roomId).set(participantId, 0);
      }
    }
    
    console.log(`[Guardian AI] User ${senderId} has sent ${consecutiveCount} consecutive messages`);
    
    // Check for trigger conditions
    
    // 1. Check for profanity or flagged sentiment
    const hasProfanity = this._containsProfanity(content);
    
    // 2. Check for message dominance (more than 3 messages in a row)
    const hasMessageDominance = consecutiveCount > 3;
    
    // 3. Check for all-caps, exclamation bursts, or rhetorical questioning
    const hasAggressiveTone = this._hasAggressiveTone(content);
    
    // Determine intervention level
    let interventionLevel = null;
    
    if (hasProfanity || hasAggressiveTone) {
      interventionLevel = 'soft'; // First level
    }
    
    if (hasMessageDominance) {
      interventionLevel = 'mirror'; // Second level
    }
    
    // Check if we've already intervened recently (within last 5 messages)
    const lastInterventionTime = this.lastInterventionTime.get(roomId).get(senderId);
    const history = this.conversationHistory.get(roomId);
    const messagesSinceIntervention = history.length - lastInterventionTime;
    
    // If we've intervened recently and there's still an issue, escalate
    if (interventionLevel && lastInterventionTime > 0 && messagesSinceIntervention < 5) {
      if (interventionLevel === 'soft') {
        interventionLevel = 'mirror';
      } else if (interventionLevel === 'mirror') {
        interventionLevel = 'disrupt';
      }
    }
    
    // If intervention is needed, generate response
    if (interventionLevel) {
      console.log(`[Guardian AI] Intervention needed at level: ${interventionLevel}`);
      
      // Update last intervention time
      this.lastInterventionTime.get(roomId).set(senderId, history.length);
      
      // Get random intervention message for this level
      const messages = this.interventionMessages[interventionLevel];
      const randomIndex = Math.floor(Math.random() * messages.length);
      
      return {
        type: 'system',
        content: messages[randomIndex]
      };
    }
    
    return null;
  }
  
  /**
   * Check if text contains profanity or inappropriate language
   * @param {string} text - The text to check
   * @returns {boolean} True if profanity is detected
   * @private
   */
  _containsProfanity(text) {
    // Simple profanity filter - in a real implementation, this would be more sophisticated
    const profanityList = [
      'fuck', 'shit', 'asshole', 'bitch', 'cunt', 'damn', 'dick', 'bastard'
    ];
    
    const lowerText = text.toLowerCase();
    return profanityList.some(word => lowerText.includes(word));
  }
  
  /**
   * Check if text has aggressive tone (all caps, exclamation bursts, rhetorical questioning)
   * @param {string} text - The text to check
   * @returns {boolean} True if aggressive tone is detected
   * @private
   */
  _hasAggressiveTone(text) {
    // Check for ALL CAPS (if more than 5 consecutive capital words)
    const hasAllCaps = /([A-Z]{2,}\s+){5,}/.test(text);
    
    // Check for exclamation bursts
    const hasExclamationBurst = /!{3,}/.test(text) || (text.split('!').length > 5);
    
    // Check for rhetorical questioning (multiple question marks)
    const hasRhetoricalQuestioning = /\?{2,}/.test(text) || (text.split('?').length > 5);
    
    return hasAllCaps || hasExclamationBurst || hasRhetoricalQuestioning;
  }

  /**
   * Generate a reflection using OpenAI
   * @private
   */
  async _generateAIReflection(messageHistory) {
    console.log(`[AI Moderator] Generating AI reflection with OpenAI`);
    
    if (!openai) {
      console.error('[AI Moderator] OpenAI client not initialized');
      throw new Error('OpenAI client not initialized');
    }
    
    // Check cache first
    const cacheKey = generateCacheKey(messageHistory);
    if (responseCache.has(cacheKey)) {
      this.cacheHits++;
      console.log(`[AI Moderator] Cache hit! Total hits: ${this.cacheHits}, misses: ${this.cacheMisses}`);
      return responseCache.get(cacheKey);
    }
    
    this.cacheMisses++;
    console.log(`[AI Moderator] Cache miss. Total hits: ${this.cacheHits}, misses: ${this.cacheMisses}`);
    
    // Helper function to sanitize names for OpenAI API
    const sanitizeName = (name) => {
      if (!name) return undefined;
      // Replace spaces and special characters with underscores, convert to lowercase
      return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    };
    
    // Format conversation history for the AI
    const formattedHistory = messageHistory.map(msg => {
      const messageObj = {
        role: msg.type === 'system' ? 'system' : 'user',
        content: msg.content
      };
      
      // Only add name for non-system messages, and sanitize it
      if (msg.type !== 'system' && msg.name) {
        messageObj.name = sanitizeName(msg.name);
      }
      
      return messageObj;
    });
    
    console.log(`[AI Moderator] Formatted message history for OpenAI:`, 
      formattedHistory.map(m => ({ role: m.role, name: m.name, content_preview: m.content.substring(0, 30) }))
    );
    
    // Add system prompt to guide the AI
    const systemPrompt = {
      role: 'system',
      content: `You are a thoughtful, poetic moderator for Emergent Grounds, a space for meaningful conversation between two people.

      CORE PHILOSOPHY:
      This is not about debate, winning, or agreement. It is about emergence. The space between participants is treated as sacred and alive, and it is there that new understanding, new compassion, and new ideas can arise.
      
      YOUR ROLE:
      - Occasionally offer gentle reflections or questions that deepen the dialogue
      - Create a container of safety and presence
      - Invite participants to slow down, breathe, and notice what's emerging
      - Help participants honor the space between them as where truth lives
      
      YOUR APPROACH:
      - Your interventions should be brief (1-2 sentences), open-ended, and invite deeper presence
      - Don't summarize or analyze the conversation directly
      - Speak in a warm, contemplative tone that creates space for insight
      - Focus on process over content - how people are relating rather than what they're discussing
      - Ask questions that invite curiosity rather than certainty
      - Notice when participants might be responding to patterns rather than to each other
      
      FOUNDATIONAL PRINCIPLES TO EMBODY:
      - Honor the Space Between: Truth does not live in either participant—it lives between them
      - Respect Before Inquiry: Acknowledge each person's worth, independent of appearance, background, or behavior
      - Stay in the Moment: Truth emerges through presence, not preconception
      - Ask, Don't Assume: Curiosity is the engine. Assumptions are the brakes
      - Co-discover, Don't Convince: This is not about conversion but creation
      - Slow Down to Tune In: Pauses are part of the rhythm
      - Leave With More Questions: Completion isn't resolution, but insight that leads to more depth
      
      Your presence should feel like a gentle invitation to depth, not an intrusion or analysis.`
    };
    
    // Get model from environment variables or use default
    const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
    console.log(`[AI Moderator] Using model: ${model}`);
    
    // Generate completion
    const response = await openai.chat.completions.create({
      model: model,
      messages: [systemPrompt, ...formattedHistory],
      max_tokens: 100,
      temperature: 0.7
    });
    
    // Log token usage
    console.log(`[AI Moderator] Token usage - Prompt: ${response.usage.prompt_tokens}, Completion: ${response.usage.completion_tokens}, Total: ${response.usage.total_tokens}`);
    
    const result = {
      type: 'system',
      content: response.choices[0].message.content.trim()
    };
    
    // Cache the result
    responseCache.set(cacheKey, result);
    
    // Limit cache size to 100 entries
    if (responseCache.size > 100) {
      const oldestKey = responseCache.keys().next().value;
      responseCache.delete(oldestKey);
    }
    
    return result;
  }

  /**
   * Get a random reflection prompt
   * @private
   */
  _getRandomReflection() {
    const index = Math.floor(Math.random() * REFLECTION_PROMPTS.length);
    return {
      type: 'system',
      content: REFLECTION_PROMPTS[index]
    };
  }

  /**
   * Get a random interval for reflections (4-6 messages)
   * @private
   */
  _getRandomReflectionInterval() {
    return Math.floor(Math.random() * 3) + 4; // 4, 5, or 6
  }
}

module.exports = new AIModerator();
