/**
 * perspective-api.js
 * Server-side harm detection using Google's Perspective API
 * Part of the Emergent Grounds layered moderation system (Layer 2)
 */

require('dotenv').config();
const { google } = require('googleapis');

class PerspectiveAPI {
  constructor() {
    this.apiKey = process.env.PERSPECTIVE_API_KEY;
    this.initialized = !!this.apiKey;
    
    if (!this.initialized) {
      console.warn('[Perspective API] No API key found in environment variables. Falling back to basic pattern matching.');
    } else {
      console.log('[Perspective API] Initialized with API key');
    }
    
    // Fallback patterns for when API is not available
    this.fallbackPatterns = {
      TOXICITY: [
        /\b(fuck|shit|ass|bitch|cunt|damn|dick|douchebag|asshole)\b/i,
        /\b(go to hell|screw you|go fuck yourself)\b/i
      ],
      SEVERE_TOXICITY: [
        /\b(motherfucker|cocksucker|fuckface|fucktard|cunt)\b/i
      ],
      IDENTITY_ATTACK: [
        /\b(nigger|nigga|kike|spic|chink|faggot|fag|retard|tranny)\b/i,
        /\b(go back to your country|you people|you are a disgrace)\b/i
      ],
      INSULT: [
        /\b(idiot|stupid|dumb|moron|loser|pathetic|worthless)\b/i,
        /\b(shut up|you're an idiot|you're stupid|you're dumb)\b/i
      ],
      THREAT: [
        /\b(kill|murder|hurt|punch|beat|attack|die|death)\b/i,
        /\b(i will find you|i will hurt you|you'll regret|you'll pay)\b/i
      ]
    };
  }

  /**
   * Analyze text for harmful content using Perspective API
   * @param {string} text - The text to analyze
   * @param {Array<string>} attributes - The attributes to analyze (default: all available)
   * @returns {Promise<Object>} - The analysis results
   */
  async analyzeText(text, attributes = [
    'TOXICITY',
    'SEVERE_TOXICITY',
    'IDENTITY_ATTACK',
    'INSULT',
    'THREAT'
  ]) {
    // Don't analyze empty text
    if (!text || text.trim().length === 0) {
      return { 
        attributeScores: {},
        error: null,
        usedFallback: false
      };
    }
    
    // If API key is not available, use fallback pattern matching
    if (!this.initialized) {
      return this.fallbackAnalysis(text, attributes);
    }
    
    try {
      // Initialize the Perspective API client
      const discoveryUrl = 'https://commentanalyzer.googleapis.com/$discovery/rest?version=v1alpha1';
      const client = await google.discoverAPI(discoveryUrl);
      
      // Prepare the request
      const analyzeRequest = {
        comment: { text },
        requestedAttributes: {},
        languages: ['en'],
        doNotStore: true // Don't store the comment for future training
      };
      
      // Add requested attributes
      attributes.forEach(attribute => {
        analyzeRequest.requestedAttributes[attribute] = {};
      });
      
      // Make the API request
      const response = await client.comments.analyze({
        key: this.apiKey,
        resource: analyzeRequest
      });
      
      console.log(`[Perspective API] Successfully analyzed text (${text.length} chars)`);
      
      return {
        attributeScores: response.data.attributeScores,
        error: null,
        usedFallback: false
      };
    } catch (error) {
      console.error('[Perspective API] Error analyzing text:', error.message);
      
      // Fall back to pattern matching if API request fails
      return this.fallbackAnalysis(text, attributes);
    }
  }
  
  /**
   * Fallback analysis using regex patterns when API is not available
   * @param {string} text - The text to analyze
   * @param {Array<string>} attributes - The attributes to analyze
   * @returns {Object} - The analysis results in a format similar to Perspective API
   */
  fallbackAnalysis(text, attributes) {
    console.log('[Perspective API] Using fallback pattern matching');
    
    const attributeScores = {};
    
    // Check each requested attribute against patterns
    attributes.forEach(attribute => {
      if (this.fallbackPatterns[attribute]) {
        const patterns = this.fallbackPatterns[attribute];
        let matchCount = 0;
        
        // Count matches for each pattern
        patterns.forEach(pattern => {
          const matches = text.match(pattern);
          if (matches) {
            matchCount += matches.length;
          }
        });
        
        // Calculate a score based on match count
        // More matches = higher score
        const score = Math.min(1.0, matchCount * 0.3);
        
        attributeScores[attribute] = {
          summaryScore: { value: score }
        };
      }
    });
    
    return {
      attributeScores,
      error: null,
      usedFallback: true
    };
  }
  
  /**
   * Check if text contains harmful content
   * @param {string} text - The text to check
   * @param {number} threshold - The threshold for harmful content (0.0 to 1.0)
   * @returns {Promise<Object>} - The check results
   */
  async checkHarmful(text, threshold = 0.7) {
    const analysis = await this.analyzeText(text);
    
    let isHarmful = false;
    let highestAttribute = null;
    let highestScore = 0;
    let message = null;
    
    // Check each attribute score against threshold
    if (analysis.attributeScores) {
      Object.entries(analysis.attributeScores).forEach(([attribute, data]) => {
        const score = data.summaryScore.value;
        
        if (score >= threshold) {
          isHarmful = true;
          
          if (score > highestScore) {
            highestScore = score;
            highestAttribute = attribute;
          }
        }
      });
    }
    
    // Generate appropriate message based on highest attribute
    if (isHarmful && highestAttribute) {
      switch (highestAttribute) {
        case 'TOXICITY':
          message = 'Your message contains language that may come across as toxic. Consider rephrasing?';
          break;
        case 'SEVERE_TOXICITY':
          message = 'Your message contains language that may be very harmful. Please reconsider.';
          break;
        case 'IDENTITY_ATTACK':
          message = 'Your message may be perceived as an attack on someone\'s identity. Consider a more respectful approach.';
          break;
        case 'INSULT':
          message = 'Your message may be perceived as insulting. Consider a more constructive approach.';
          break;
        case 'THREAT':
          message = 'Your message may be perceived as threatening. Please reconsider.';
          break;
        default:
          message = 'Your message may come across as harmful. Consider rephrasing?';
      }
    }
    
    return {
      isHarmful,
      attribute: highestAttribute,
      score: highestScore,
      message,
      usedFallback: analysis.usedFallback
    };
  }
}

module.exports = new PerspectiveAPI();
