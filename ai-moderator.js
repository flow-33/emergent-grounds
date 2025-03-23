/**
 * ai-moderator.js
 * Handles interaction with AI services (OpenAI/Claude) for conversation moderation
 * 
 * Updated with layered moderation system:
 * - Layer 1: Client-side tone caution (TensorFlow.js) - implemented in public/js/harm-detection.js
 * - Layer 2: Server-side harm detection (Perspective API) - implemented here
 * - Layer 3: Contextual + relational insight (OpenAI GPT-3.5) - enhanced here
 */

const { OpenAI } = require('openai');
const perspectiveAPI = require('./perspective-api');

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

// Moderation tone types
const TONE = {
  REFLECTIVE: 'reflective', // Gentle, metaphorical, spacious (default)
  GROUNDED: 'grounded',     // Practical, coaching, human
  DIRECTIVE: 'directive'    // Firm, respectful intervention
};

// Reflection prompts that can be inserted by the AI moderator
const REFLECTION_PROMPTS = [
  // More concrete and accessible reflections while maintaining warmth
  "What stands out to you most in what's been shared so far?",
  "Take a moment to notice: what are you feeling right now in this conversation?",
  "What question would help you understand the other person better?",
  "Is there something you'd like to explore further in what's been shared?",
  "What part of this conversation feels most meaningful to you?",
  "If you could ask one question right now, what would it be?",
  "What might happen if you shared something you're genuinely curious about?",
  "Is there a different perspective you haven't considered yet?",
  "What would help this conversation go deeper?",
  "What's one thing you've heard that resonates with you?",
  "Is there something you'd like to understand better about what's been shared?",
  "What feels important but hasn't been said yet?",
  "How might you respond if you set aside the need to be right?",
  "What would be helpful to clarify before moving forward?",
  "What's one thing you appreciate about this exchange so far?",
  "What would it be like to ask about what matters most to the other person?",
  "Is there a connection between your experiences that hasn't been explored?",
  "What would a thoughtful response look like right now?",
  "What's one assumption you might be making that could be worth examining?",
  "How might listening differently change what you hear?",
  "What would help create more understanding between you?",
  "Is there something you're holding back that might be valuable to share?",
  "What might you learn if you approached this with curiosity?",
  "What would support a more meaningful exchange right now?"
];

// Conversation starter prompts for beginning of conversations
const CONVERSATION_STARTERS = [
  "One hope I carry into this conversation is...",
  "What's something you've changed your mind about recently?",
  "What's something you wish more people asked you?",
  "What's a question that's been on your mind lately?",
  "What's something you're learning about yourself these days?",
  "What matters to you that you rarely get to talk about?"
];

// Simple cache for AI responses
const responseCache = new Map();

// Cooldown tracking for users showing signs of agitation
const userCooldowns = new Map(); // roomId -> Map of userId -> {until: timestamp, level: number}

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
    this.conversationStarters = new Map(); // roomId -> boolean (whether starters should be shown)
    this.totalMessages = new Map(); // roomId -> total message count in conversation
    this.userDisruptionScores = new Map(); // roomId -> Map of userId -> disruption score
    this.userMessageHistory = new Map(); // roomId -> Map of userId -> array of recent messages
    this.moderationTones = new Map(); // roomId -> Map of userId -> current tone (reflective, grounded, directive)
    this.distressSignals = new Map(); // roomId -> Map of userId -> boolean (whether user has shown distress)
    this.urgencyOverrides = new Map(); // roomId -> Map of userId -> timestamp of last urgency override
    this.cacheHits = 0;
    this.cacheMisses = 0;
    
    // Guardian AI intervention messages by tone type
    this.interventionMessages = {
      // Reflective tone (gentle, metaphorical, spacious)
      [TONE.REFLECTIVE]: {
        soft: [
          "Take a breath. What might emerge if you pause before continuing?",
          "Let's slow down for a moment. Is what you're about to say helping build understanding?",
          "A gentle reminder: this space thrives on thoughtful exchanges."
        ],
        mirror: [
          "You've shared a lot. What space might we leave for the other to unfold?",
          "I notice you've been contributing actively. How might we create balance in this conversation?",
          "What might happen if you took time to reflect on what's been shared before adding more?"
        ],
        disrupt: [
          "This space depends on mutual care. Perhaps it's best to return when ready to listen again.",
          "Let's pause and remember why we're here: to connect, not to convince.",
          "The quality of our conversation matters. Let's take a moment to reset our intentions."
        ],
        forceDisconnect: [
          "This conversation requires mutual respect. You've been disconnected to protect the space.",
          "Due to repeated violations, you've been removed from this conversation.",
          "This space has clear boundaries. You've been disconnected due to harmful behavior."
        ]
      },
      
      // Grounded tone (practical, coaching, human)
      [TONE.GROUNDED]: {
        soft: [
          "Let's pause for a moment. Consider if this approach is helping the conversation.",
          "Take a moment to reflect on what you're trying to communicate here.",
          "This conversation works best when we slow down and listen to each other."
        ],
        mirror: [
          "You've been sharing quite a bit. Let's make space for the other person now.",
          "I notice you've sent several messages in a row. How about giving some space for a response?",
          "Consider how the conversation might benefit from more balanced participation."
        ],
        disrupt: [
          "This conversation needs a reset. Let's take a step back and remember why we're here.",
          "The tone is getting heated. Let's pause and return to a more constructive approach.",
          "We need to rebalance this exchange. Take a moment to consider a different approach."
        ],
        forceDisconnect: [
          "Due to repeated violations of our community guidelines, you've been disconnected.",
          "This conversation has been ended due to continued disruptive behavior.",
          "You've been removed from this conversation to maintain a safe space for all participants."
        ]
      },
      
      // Directive tone (firm, respectful intervention)
      [TONE.DIRECTIVE]: {
        soft: [
          "Stop and consider: is this message helping build understanding?",
          "Your tone is affecting the conversation. Please adjust your approach.",
          "This is a reminder to maintain respectful communication."
        ],
        mirror: [
          "You're dominating the conversation. Please allow the other person to respond.",
          "Your messages are taking up most of the space. Step back and listen.",
          "Please be mindful of balance in this conversation."
        ],
        disrupt: [
          "This approach isn't working. Please change your tone or take a break.",
          "Your communication style is disrupting the conversation. A significant change is needed.",
          "This conversation cannot continue productively with this approach."
        ],
        forceDisconnect: [
          "Your behavior violates our community standards. You've been disconnected.",
          "Due to continued disruptive behavior, you've been removed from this conversation.",
          "This conversation has been terminated due to repeated violations of our guidelines."
        ]
      }
    };
    
    // De-escalation coaching messages
    this.deEscalationMessages = {
      mentoring: [
        "Would you like help rephrasing that in a way that holds your truth while respecting theirs?",
        "I notice tension rising. Would it help to explore a different way to express your perspective?",
        "Sometimes a shift in wording can make all the difference. Would you like a suggestion?"
      ],
      examples: [
        "Here's one way it could sound while still sharing your view: 'I see this differently because...'",
        "Consider starting with 'From my perspective...' rather than stating your view as fact.",
        "Try framing it as 'I've had a different experience where...' to keep the conversation open."
      ]
    };
    
    // Cooldown messages when user input is temporarily disabled
    this.cooldownMessages = [
      "Let's take a breath before continuing. You'll be able to type again shortly.",
      "A moment of pause can help us respond thoughtfully. You can continue in a few seconds.",
      "Taking a brief pause. Your input will be available again soon."
    ];
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
      this.conversationStarters.set(roomId, true); // Enable conversation starters for new rooms
      this.totalMessages.set(roomId, 0);
      this.userDisruptionScores.set(roomId, new Map());
      this.userMessageHistory.set(roomId, new Map());
      console.log(`[AI Moderator] Initialized new conversation history for room ${roomId}`);
    }
    
    // Add message to history and increment total message count
    const history = this.conversationHistory.get(roomId);
    history.push(message);
    
    const totalMsgCount = this.totalMessages.get(roomId) + 1;
    this.totalMessages.set(roomId, totalMsgCount);
    console.log(`[AI Moderator] Total messages in room ${roomId}: ${totalMsgCount}`);
    
    // Track user message history for context analysis
    if (message.type !== 'system') {
      if (!this.userMessageHistory.get(roomId).has(message.sender)) {
        this.userMessageHistory.get(roomId).set(message.sender, []);
      }
      
      const userHistory = this.userMessageHistory.get(roomId).get(message.sender);
      userHistory.push(message);
      
      // Keep only the last 10 messages per user to avoid memory issues
      if (userHistory.length > 10) {
        userHistory.shift();
      }
    }
    
    // Check if user is in cooldown
    if (message.type !== 'system' && this._isUserInCooldown(roomId, message.sender)) {
      console.log(`[AI Moderator] User ${message.sender} is in cooldown, sending reminder`);
      return {
        type: 'system',
        content: this._getRandomCooldownMessage(),
        metadata: { cooldown: true }
      };
    }
    
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
    
    // Determine dynamic reflection interval based on conversation stage
    const reflectionInterval = this._getDynamicReflectionInterval(roomId);
    console.log(`[AI Moderator] Dynamic reflection interval: ${reflectionInterval}`);
    
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
    
    // Disable conversation starters after a few messages
    if (this.conversationStarters.get(roomId) && totalMsgCount >= 5) {
      console.log(`[AI Moderator] Disabling conversation starters for room ${roomId} after ${totalMsgCount} messages`);
      this.conversationStarters.set(roomId, false);
    }
    
    console.log(`[AI Moderator] No intervention or reflection needed yet for room ${roomId}`);
    return null;
  }
  
  /**
   * Get conversation starters if they should be shown
   * @param {string} roomId - The room identifier
   * @returns {string[]|null} Array of conversation starters or null if they shouldn't be shown
   */
  getConversationStarters(roomId) {
    if (!this.conversationStarters.has(roomId)) {
      this.conversationStarters.set(roomId, true);
    }
    
    if (this.conversationStarters.get(roomId)) {
      // Get 3 random starters
      const shuffled = [...CONVERSATION_STARTERS].sort(() => 0.5 - Math.random());
      return shuffled.slice(0, 3);
    }
    
    return null;
  }
  
  /**
   * Check if a user is in cooldown period
   * @param {string} roomId - The room identifier
   * @param {string} userId - The user identifier
   * @returns {boolean} True if user is in cooldown
   * @private
   */
  _isUserInCooldown(roomId, userId) {
    if (!userCooldowns.has(roomId)) {
      userCooldowns.set(roomId, new Map());
      return false;
    }
    
    const roomCooldowns = userCooldowns.get(roomId);
    if (!roomCooldowns.has(userId)) {
      return false;
    }
    
    const cooldown = roomCooldowns.get(userId);
    const now = Date.now();
    
    if (now < cooldown.until) {
      return true;
    } else {
      // Cooldown expired
      roomCooldowns.delete(userId);
      return false;
    }
  }
  
  /**
   * Set a cooldown period for a user
   * @param {string} roomId - The room identifier
   * @param {string} userId - The user identifier
   * @param {number} level - The escalation level (1, 2, 3)
   * @private
   */
  _setUserCooldown(roomId, userId, level) {
    if (!userCooldowns.has(roomId)) {
      userCooldowns.set(roomId, new Map());
    }
    
    const roomCooldowns = userCooldowns.get(roomId);
    
    // Calculate cooldown duration based on level (10s, 20s, 30s)
    const durationSeconds = level * 10;
    const durationMs = durationSeconds * 1000; // Convert to milliseconds
    
    roomCooldowns.set(userId, {
      until: Date.now() + durationMs,
      level: level,
      durationSeconds: durationSeconds
    });
    
    console.log(`[AI Moderator] Set cooldown for user ${userId} in room ${roomId} for ${durationSeconds}s (level ${level})`);
    
    // Return the cooldown duration in seconds
    return durationSeconds;
  }
  
  /**
   * Get a random cooldown message
   * @returns {string} A random cooldown message
   * @private
   */
  _getRandomCooldownMessage() {
    const index = Math.floor(Math.random() * this.cooldownMessages.length);
    return this.cooldownMessages[index];
  }
  
  /**
   * Get dynamic reflection interval based on conversation stage
   * @param {string} roomId - The room identifier
   * @returns {number} The number of messages before next reflection
   * @private
   */
  _getDynamicReflectionInterval(roomId) {
    // For development environment, use fixed interval for easier testing
    if (process.env.NODE_ENV === 'development') {
      return 2;
    }
    
    const totalMessages = this.totalMessages.get(roomId);
    
    // Early conversation (first few exchanges): 2-3 messages
    if (totalMessages < 5) {
      return Math.floor(Math.random() * 2) + 2; // 2-3
    }
    
    // After ~10 messages, check if conversation is respectful and balanced
    if (totalMessages > 10) {
      // Check if there have been any interventions
      const interventions = this.lastInterventionTime.get(roomId);
      let hasInterventions = false;
      
      for (const [_, time] of interventions.entries()) {
        if (time > 0) {
          hasInterventions = true;
          break;
        }
      }
      
      // If no interventions, increase interval to 6-8
      if (!hasInterventions) {
        return Math.floor(Math.random() * 3) + 6; // 6-8
      }
    }
    
    // Default interval: 4-6 messages
    return Math.floor(Math.random() * 3) + 4; // 4-6
  }

  /**
   * Check if Guardian AI intervention is needed
   * @param {string} roomId - The room identifier
   * @param {object} message - The message object
   * @returns {Promise<object|null>} Guardian response or null if no intervention needed
   * @private
   */
  async _checkGuardianIntervention(roomId, message) {
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
    
    if (!this.userDisruptionScores.get(roomId).has(senderId)) {
      this.userDisruptionScores.get(roomId).set(senderId, 0);
    }
    
    if (!this.moderationTones.get(roomId)) {
      this.moderationTones.set(roomId, new Map());
    }
    
    if (!this.moderationTones.get(roomId).has(senderId)) {
      this.moderationTones.get(roomId).set(senderId, TONE.REFLECTIVE); // Default tone
    }
    
    if (!this.distressSignals.get(roomId)) {
      this.distressSignals.set(roomId, new Map());
    }
    
    if (!this.urgencyOverrides.get(roomId)) {
      this.urgencyOverrides.set(roomId, new Map());
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
    
    // Get current disruption score
    let disruptionScore = this.userDisruptionScores.get(roomId).get(senderId);
    
    // Layer 2: Server-side harm detection using Perspective API
    let perspectiveResult = null;
    try {
      perspectiveResult = await perspectiveAPI.analyzeText(content);
      console.log(`[Guardian AI] Perspective API analysis:`, 
        Object.entries(perspectiveResult.attributeScores || {})
          .map(([attr, score]) => `${attr}: ${score.toFixed(2)}`)
          .join(', ')
      );
    } catch (error) {
      console.error(`[Guardian AI] Error analyzing text with Perspective API:`, error);
      // Continue with other checks if Perspective API fails
    }
    
    // Check for trigger conditions
    
    // 1. Check for harmful content using Perspective API
    let hasProfanity = false;
    let hasIdentityAttack = false;
    let hasThreat = false;
    let hasSevereToxicity = false;
    
    if (perspectiveResult && !perspectiveResult.error) {
      // Check for specific attributes
      const scores = perspectiveResult.attributeScores;
      
      if (scores.PROFANITY && scores.PROFANITY >= 0.8) {
        hasProfanity = true;
        console.log(`[Guardian AI] Profanity detected by Perspective API: ${scores.PROFANITY.toFixed(2)}`);
      }
      
      if (scores.IDENTITY_ATTACK && scores.IDENTITY_ATTACK >= 0.8) {
        hasIdentityAttack = true;
        console.log(`[Guardian AI] Identity attack detected by Perspective API: ${scores.IDENTITY_ATTACK.toFixed(2)}`);
      }
      
      if (scores.THREAT && scores.THREAT >= 0.8) {
        hasThreat = true;
        console.log(`[Guardian AI] Threat detected by Perspective API: ${scores.THREAT.toFixed(2)}`);
      }
      
      if (scores.SEVERE_TOXICITY && scores.SEVERE_TOXICITY >= 0.8) {
        hasSevereToxicity = true;
        console.log(`[Guardian AI] Severe toxicity detected by Perspective API: ${scores.SEVERE_TOXICITY.toFixed(2)}`);
      }
    } else {
      // Fall back to basic pattern matching if Perspective API fails
      hasProfanity = this._containsProfanity(content);
    }
    
    // 2. Check for message dominance (more than 4 messages in a row)
    const hasMessageDominance = consecutiveCount > 4;
    
    // 3. Check for all-caps, exclamation bursts, or rhetorical questioning
    const hasAggressiveTone = this._hasAggressiveTone(content);
    
    // 4. Check for low quality messages
    const isLowQuality = this._isLowQualityMessage(roomId, senderId, content);
    
    // Apply disruption score decay for good behavior
    // If this is not a problematic message, gradually reduce the disruption score
    if (!hasProfanity && !hasIdentityAttack && !hasThreat && !hasSevereToxicity && 
        !hasAggressiveTone && !isLowQuality && consecutiveCount <= 3) {
      // Decay by 0.5 points per good message, but never below 0
      if (disruptionScore > 0) {
        disruptionScore = Math.max(0, disruptionScore - 0.5);
        console.log(`[Guardian AI] Good behavior detected, reducing disruption score to ${disruptionScore}`);
      }
    }
    
    // Calculate new disruption score based on message content and context
    if (hasProfanity) {
      disruptionScore += 3;
      console.log(`[Guardian AI] Profanity detected, adding 3 to disruption score (now ${disruptionScore})`);
    }
    
    if (hasIdentityAttack) {
      disruptionScore += 5;
      console.log(`[Guardian AI] Identity attack detected, adding 5 to disruption score (now ${disruptionScore})`);
    }
    
    if (hasThreat) {
      disruptionScore += 5;
      console.log(`[Guardian AI] Threat detected, adding 5 to disruption score (now ${disruptionScore})`);
    }
    
    if (hasSevereToxicity) {
      disruptionScore += 5;
      console.log(`[Guardian AI] Severe toxicity detected, adding 5 to disruption score (now ${disruptionScore})`);
    }
    
    if (hasAggressiveTone) {
      disruptionScore += 2;
      console.log(`[Guardian AI] Aggressive tone detected, adding 2 to disruption score (now ${disruptionScore})`);
    }
    
    if (hasMessageDominance && isLowQuality) {
      disruptionScore += 2;
      console.log(`[Guardian AI] Message dominance with low quality detected, adding 2 to disruption score (now ${disruptionScore})`);
    } else if (hasMessageDominance) {
      disruptionScore += 1;
      console.log(`[Guardian AI] Message dominance detected, adding 1 to disruption score (now ${disruptionScore})`);
    } else if (isLowQuality && consecutiveCount > 2) {
      disruptionScore += 1;
      console.log(`[Guardian AI] Low quality message detected, adding 1 to disruption score (now ${disruptionScore})`);
    }
    
    // Save updated disruption score
    this.userDisruptionScores.get(roomId).set(senderId, disruptionScore);
    
    // Determine intervention level based on disruption score
    let interventionLevel = null;
    
    if (disruptionScore >= 12) {
      interventionLevel = 'forceDisconnect';
    } else if (disruptionScore >= 8) {
      interventionLevel = 'disrupt';
    } else if (disruptionScore >= 5) {
      interventionLevel = 'mirror';
    } else if (disruptionScore >= 3) {
      interventionLevel = 'soft';
    }
    
    // Check if we've already intervened recently
    const lastInterventionTime = this.lastInterventionTime.get(roomId).get(senderId);
    const history = this.conversationHistory.get(roomId);
    const messagesSinceIntervention = history.length - lastInterventionTime;
    
    // Check if other user has responded since last intervention
    let otherUserResponded = false;
    if (lastInterventionTime > 0) {
      for (let i = lastInterventionTime; i < history.length; i++) {
        const msg = history[i];
        if (msg.type !== 'system' && msg.sender !== senderId) {
          otherUserResponded = true;
          break;
        }
      }
    }
    
    // Don't intervene if the other user has responded, unless it's a serious violation
    if (otherUserResponded && disruptionScore < 8) {
      console.log(`[Guardian AI] Other user has responded, skipping intervention`);
      return null;
    }
    
    // If we've intervened recently and there's still an issue, escalate
    if (interventionLevel && lastInterventionTime > 0 && messagesSinceIntervention < 2) {
      // Escalate intervention level
      if (interventionLevel === 'soft') {
        interventionLevel = 'mirror';
      } else if (interventionLevel === 'mirror') {
        interventionLevel = 'disrupt';
      } else if (interventionLevel === 'disrupt' && disruptionScore >= 10) {
        interventionLevel = 'forceDisconnect';
      }
    }
    
    // Check for urgency override conditions (severe toxicity, identity attack, threat)
    const hasUrgentContent = hasSevereToxicity || hasIdentityAttack || hasThreat;
    
    // If urgent content is detected, override normal intervention timing
    if (hasUrgentContent && !interventionLevel) {
      console.log(`[Guardian AI] Urgency override triggered due to flagged content`);
      interventionLevel = 'mirror'; // Start with mirror level for urgent content
      
      // Record the urgency override timestamp
      this.urgencyOverrides.get(roomId).set(senderId, Date.now());
    }
    
    // Check for distress signals from the user
    const hasDistressSignals = this._containsDistressSignals(content);
    if (hasDistressSignals) {
      console.log(`[Guardian AI] Distress signals detected in message`);
      this.distressSignals.get(roomId).set(senderId, true);
    }
    
    // Determine appropriate tone based on context
    let currentTone = this.moderationTones.get(roomId).get(senderId);
    
    // Adjust tone based on message content and context
    if (hasAggressiveTone || hasProfanity || hasSevereToxicity || hasIdentityAttack || hasThreat || disruptionScore >= 5) {
      // Switch to directive tone for more serious issues
      currentTone = TONE.DIRECTIVE;
      console.log(`[Guardian AI] Switching to DIRECTIVE tone due to message content`);
    } else if (hasDistressSignals || hasMessageDominance) {
      // Switch to grounded tone for distress or dominance
      currentTone = TONE.GROUNDED;
      console.log(`[Guardian AI] Switching to GROUNDED tone due to message context`);
    } else {
      // Default to reflective tone for mild or no issues
      currentTone = TONE.REFLECTIVE;
      console.log(`[Guardian AI] Using REFLECTIVE tone (default)`);
    }
    
    // Save the current tone
    this.moderationTones.get(roomId).set(senderId, currentTone);
    
    // If intervention is needed, generate response
    if (interventionLevel) {
      console.log(`[Guardian AI] Intervention needed at level: ${interventionLevel}`);
      
      // Update last intervention time
      this.lastInterventionTime.get(roomId).set(senderId, history.length);
      
      // Get random intervention message for this level and tone
      const messages = this.interventionMessages[currentTone][interventionLevel];
      const randomIndex = Math.floor(Math.random() * messages.length);
      
      // For force disconnect, return special metadata
      if (interventionLevel === 'forceDisconnect') {
        return {
          type: 'system',
          content: messages[randomIndex],
          metadata: { 
            forceDisconnect: true,
            reason: "Repeated violations of community standards"
          }
        };
      }
      
      // For aggressive tone with high disruption score, offer de-escalation coaching
      if (currentTone === TONE.DIRECTIVE && disruptionScore >= 5 && interventionLevel !== 'soft') {
        // Get random mentoring message
        const mentoringIndex = Math.floor(Math.random() * this.deEscalationMessages.mentoring.length);
        const exampleIndex = Math.floor(Math.random() * this.deEscalationMessages.examples.length);
        
        const mentoringMessage = this.deEscalationMessages.mentoring[mentoringIndex];
        const exampleMessage = this.deEscalationMessages.examples[exampleIndex];
        
        // Combine intervention with de-escalation coaching
        const combinedMessage = `${messages[randomIndex]}\n\n${mentoringMessage}\n\n${exampleMessage}`;
        
        // For other intervention levels, set cooldown
        let cooldownLevel = 1;
        if (interventionLevel === 'mirror') cooldownLevel = 2;
        if (interventionLevel === 'disrupt') cooldownLevel = 3;
        
        // Set cooldown and get duration
        const cooldownDuration = this._setUserCooldown(roomId, senderId, cooldownLevel);
        
        return {
          type: 'system',
          content: combinedMessage,
          metadata: { 
            cooldown: true,
            duration: cooldownDuration,
            deEscalation: true
          }
        };
      } else {
        // For other intervention levels, set cooldown
        let cooldownLevel = 1;
        if (interventionLevel === 'mirror') cooldownLevel = 2;
        if (interventionLevel === 'disrupt') cooldownLevel = 3;
        
        // Set cooldown and get duration
        const cooldownDuration = this._setUserCooldown(roomId, senderId, cooldownLevel);
        
        return {
          type: 'system',
          content: messages[randomIndex],
          metadata: { 
            cooldown: true,
            duration: cooldownDuration
          }
        };
      }
    }
    
    return null;
  }
  
  /**
   * Check if a message is low quality (very short, repetitive, etc.)
   * @param {string} roomId - The room identifier
   * @param {string} userId - The user identifier
   * @param {string} content - The message content
   * @returns {boolean} True if the message is low quality
   * @private
   */
  _isLowQualityMessage(roomId, userId, content) {
    const trimmedContent = content.trim();
    
    // Only consider extremely short messages (single characters) as low quality
    if (trimmedContent.length <= 1) {
      return true;
    }
    
    // Short messages that are just expressions or filler
    const fillerPatterns = [
      /^(haha|lol|hmm|oh|ok|yeah|yep|nope|k|y|n)$/i
    ];
    
    if (fillerPatterns.some(pattern => pattern.test(trimmedContent))) {
      // But only if it's not a response to a question
      const history = this.conversationHistory.get(roomId);
      if (history.length > 1) {
        const previousMessage = history[history.length - 2];
        // If previous message ends with a question mark, this short response is acceptable
        if (previousMessage.content.trim().endsWith('?')) {
          return false;
        }
      }
      return true;
    }
    
    // Check for repetitive content from this user
    if (this.userMessageHistory.get(roomId).has(userId)) {
      const userHistory = this.userMessageHistory.get(roomId).get(userId);
      
      // If user has at least 2 previous messages
      if (userHistory.length >= 2) {
        // Check if current message is similar to any of the last 2 messages
        const lastMessages = userHistory.slice(-2);
        for (const msg of lastMessages) {
          if (this._stringSimilarity(msg.content, content) > 0.9) { // Increased threshold
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  /**
   * Calculate string similarity (simple implementation)
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Similarity score between 0 and 1
   * @private
   */
  _stringSimilarity(str1, str2) {
    // For very short strings, use exact matching
    if (str1.length < 5 || str2.length < 5) {
      return str1.toLowerCase() === str2.toLowerCase() ? 1 : 0;
    }
    
    // Simple character-based similarity
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    // If the shorter string is empty, return 0
    if (shorter.length === 0) return 0;
    
    // Count matching characters
    let matches = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) {
        matches++;
      }
    }
    
    return matches / longer.length;
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
   * Check if text contains urgent content that requires immediate intervention
   * @param {string} text - The text to check
   * @returns {boolean} True if urgent content is detected
   * @private
   */
  _containsUrgentContent(text) {
    // Check for slurs, identity invalidation, or other urgent content
    const urgentPatterns = [
      // Slurs and hate speech (simplified for example)
      /\b(n[i1]gg[e3]r|f[a@]gg?[o0]t|r[e3]t[a@]rd|tr[a@]nny|k[i1]k[e3]|sp[i1]c|ch[i1]nk)\b/i,
      
      // Identity invalidation
      /\byou('re| are) not (really|actually) a\b/i,
      /\b(men|women|they) (aren't|are not|can't|cannot) be\b/i,
      
      // Threats
      /\b(kill|hurt|harm|attack) you\b/i,
      /\bshould (die|be dead|be killed)\b/i,
      
      // Extreme content
      /\bsuicide\b/i,
      /\b(shoot|bomb|murder|rape)\b/i
    ];
    
    const lowerText = text.toLowerCase();
    return urgentPatterns.some(pattern => pattern.test(lowerText));
  }
  
  /**
   * Check if text contains distress signals from the user
   * @param {string} text - The text to check
   * @returns {boolean} True if distress signals are detected
   * @private
   */
  _containsDistressSignals(text) {
    // Check for phrases indicating user distress
    const distressPatterns = [
      /\b(i feel|i am|i'm) (attacked|unsafe|uncomfortable|offended)\b/i,
      /\bthis (is|feels) (uncomfortable|unsafe|hostile)\b/i,
      /\b(stop|please stop|don't)\b/i,
      /\byou('re| are) (attacking|insulting|offending) me\b/i,
      /\bthat('s| is) (hurtful|mean|rude|offensive)\b/i,
      /\bi('m| am) (hurt|upset|offended)\b/i
    ];
    
    const lowerText = text.toLowerCase();
    return distressPatterns.some(pattern => pattern.test(lowerText));
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
    
    // Add system prompt to guide the AI - refined for clarity while maintaining warmth
    const systemPrompt = {
      role: 'system',
      content: `You are a thoughtful moderator for Emergent Grounds, a space for meaningful conversation between two people.

      CORE PHILOSOPHY:
      This space values understanding over agreement. The conversation is a shared journey where both participants can discover new insights together.
      
      YOUR ROLE:
      - Offer brief reflections or questions that help deepen the dialogue
      - Create a safe space for honest exchange
      - Encourage thoughtful responses and active listening
      - Help participants find common ground and mutual understanding
      
      YOUR APPROACH:
      - Keep interventions brief (1-2 sentences) and focused
      - Use clear, accessible language that invites reflection
      - Maintain a warm, supportive tone
      - Focus on how people are connecting rather than the specific topic
      - Ask questions that encourage curiosity and openness
      - Notice when the conversation might benefit from a pause or shift
      
      GUIDELINES:
      - Encourage listening: Help participants truly hear each other
      - Promote respect: Support a space where different perspectives are valued
      - Foster presence: Invite participants to engage fully with each other
      - Inspire curiosity: Encourage questions rather than assumptions
      - Support connection: Help participants find meaningful points of contact
      - Value pauses: Recognize that thoughtful silence can be valuable
      - Embrace questions: The goal is deeper understanding, not final answers
      
      Your role is to gently guide the conversation toward meaningful exchange without being intrusive.
      
      /* 
      FUTURE ENHANCEMENT IDEA: Add a "Tone Preference" toggle at the beginning for participants:
      - Default = warm, poetic
      - Optional = more direct, grounded tone
      This would allow the AI to slightly adjust the moderation tone for inclusivity.
      */`
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
