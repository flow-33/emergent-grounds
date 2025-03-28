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

// Welcome messages for the AI facilitator
const WELCOME_MESSAGES = [
  "Welcome. I'll be here quietly in the background to help guide the space if needed. Let's see what you both discover.",
  "Welcome, both of you. I'm here to gently support this shared space. Let's begin with curiosity and care.",
  "Welcome to this conversation. I'm here to support your dialogue when needed. Feel free to explore together."
];

// Welcome messages are now handled in server.js

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
    this.welcomeMessageSent = new Map(); // roomId -> boolean (whether welcome message has been sent)
    this.uniqueParticipants = new Map(); // roomId -> Set of unique participant IDs who have sent messages
    this.userConversationHealth = new Map(); // roomId -> Map of userId -> conversation health score
    this.suggestionUsed = new Map(); // roomId -> Map of userId -> boolean (whether a suggestion was recently used)
    this.lastSuggestionTime = new Map(); // roomId -> Map of userId -> timestamp of last suggestion
    this.usedStarters = new Map(); // roomId -> Map of userId -> Set of used starters
    this.roomStarters = new Map(); // roomId -> {first: [...], second: [...]}
    this.starterCallCount = new Map(); // roomId -> Map of userId -> count of calls
    this.lastApiCallTime = new Map(); // roomId -> Map of userId -> timestamp of last API call
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
   * Mark a starter as used by a user
   * @param {string} roomId - The room identifier
   * @param {string} userId - The user identifier
   * @param {string} starter - The starter text that was used
   */
  markStarterAsUsed(roomId, userId, starter) {
    console.log(`[AI Moderator] Marking starter as used by user ${userId}: "${starter.substring(0, 30)}..."`);
    
    // Initialize used starters tracking if it doesn't exist
    if (!this.usedStarters) {
      this.usedStarters = new Map();
    }
    
    if (!this.usedStarters.has(roomId)) {
      this.usedStarters.set(roomId, new Map());
    }
    
    const roomUsedStarters = this.usedStarters.get(roomId);
    if (!roomUsedStarters.has(userId)) {
      roomUsedStarters.set(userId, new Set());
    }
    
    // Add this starter to the set of used starters
    roomUsedStarters.get(userId).add(starter);
    
    // Also mark suggestion as used to prevent showing new suggestions immediately
    this.markSuggestionUsed(roomId, userId);
  }
  
  /**
   * Get random unused starters for a user
   * @param {string} userId - The user identifier
   * @param {string} roomId - The room identifier
   * @param {number} count - Number of starters to return
   * @returns {string[]} Array of unused starters
   * @private
   */
  _getRandomUnusedStarters(userId, roomId, count) {
    if (!this.usedStarters) {
      this.usedStarters = new Map();
    }
    
    if (!this.usedStarters.has(roomId)) {
      this.usedStarters.set(roomId, new Map());
    }
    
    const roomUsedStarters = this.usedStarters.get(roomId);
    if (!roomUsedStarters.has(userId)) {
      roomUsedStarters.set(userId, new Set());
    }
    
    const userUsedStarters = roomUsedStarters.get(userId);
    
    // Filter out starters that have already been used by this user
    const unusedStarters = CONVERSATION_STARTERS.filter(starter => !userUsedStarters.has(starter));
    
    // If all starters have been used, reset and use all starters
    const availableStarters = unusedStarters.length > 0 ? unusedStarters : CONVERSATION_STARTERS;
    
    // Shuffle and take the requested number
    const shuffled = [...availableStarters].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
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
      this.welcomeMessageSent.set(roomId, false);
      this.uniqueParticipants.set(roomId, new Set());
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
      // Add this participant to the unique participants set
      const uniqueParticipants = this.uniqueParticipants.get(roomId);
      uniqueParticipants.add(message.sender);
      
      if (!this.userMessageHistory.get(roomId).has(message.sender)) {
        this.userMessageHistory.get(roomId).set(message.sender, []);
      }
      
      const userHistory = this.userMessageHistory.get(roomId).get(message.sender);
      userHistory.push(message);
      
      // Keep only the last 10 messages per user to avoid memory issues
      if (userHistory.length > 10) {
        userHistory.shift();
      }
      
      // Welcome messages are now handled in server.js
      // Just mark that we've processed this message
      if (!this.welcomeMessageSent.get(roomId)) {
        console.log(`[AI Moderator] Welcome message will be handled by server.js for room ${roomId}`);
        this.welcomeMessageSent.set(roomId, true);
      }
    }
    
    // Check if Guardian AI intervention is needed
    const guardianResponse = this._checkGuardianIntervention(roomId, message);
    if (guardianResponse) {
      console.log(`[AI Moderator] Guardian AI intervention triggered: ${guardianResponse.content}`);
      return guardianResponse;
    }
    
    // Check if user is in cooldown
    if (message.type !== 'system' && this._isUserInCooldown(roomId, message.sender)) {
      console.log(`[AI Moderator] User ${message.sender} is in cooldown, sending reminder`);
      return {
        type: 'system',
        content: this._getRandomCooldownMessage(),
        isModerator: true, // Flag to distinguish moderator messages from system messages
        metadata: { cooldown: true }
      };
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
   * Get conversation starters for the beginning of a conversation
   * @param {string} roomId - The room identifier
   * @param {string} userId - The user identifier
   * @param {number} conversationHealth - Optional health parameter (stored for potential later use)
   * @param {Array} context - Optional context (not used for initial starters)
   * @returns {Object|null} Object containing conversation starters or null
   */
  getConversationStarters(roomId, userId, conversationHealth, context, suggestionThreshold) {
    // Initialize conversation starters flag if needed
    if (!this.conversationStarters.has(roomId)) {
      this.conversationStarters.set(roomId, true);
    }
    
    // Store health data for potential later use in getSuggestions
    if (conversationHealth !== undefined) {
      // Initialize user conversation health tracking if needed
      if (!this.userConversationHealth.has(roomId)) {
        this.userConversationHealth.set(roomId, new Map());
      }
      this.userConversationHealth.get(roomId).set(userId, conversationHealth);
    }
    
    // If conversation starters are disabled for this room, return null
    if (!this.conversationStarters.get(roomId)) {
      return null;
    }
    
    // Check if health is low - if so, delegate to getSuggestions method
    const userHealth = this.userConversationHealth?.get(roomId)?.get(userId);
    const threshold = suggestionThreshold || 0.55;
    
    if (userHealth !== undefined && userHealth < threshold) {
      return this.getSuggestions(roomId, userId, userHealth, context, suggestionThreshold);
    }
    
    // Simple conversation starters logic - provide different starters for each user
    
    // Initialize room starters if needed
    if (!this.roomStarters) {
      this.roomStarters = new Map();
    }
    
    if (!this.starterCallCount) {
      this.starterCallCount = new Map();
    }
    
    if (!this.starterCallCount.has(roomId)) {
      this.starterCallCount.set(roomId, 0);
    }
    
    // Track how many times this function has been called for this room
    const callCount = this.starterCallCount.get(roomId);
    this.starterCallCount.set(roomId, callCount + 1);
    
    // Generate different starters for each participant
    if (!this.roomStarters.has(roomId)) {
      // Shuffle the starters
      const shuffled = [...CONVERSATION_STARTERS].sort(() => 0.5 - Math.random());
      
      // First participant gets first 3 starters, second participant gets next 3
      this.roomStarters.set(roomId, {
        first: shuffled.slice(0, 3),
        second: shuffled.slice(3, 6)
      });
    }
    
    // Return different starters based on call count (even/odd)
    const roomData = this.roomStarters.get(roomId);
    return {
      starters: callCount % 2 === 0 ? roomData.first : roomData.second,
      userId: userId // Include the userId in the response
    };
  }
  
  /**
   * Get suggestions for a user when conversation health is low
   * @param {string} roomId - The room identifier
   * @param {string} userId - The user identifier
   * @param {number} userHealth - The user's conversation health score
   * @param {Array} context - Optional array of recent messages for context
   * @param {number} suggestionThreshold - Optional threshold for showing suggestions
   * @returns {Promise<Object>|Object|null} Suggestions object or null
   * @private
   */
  getSuggestions(roomId, userId, userHealth, context, suggestionThreshold) {
    console.log(`[AI Moderator] Considering suggestions for user ${userId} due to low health score: ${userHealth}`);
    
    // Initialize suggestion tracking if needed
    if (!this.suggestionUsed.has(roomId)) {
      this.suggestionUsed.set(roomId, new Map());
    }
    
    if (!this.lastSuggestionTime.has(roomId)) {
      this.lastSuggestionTime.set(roomId, new Map());
    }
    
    // Check if a suggestion was recently used by this user
    if (this.suggestionUsed.get(roomId).get(userId) === true) {
      console.log(`[AI Moderator] User ${userId} recently used a suggestion, not showing new ones yet`);
      return null;
    }
    
    // Check if we're within the rate limit cooldown period
    const lastSuggestionTime = this.lastSuggestionTime.get(roomId).get(userId) || 0;
    const now = Date.now();
    const timeSinceLastSuggestion = now - lastSuggestionTime;
    const cooldownPeriod = 30 * 1000; // 30 seconds in milliseconds
    
    if (timeSinceLastSuggestion < cooldownPeriod) {
      console.log(`[AI Moderator] Rate limit cooldown active for user ${userId}, ${(cooldownPeriod - timeSinceLastSuggestion) / 1000}s remaining`);
      return null;
    }
    
    // Update the last suggestion time
    this.lastSuggestionTime.get(roomId).set(userId, now);
    
    // If we have context and OpenAI is available, generate smart suggestions
    if (context && openai && useOpenAI) {
      console.log(`[AI Moderator] Generating smart suggestions for user ${userId} based on conversation context`);
      
      return this._generateSmartSuggestions(context, userId, userHealth)
        .then(suggestions => {
          return {
            starters: suggestions,
            resurfaced: true,
            message: "Need a little inspiration? Here's something to refocus.",
            userId: userId
          };
        })
        .catch(error => {
          console.error('Error generating smart suggestions:', error);
          // Fall back to random starters if AI fails
          const shuffled = [...CONVERSATION_STARTERS].sort(() => 0.5 - Math.random());
          return {
            starters: shuffled.slice(0, 3),
            resurfaced: true,
            message: "Need a little inspiration? Here's something to refocus.",
            userId: userId
          };
        });
    } else {
      // Get 3 random starters with a special message if no context or OpenAI not available
      const shuffled = [...CONVERSATION_STARTERS].sort(() => 0.5 - Math.random());
      const starters = shuffled.slice(0, 3);
      
      return {
        starters: starters,
        resurfaced: true,
        message: "Need a little inspiration? Here's something to refocus.",
        userId: userId
      };
    }
  }
  
  /**
   * Mark a suggestion as used by a user
   * @param {string} roomId - The room identifier
   * @param {string} userId - The user identifier
   * @returns {Object} Success status
   */
  markSuggestionUsed(roomId, userId) {
    console.log(`[AI Moderator] Marking suggestion as used for user ${userId} in room ${roomId}`);
    
    // Initialize suggestion used tracking if it doesn't exist
    if (!this.suggestionUsed.has(roomId)) {
      this.suggestionUsed.set(roomId, new Map());
    }
    
    // Mark the suggestion as used - this will hide suggestions immediately
    this.suggestionUsed.get(roomId).set(userId, true);
    
    // After a delay, reset the flag to allow new suggestions when health drops below threshold again
    // This ensures suggestions don't reappear immediately but can show up later if needed
    setTimeout(() => {
      if (this.suggestionUsed.has(roomId) && this.suggestionUsed.get(roomId).has(userId)) {
        this.suggestionUsed.get(roomId).set(userId, false);
        console.log(`[AI Moderator] Reset suggestion used flag for user ${userId} in room ${roomId}`);
      }
    }, 30000); // 30 second delay before allowing new suggestions
    
    return { success: true };
  }
  
  /**
   * Generate smart suggestions based on conversation context using OpenAI
   * @param {Array} context - Array of recent messages for context
   * @param {string} userId - The user identifier
   * @param {number} userHealth - The user's conversation health score
   * @returns {Promise<string[]>} Array of smart suggestions
   * @private
   */
  async _generateSmartSuggestions(context, userId, userHealth) {
    console.log(`[AI Moderator] Generating smart suggestions with OpenAI`);
    
    if (!openai) {
      console.error('[AI Moderator] OpenAI client not initialized');
      throw new Error('OpenAI client not initialized');
    }
    
    // Format conversation context for the AI
    const formattedContext = context.map(msg => {
      return {
        role: msg.type === 'system' ? 'system' : 'user',
        content: msg.content,
        name: msg.participant // Use participant identifier as name
      };
    });
    
    // Add system prompt to guide the AI - SIMPLIFIED for more reliable JSON generation
    const systemPrompt = {
      role: 'system',
      content: `Generate 2 short, thoughtful conversation suggestions based on the conversation context provided.
      The suggestions should:
      1. Be relevant to the specific topics discussed
      2. Reference ideas or themes from the conversation
      3. Help deepen the dialogue
      4. Be under 20 words each
      
      Format your response as a JSON array of strings. Example:
      ["I'm curious about your perspective on...", "That reminds me of a time when..."]`
    };
    
    // Get model from environment variables or use default
    const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
    console.log(`[AI Moderator] Using model: ${model} for smart suggestions`);
    
    // Add retry logic
    let maxRetries = 3;
    let retryCount = 0;
    let lastError = null;
    
    while (retryCount < maxRetries) {
      try {
        // Generate completion - REMOVED response_format parameter which might be causing issues
        const response = await openai.chat.completions.create({
          model: model,
          messages: [systemPrompt, ...formattedContext],
          max_tokens: 150,
          temperature: 0.7
        });
        
        // Log token usage
        console.log(`[AI Moderator] Token usage - Prompt: ${response.usage.prompt_tokens}, Completion: ${response.usage.completion_tokens}, Total: ${response.usage.total_tokens}`);
        
        // Parse the JSON response
        const content = response.choices[0].message.content.trim();
        console.log(`[AI Moderator] Raw response content: "${content}"`); // Log the raw content
        
        let suggestions;
        
        try {
          // Try to parse the JSON response with improved handling
          let parsedResponse;
          
          // Handle various response formats
          if (content.includes('```json')) {
            // Extract JSON from code block
            const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
              parsedResponse = JSON.parse(jsonMatch[1].trim());
            } else {
              throw new Error('Could not extract JSON from code block');
            }
          } else if (content.includes('```')) {
            // Extract from generic code block
            const codeMatch = content.match(/```\s*([\s\S]*?)\s*```/);
            if (codeMatch && codeMatch[1]) {
              parsedResponse = JSON.parse(codeMatch[1].trim());
            } else {
              throw new Error('Could not extract from code block');
            }
          } else if (content.trim().startsWith('[') && content.trim().endsWith(']')) {
            // Direct array format
            parsedResponse = JSON.parse(content.trim());
          } else if (content.includes('{') && content.includes('}')) {
            // JSON object format
            const jsonMatch = content.match(/{[\s\S]*?}/);
            if (jsonMatch) {
              parsedResponse = JSON.parse(jsonMatch[0]);
            } else {
              throw new Error('Could not extract JSON object');
            }
          } else {
            // Try parsing the whole content as JSON
            parsedResponse = JSON.parse(content);
          }
          
          // Extract suggestions from the parsed response
          if (Array.isArray(parsedResponse)) {
            suggestions = parsedResponse;
          } else if (parsedResponse && parsedResponse.suggestions) {
            suggestions = parsedResponse.suggestions;
          } else if (parsedResponse && typeof parsedResponse === 'object') {
            // Try to find any array in the response
            const possibleArrays = Object.values(parsedResponse).filter(Array.isArray);
            if (possibleArrays.length > 0) {
              suggestions = possibleArrays[0];
            } else {
              throw new Error('No array found in response');
            }
          } else {
            throw new Error('Could not find suggestions in parsed response');
          }
        } catch (error) {
          console.error('[AI Moderator] Error processing JSON:', error.message);
          console.log('[AI Moderator] Attempting to extract suggestions using regex');
          
          // Try to extract suggestions using regex as fallback
          const matches = content.match(/"([^"]+)"/g);
          if (matches && matches.length >= 2) {
            suggestions = matches.slice(0, 2).map(m => m.replace(/"/g, ''));
            console.log('[AI Moderator] Successfully extracted suggestions using regex:', suggestions);
          } else {
            // If we still can't extract suggestions, create contextual ones based on content
            console.log('[AI Moderator] Creating contextual suggestions based on content');
            
            // Extract key phrases from the content if possible
            const phrases = content.split(/[.!?]/).filter(p => p.trim().length > 0);
            if (phrases.length >= 2) {
              suggestions = phrases.slice(0, 2).map(p => {
                // Clean up the phrase and make it a suggestion
                return p.trim()
                  .replace(/^I would suggest /i, '')
                  .replace(/^You could say /i, '')
                  .replace(/^Try saying /i, '')
                  .replace(/^Perhaps /i, '')
                  .replace(/^Maybe /i, '');
              });
            } else {
              // Last resort fallback
              suggestions = [
                "I'm curious to hear more about your perspective.",
                "That's an interesting point. Could you elaborate?"
              ];
            }
          }
        }
        
        // Success! Break out of retry loop
        return this._formatSuggestions(suggestions);
        
      } catch (error) {
        console.error(`[AI Moderator] API error (attempt ${retryCount + 1}/${maxRetries}):`, error.message);
        lastError = error;
        retryCount++;
        
        // Wait before retrying (exponential backoff)
        if (retryCount < maxRetries) {
          const delay = Math.pow(2, retryCount) * 500; // 1s, 2s, 4s
          console.log(`[AI Moderator] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // If we've exhausted all retries, use contextual fallbacks
    console.error('[AI Moderator] All retries failed:', lastError?.message);
    return this._getContextualFallbacks(context);
  }
  
  /**
   * Format suggestions to ensure they're appropriate length and we have exactly 2
   * @param {Array<string>} suggestions - Raw suggestions
   * @returns {Array<string>} Formatted suggestions
   * @private
   */
  _formatSuggestions(suggestions) {
    // Ensure we have valid suggestions
    if (!Array.isArray(suggestions)) {
      suggestions = [
        "I'm curious to hear more about your perspective.",
        "That's an interesting point. Could you elaborate?"
      ];
    }
    
    // Ensure we have exactly 2 suggestions and they're not too long
    suggestions = suggestions.slice(0, 2).map(s => {
      if (!s || typeof s !== 'string') return "I'd like to hear more about that.";
      
      // Truncate to 20 words if needed
      const words = s.split(' ');
      if (words.length > 20) {
        return words.slice(0, 20).join(' ') + '...';
      }
      return s;
    });
    
    // If we somehow don't have 2 suggestions, add generic ones
    while (suggestions.length < 2) {
      suggestions.push(
        "I appreciate your thoughts. What else comes to mind?",
        "That's interesting. How did you come to that perspective?"
      );
    }
    
    console.log(`[AI Moderator] Formatted suggestions:`, suggestions);
    return suggestions;
  }
  
  /**
   * Generate contextual fallback suggestions based on conversation context
   * @param {Array} context - Conversation context
   * @returns {Array<string>} Contextual fallback suggestions
   * @private
   */
  _getContextualFallbacks(context) {
    console.log(`[AI Moderator] Generating contextual fallbacks from ${context.length} messages`);
    
    // Extract the last few messages for context
    const recentMessages = context.slice(-3);
    
    // Extract potential topics from recent messages
    const topics = new Set();
    const questionWords = ['what', 'how', 'why', 'when', 'where', 'who'];
    
    recentMessages.forEach(msg => {
      if (!msg.content) return;
      
      // Extract nouns and meaningful words (simple approach)
      const words = msg.content.split(/\s+/);
      words.forEach(word => {
        // Only consider words of 4+ characters that aren't common
        if (word.length >= 4 && !['this', 'that', 'with', 'from', 'have', 'about'].includes(word.toLowerCase())) {
          topics.add(word);
        }
      });
      
      // Look for question patterns
      questionWords.forEach(qWord => {
        if (msg.content.toLowerCase().includes(qWord + ' ')) {
          topics.add(qWord);
        }
      });
    });
    
    // If we found topics, create contextual suggestions
    if (topics.size > 0) {
      const topicArray = Array.from(topics);
      const randomTopics = topicArray.sort(() => 0.5 - Math.random()).slice(0, 2);
      
      const suggestions = [
        `I'm curious about your thoughts on ${randomTopics[0] || 'this topic'}.`,
        `Could you share more about how ${randomTopics[1] || 'that'} relates to your experience?`
      ];
      
      console.log(`[AI Moderator] Generated contextual fallbacks:`, suggestions);
      return suggestions;
    }
    
    // Default fallbacks if we couldn't extract meaningful topics
    return [
      "I'm curious to hear more about your perspective.",
      "That's an interesting point. Could you elaborate?"
    ];
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
          .map(([attr, score]) => {
            // Check if score is a number before using toFixed
            return `${attr}: ${typeof score === 'number' ? score.toFixed(2) : score}`;
          })
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
    
    // Determine appropriate tone based on message content and context
    const currentTone = this._determineModeratorTone(
      roomId, 
      senderId, 
      {
        hasAggressiveTone,
        hasProfanity,
        hasSevereToxicity,
        hasIdentityAttack,
        hasThreat,
        hasDistressSignals,
        hasMessageDominance,
        disruptionScore
      }
    );
    
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
          isModerator: true, // Flag to distinguish moderator messages from system messages
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
          isModerator: true, // Flag to distinguish moderator messages from system messages
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
      content: response.choices[0].message.content.trim(),
      isModerator: true // Flag to distinguish moderator messages from system messages
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
      content: REFLECTION_PROMPTS[index],
      isModerator: true // Flag to distinguish moderator messages from system messages
    };
  }

  /**
   * Get a random interval for reflections (4-6 messages)
   * @private
   */
  _getRandomReflectionInterval() {
    return Math.floor(Math.random() * 3) + 4; // 4, 5, or 6
  }
  
  /**
   * Determine the appropriate moderator tone based on message content and context
   * @param {string} roomId - The room identifier
   * @param {string} userId - The user identifier
   * @param {Object} flags - Object containing various flags about the message
   * @returns {string} The appropriate tone from TONE constants
   * @private
   */
  _determineModeratorTone(roomId, userId, flags) {
    // Determine appropriate tone based on message content and context
    let newTone;
    
    if (flags.hasAggressiveTone || 
        flags.hasProfanity || 
        flags.hasSevereToxicity || 
        flags.hasIdentityAttack || 
        flags.hasThreat || 
        flags.disruptionScore >= 5) {
      // Use directive tone for more serious issues
      newTone = TONE.DIRECTIVE;
      console.log(`[Guardian AI] Switching to DIRECTIVE tone due to message content`);
    } else if (flags.hasDistressSignals || flags.hasMessageDominance) {
      // Use grounded tone for distress or dominance
      newTone = TONE.GROUNDED;
      console.log(`[Guardian AI] Switching to GROUNDED tone due to message context`);
    } else {
      // Default to reflective tone for mild or no issues
      newTone = TONE.REFLECTIVE;
      console.log(`[Guardian AI] Using REFLECTIVE tone (default)`);
    }
    
    // Save the new tone
    this.moderationTones.get(roomId).set(userId, newTone);
    
    return newTone;
  }
}

module.exports = new AIModerator();
