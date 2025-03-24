/**
 * harm-detection.js
 * Client-side tone caution using TensorFlow.js
 * Part of the Emergent Grounds layered moderation system (Layer 1)
 */

// Global harm detection object
window.harmDetection = {
  model: null,
  labels: null,
  threshold: 0.7,
  messageInput: null,
  sendButton: null,
  warningElement: null,
  onWarning: null,
  onClear: null,
  isLoading: false,
  isModelLoaded: false,
  debounceTimeout: null,
  lastAnalyzedText: '',
  analysisInProgress: false,
  minAnalysisLength: 10, // Only analyze text longer than this
  debounceDelay: 1000,   // Base debounce delay (ms)
  textCache: new Map(),  // Cache for analyzed text
  maxCacheSize: 50,      // Maximum number of cache entries
  lastTypingTime: 0,     // Last time user typed
  lastPunctuationTime: 0, // Last time user typed punctuation
  typingPaused: false,   // Whether user has paused typing
  
  /**
   * Initialize harm detection with UI elements
   * @param {Object} config - Configuration object
   * @param {HTMLElement} config.messageInput - Message input element
   * @param {HTMLElement} config.sendButton - Send button element
   * @param {HTMLElement} config.warningElement - Warning element
   * @param {Function} config.onWarning - Callback when warning is triggered
   * @param {Function} config.onClear - Callback when warning is cleared
   */
  initialize: function(config) {
    console.log('[Harm Detection] Initializing...');
    
    // Store configuration
    this.messageInput = config.messageInput;
    this.sendButton = config.sendButton;
    this.warningElement = config.warningElement;
    this.onWarning = config.onWarning || function() {};
    this.onClear = config.onClear || function() {};
    
    // Add event listener for input
    if (this.messageInput) {
      this.messageInput.addEventListener('input', this.handleInput.bind(this));
    }
    
    // Load TensorFlow.js and toxicity model
    this.loadTensorFlow();
  },
  
  /**
   * Load TensorFlow.js and toxicity model
   */
  loadTensorFlow: function() {
    if (this.isLoading) return;
    this.isLoading = true;
    
    console.log('[Harm Detection] Loading TensorFlow.js...');
    
    // Create script element for TensorFlow.js
    const tfScript = document.createElement('script');
    tfScript.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs';
    tfScript.async = true;
    
    // Create script element for toxicity model
    const toxicityScript = document.createElement('script');
    toxicityScript.src = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/toxicity';
    toxicityScript.async = true;
    
    // Load TensorFlow.js first, then toxicity model
    tfScript.onload = () => {
      console.log('[Harm Detection] TensorFlow.js loaded');
      document.head.appendChild(toxicityScript);
    };
    
    // Load toxicity model
    toxicityScript.onload = () => {
      console.log('[Harm Detection] Toxicity model loaded, initializing...');
      this.initModel();
    };
    
    // Handle errors
    tfScript.onerror = () => {
      console.error('[Harm Detection] Failed to load TensorFlow.js');
      this.isLoading = false;
    };
    
    toxicityScript.onerror = () => {
      console.error('[Harm Detection] Failed to load toxicity model');
      this.isLoading = false;
    };
    
    // Add scripts to head
    document.head.appendChild(tfScript);
  },
  
  /**
   * Initialize toxicity model
   */
  initModel: function() {
    if (!window.toxicity) {
      console.error('[Harm Detection] Toxicity model not available');
      this.isLoading = false;
      return;
    }
    
    console.log('[Harm Detection] Loading toxicity model...');
    
    // Load toxicity model with threshold
    window.toxicity.load(this.threshold).then(model => {
      this.model = model;
      this.labels = model.model.outputNodes.map(node => {
        return node.split('/')[0];
      });
      
      console.log('[Harm Detection] Model loaded with labels:', this.labels);
      
      this.isModelLoaded = true;
      this.isLoading = false;
      
      // Analyze current input if any
      if (this.messageInput && this.messageInput.value.trim()) {
        this.handleInput({ target: this.messageInput });
      }
    }).catch(error => {
      console.error('[Harm Detection] Error loading model:', error);
      this.isLoading = false;
    });
  },
  
  /**
   * Handle input event
   * @param {Event} event - Input event
   */
  handleInput: function(event) {
    const text = event.target.value.trim();
    const now = Date.now();
    
    // Clear warning if input is empty
    if (!text) {
      this.clearWarning();
      return;
    }
    
    // Don't analyze if text is too short
    if (text.length < this.minAnalysisLength) {
      return;
    }
    
    // Don't analyze if text is unchanged or analysis is already in progress
    if (text === this.lastAnalyzedText || this.analysisInProgress) {
      return;
    }
    
    // Check cache first
    const cacheKey = this._generateCacheKey(text);
    if (this.textCache.has(cacheKey)) {
      const cachedResult = this.textCache.get(cacheKey);
      console.log('[Harm Detection] Using cached result');
      
      if (cachedResult.isHarmful) {
        this.showWarning(
          cachedResult.categories, 
          cachedResult.highestCategory, 
          cachedResult.score
        );
      } else {
        this.clearWarning();
      }
      
      return;
    }
    
    // Check for punctuation that might indicate a completed thought
    const lastChar = text.slice(-1);
    const punctuationMarks = ['.', '!', '?', ';'];
    const hasPunctuation = punctuationMarks.includes(lastChar);
    
    // Update typing state
    if (hasPunctuation) {
      this.lastPunctuationTime = now;
    }
    
    // Calculate adaptive debounce delay based on message length
    // Longer messages get a longer delay, up to a reasonable maximum
    const baseDelay = this.debounceDelay;
    const lengthFactor = Math.min(text.length / 100, 1.5); // Cap at 1.5x for very long messages
    const adaptiveDelay = Math.round(baseDelay * (1 + lengthFactor));
    
    console.log(`[Harm Detection] Adaptive delay: ${adaptiveDelay}ms (base: ${baseDelay}ms, length: ${text.length})`);
    
    // Update last typing time
    this.lastTypingTime = now;
    this.typingPaused = false;
    
    // Debounce analysis to avoid too many predictions
    clearTimeout(this.debounceTimeout);
    this.debounceTimeout = setTimeout(() => {
      const currentTime = Date.now();
      const timeSinceLastType = currentTime - this.lastTypingTime;
      const timeSincePunctuation = currentTime - this.lastPunctuationTime;
      
      // Check if user has paused typing after punctuation (pause + intention model)
      const pauseAfterPunctuation = hasPunctuation || 
                                   (timeSincePunctuation < 2000 && timeSinceLastType > 500);
      
      // If user has paused typing for a significant time or after punctuation, analyze
      if (timeSinceLastType > 500 || pauseAfterPunctuation) {
        console.log(`[Harm Detection] Analyzing after ${timeSinceLastType}ms pause${pauseAfterPunctuation ? ' following punctuation' : ''}`);
        
        // Only analyze if the text is still the same after the debounce
        if (text === event.target.value.trim()) {
          this.analyzeText(text);
          this.lastAnalyzedText = text;
          this.typingPaused = true;
        }
      }
    }, adaptiveDelay);
  },
  
  /**
   * Generate a cache key for text
   * @param {string} text - The text to generate a key for
   * @returns {string} - The cache key
   * @private
   */
  _generateCacheKey: function(text) {
    // For very long text, use a hash of the first 50 chars + length
    if (text.length > 50) {
      return `${text.substring(0, 50)}_${text.length}`;
    }
    return text;
  },
  
  /**
   * Analyze text for harmful content
   * @param {string} text - Text to analyze
   */
  analyzeText: function(text) {
    // Don't analyze if model is not loaded
    if (!this.isModelLoaded || !this.model) {
      return;
    }
    
    // Set analysis in progress flag
    this.analysisInProgress = true;
    
    console.log(`[Harm Detection] Analyzing text: "${text.substring(0, 20)}${text.length > 20 ? '...' : ''}"`);
    
    // Simple pre-check for obvious harmful content to avoid unnecessary API calls
    if (this._quickHarmCheck(text)) {
      this.showWarning([{ label: 'toxicity', probability: 0.9 }], 'toxicity', 0.9);
      this.analysisInProgress = false;
      return;
    }
    
    // Predict toxicity
    this.model.classify([text]).then(predictions => {
      // Get predictions with probability above threshold
      const harmfulCategories = [];
      let highestCategory = null;
      let highestScore = 0;
      
      predictions.forEach(prediction => {
        const label = prediction.label;
        const probability = prediction.results[0].probabilities[1]; // Index 1 is the probability of being toxic
        const match = probability >= this.threshold;
        
        if (match) {
          harmfulCategories.push({ label, probability });
          
          if (probability > highestScore) {
            highestScore = probability;
            highestCategory = label;
          }
        }
      });
      
      // Cache the result
      const cacheKey = this._generateCacheKey(text);
      this.textCache.set(cacheKey, {
        isHarmful: harmfulCategories.length > 0,
        categories: harmfulCategories,
        highestCategory,
        score: highestScore
      });
      
      // Limit cache size
      if (this.textCache.size > this.maxCacheSize) {
        const oldestKey = this.textCache.keys().next().value;
        this.textCache.delete(oldestKey);
      }
      
      // Show warning if any harmful categories found
      if (harmfulCategories.length > 0) {
        this.showWarning(harmfulCategories, highestCategory, highestScore);
      } else {
        this.clearWarning();
      }
      
      // Reset analysis in progress flag
      this.analysisInProgress = false;
    }).catch(error => {
      console.error('[Harm Detection] Error analyzing text:', error);
      this.analysisInProgress = false;
    });
  },
  
  /**
   * Quick check for obvious harmful content
   * @param {string} text - Text to check
   * @returns {boolean} - True if text contains obvious harmful content
   * @private
   */
  _quickHarmCheck: function(text) {
    // Simple list of obvious harmful words
    const harmfulWords = [
      'fuck', 'shit', 'asshole', 'bitch', 'cunt', 'damn', 'dick', 'bastard',
      'nigger', 'faggot', 'retard', 'tranny', 'kike', 'spic', 'chink'
    ];
    
    const lowerText = text.toLowerCase();
    
    // Check for exact matches with word boundaries
    for (const word of harmfulWords) {
      const regex = new RegExp(`\\b${word}\\b`, 'i');
      if (regex.test(lowerText)) {
        return true;
      }
    }
    
    return false;
  },
  
  /**
   * Show warning for harmful content
   * @param {Array} categories - Harmful categories
   * @param {string} highestCategory - Category with highest probability
   * @param {number} highestScore - Highest probability score
   */
  showWarning: function(categories, highestCategory, highestScore) {
    if (!this.warningElement) return;
    
    // Generate warning message based on highest category
    let message = '';
    switch (highestCategory) {
      case 'identity_attack':
        message = 'Your message may be perceived as an attack on someone\'s identity. Consider a more respectful approach.';
        break;
      case 'insult':
        message = 'Your message may be perceived as insulting. Consider a more constructive approach.';
        break;
      case 'obscene':
        message = 'Your message contains language that may be considered obscene. Consider rephrasing?';
        break;
      case 'severe_toxicity':
        message = 'Your message contains language that may be very harmful. Please reconsider.';
        break;
      case 'sexual_explicit':
        message = 'Your message contains sexually explicit content which is not appropriate for this space.';
        break;
      case 'threat':
        message = 'Your message may be perceived as threatening. Please reconsider.';
        break;
      case 'toxicity':
      default:
        message = 'Your message may come across as harsh—consider rewording?';
    }
    
    // Update warning element
    this.warningElement.textContent = message;
    this.warningElement.classList.remove('hidden');
    
    // Call onWarning callback
    if (typeof this.onWarning === 'function') {
      this.onWarning(categories, highestCategory, highestScore);
    }
  },
  
  /**
   * Clear warning
   */
  clearWarning: function() {
    if (!this.warningElement) return;
    
    // Hide warning element
    this.warningElement.classList.add('hidden');
    
    // Call onClear callback
    if (typeof this.onClear === 'function') {
      this.onClear();
    }
  },
  
  /**
   * Check text before sending
   * @param {string} text - Text to check
   * @returns {Promise<Object>} - Check result
   */
  checkBeforeSend: async function(text) {
    // Don't check if model is not loaded
    if (!this.isModelLoaded || !this.model) {
      return { isHarmful: false };
    }
    
    // Check cache first
    const cacheKey = this._generateCacheKey(text);
    if (this.textCache.has(cacheKey)) {
      const cachedResult = this.textCache.get(cacheKey);
      console.log('[Harm Detection] Using cached result for send check');
      
      // Add message to cached result
      if (cachedResult.isHarmful && !cachedResult.message) {
        cachedResult.message = this._getWarningMessage(cachedResult.highestCategory);
      }
      
      return cachedResult;
    }
    
    // Quick check for obvious harmful content
    if (this._quickHarmCheck(text)) {
      return {
        isHarmful: true,
        categories: [{ label: 'toxicity', probability: 0.9 }],
        highestCategory: 'toxicity',
        score: 0.9,
        message: 'Your message may come across as harsh—consider rewording?'
      };
    }
    
    try {
      // Predict toxicity
      const predictions = await this.model.classify([text]);
      
      // Get predictions with probability above threshold
      const harmfulCategories = [];
      let highestCategory = null;
      let highestScore = 0;
      
      predictions.forEach(prediction => {
        const label = prediction.label;
        const probability = prediction.results[0].probabilities[1]; // Index 1 is the probability of being toxic
        const match = probability >= this.threshold;
        
        if (match) {
          harmfulCategories.push({ label, probability });
          
          if (probability > highestScore) {
            highestScore = probability;
            highestCategory = label;
          }
        }
      });
      
      // Generate message based on highest category
      let message = '';
      if (highestCategory) {
        message = this._getWarningMessage(highestCategory);
      }
      
      // Cache the result
      const result = {
        isHarmful: harmfulCategories.length > 0,
        categories: harmfulCategories,
        highestCategory,
        score: highestScore,
        message
      };
      
      this.textCache.set(cacheKey, result);
      
      // Limit cache size
      if (this.textCache.size > this.maxCacheSize) {
        const oldestKey = this.textCache.keys().next().value;
        this.textCache.delete(oldestKey);
      }
      
      return result;
    } catch (error) {
      console.error('[Harm Detection] Error checking before send:', error);
      return { isHarmful: false };
    }
  },
  
  /**
   * Get warning message for a category
   * @param {string} category - The category
   * @returns {string} - The warning message
   * @private
   */
  _getWarningMessage: function(category) {
    switch (category) {
      case 'identity_attack':
        return 'Your message may be perceived as an attack on someone\'s identity. Consider a more respectful approach.';
      case 'insult':
        return 'Your message may be perceived as insulting. Consider a more constructive approach.';
      case 'obscene':
        return 'Your message contains language that may be considered obscene. Consider rephrasing?';
      case 'severe_toxicity':
        return 'Your message contains language that may be very harmful. Please reconsider.';
      case 'sexual_explicit':
        return 'Your message contains sexually explicit content which is not appropriate for this space.';
      case 'threat':
        return 'Your message may be perceived as threatening. Please reconsider.';
      case 'toxicity':
      default:
        return 'Your message may come across as harsh—consider rewording?';
    }
  }
};
