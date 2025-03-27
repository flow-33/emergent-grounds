/**
 * conversation-visualization.js
 * Visualizes the health and state of the conversation as a living soil/garden
 * Part of the Emergent Grounds layered moderation system
 */

class ConversationVisualization {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.width = 0;
    this.height = 0;
    this.animationFrame = null;
    this.particles = [];
    this.plants = [];
    this.soilHealth = 0.5; // Start at 50% health (0.0 to 1.0, where 1.0 is perfectly healthy)
    this.soilColor = { r: 101, g: 67, b: 33 }; // Base soil color (brown)
    this.healthyColor = { r: 101, g: 67, b: 33 }; // Healthy soil color
    this.unhealthyColor = { r: 130, g: 60, b: 20 }; // Unhealthy soil color (more reddish)
    this.lastUpdateTime = 0;
    this.messageCount = 0;
    this.positiveInteractions = 0;
    this.negativeInteractions = 0;
    this.plantGrowthStage = 0; // 0-5, where 0 is seed and 5 is full plant
    this.isAnimating = false;
    this.rippleEffects = [];
    this.positiveMessageStreak = 0; // Track consecutive positive messages
  }

  /**
   * Initialize the visualization with a canvas element
   * @param {HTMLCanvasElement} canvas - The canvas element to draw on
   */
  initialize(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();

    // Listen for window resize
    window.addEventListener('resize', this.resize.bind(this));

    // Initialize particles
    this.initializeParticles();

    // Start animation
    this.isAnimating = true;
    this.animate();

    console.log('[Visualization] Initialized with canvas');
  }

  /**
   * Resize the canvas to fit its container
   */
  resize() {
    if (!this.canvas) return;

    const container = this.canvas.parentElement;
    this.width = container.clientWidth;
    this.height = 120; // Fixed height for the soil visualization

    this.canvas.width = this.width;
    this.canvas.height = this.height;

    // Reinitialize particles when resizing
    this.initializeParticles();
  }

  /**
   * Initialize soil particles
   */
  initializeParticles() {
    this.particles = [];
    const particleCount = Math.floor(this.width / 4); // One particle every ~4px

    for (let i = 0; i < particleCount; i++) {
      this.particles.push({
        x: Math.random() * this.width,
        y: this.height - 10 - Math.random() * 30,
        size: 2 + Math.random() * 3,
        speedX: 0,
        speedY: 0,
        color: this.getSoilParticleColor(),
        alpha: 0.6 + Math.random() * 0.4
      });
    }
  }

  /**
   * Initialize plants
   */
  initializePlants() {
    this.plants = [];
    const plantCount = Math.min(5, Math.floor(this.messageCount / 10)); // Add a plant every 10 messages, up to 5

    for (let i = 0; i < plantCount; i++) {
      const x = 50 + (i * (this.width - 100) / Math.max(1, plantCount - 1));
      this.plants.push({
        x: x,
        y: this.height - 15,
        stage: Math.min(this.plantGrowthStage, 5),
        health: this.soilHealth,
        lastGrowth: Date.now()
      });
    }
  }

  /**
   * Get a color for a soil particle based on current health
   * @returns {string} - CSS color string
   */
  getSoilParticleColor() {
    // Interpolate between healthy and unhealthy colors based on soil health
    const r = Math.floor(this.healthyColor.r + (this.unhealthyColor.r - this.healthyColor.r) * (1 - this.soilHealth));
    const g = Math.floor(this.healthyColor.g + (this.unhealthyColor.g - this.healthyColor.g) * (1 - this.soilHealth));
    const b = Math.floor(this.healthyColor.b + (this.unhealthyColor.b - this.healthyColor.b) * (1 - this.soilHealth));
    
    // Add some variation
    const variation = 15;
    const vr = Math.floor(Math.random() * variation - variation/2);
    const vg = Math.floor(Math.random() * variation - variation/2);
    const vb = Math.floor(Math.random() * variation - variation/2);
    
    return `rgb(${Math.max(0, Math.min(255, r + vr))}, ${Math.max(0, Math.min(255, g + vg))}, ${Math.max(0, Math.min(255, b + vb))})`;
  }

  /**
   * Animation loop
   */
  animate() {
    if (!this.isAnimating) return;

    const now = Date.now();
    const dt = (now - this.lastUpdateTime) / 1000;
    this.lastUpdateTime = now;

    this.update(dt);
    this.draw();

    this.animationFrame = requestAnimationFrame(this.animate.bind(this));
  }

  /**
   * Update the visualization state
   * @param {number} dt - Time delta in seconds
   */
  update(dt) {
    // Update soil particles
    this.particles.forEach(particle => {
      // Add some subtle movement
      particle.x += (Math.random() - 0.5) * 0.5;
      particle.y += (Math.random() - 0.5) * 0.2;
      
      // Keep particles within bounds
      if (particle.x < 0) particle.x = this.width;
      if (particle.x > this.width) particle.x = 0;
      if (particle.y < this.height - 40) particle.y = this.height - 10;
      if (particle.y > this.height - 5) particle.y = this.height - 10;
    });

    // Update ripple effects
    for (let i = this.rippleEffects.length - 1; i >= 0; i--) {
      const ripple = this.rippleEffects[i];
      ripple.radius += ripple.speed * dt;
      ripple.alpha -= dt * 0.5;
      
      if (ripple.alpha <= 0) {
        this.rippleEffects.splice(i, 1);
      }
    }

    // Update plants
    this.plants.forEach(plant => {
      // Grow plants over time based on soil health
      if (now - plant.lastGrowth > 30000 && plant.stage < 5 && this.soilHealth > 0.5) {
        plant.stage += 1;
        plant.lastGrowth = now;
      }
      
      // Update plant health based on soil health
      plant.health = this.soilHealth;
    });
  }

  /**
   * Draw the visualization
   */
  draw() {
    if (!this.ctx) return;

    // Clear canvas
    this.ctx.clearRect(0, 0, this.width, this.height);

    // Draw background gradient for soil
    const gradient = this.ctx.createLinearGradient(0, this.height - 40, 0, this.height);
    const r = Math.floor(this.healthyColor.r + (this.unhealthyColor.r - this.healthyColor.r) * (1 - this.soilHealth));
    const g = Math.floor(this.healthyColor.g + (this.unhealthyColor.g - this.healthyColor.g) * (1 - this.soilHealth));
    const b = Math.floor(this.healthyColor.b + (this.unhealthyColor.b - this.healthyColor.b) * (1 - this.soilHealth));
    
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.2)`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.6)`);
    
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, this.height - 40, this.width, 40);

    // Draw ripple effects
    this.rippleEffects.forEach(ripple => {
      this.ctx.beginPath();
      this.ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
      this.ctx.strokeStyle = `rgba(${ripple.color.r}, ${ripple.color.g}, ${ripple.color.b}, ${ripple.alpha})`;
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
    });

    // Draw soil particles
    this.particles.forEach(particle => {
      this.ctx.beginPath();
      this.ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      this.ctx.fillStyle = particle.color;
      this.ctx.globalAlpha = particle.alpha;
      this.ctx.fill();
    });
    
    this.ctx.globalAlpha = 1.0;

    // Draw plants
    this.plants.forEach(plant => {
      this.drawPlant(plant);
    });

    // Draw soil health indicator
    this.drawHealthIndicator();
  }

  /**
   * Draw a plant
   * @param {Object} plant - Plant object
   */
  drawPlant(plant) {
    const ctx = this.ctx;
    const stage = plant.stage;
    const health = plant.health;
    
    // Base color depends on health
    const greenValue = Math.floor(100 + (health * 100));
    const stemColor = `rgb(0, ${greenValue}, 0)`;
    const leafColor = `rgb(50, ${greenValue + 30}, 50)`;
    
    ctx.save();
    ctx.translate(plant.x, plant.y);
    
    // Draw based on growth stage
    if (stage >= 1) {
      // Draw stem
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -10 * stage);
      ctx.strokeStyle = stemColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    if (stage >= 2) {
      // Draw small leaves
      ctx.beginPath();
      ctx.ellipse(-5, -10 * stage + 5, 5, 3, Math.PI / 4, 0, Math.PI * 2);
      ctx.fillStyle = leafColor;
      ctx.fill();
      
      ctx.beginPath();
      ctx.ellipse(5, -10 * stage + 8, 5, 3, -Math.PI / 4, 0, Math.PI * 2);
      ctx.fillStyle = leafColor;
      ctx.fill();
    }
    
    if (stage >= 3) {
      // Draw medium leaves
      ctx.beginPath();
      ctx.ellipse(-7, -10 * stage + 15, 7, 4, Math.PI / 4, 0, Math.PI * 2);
      ctx.fillStyle = leafColor;
      ctx.fill();
      
      ctx.beginPath();
      ctx.ellipse(7, -10 * stage + 18, 7, 4, -Math.PI / 4, 0, Math.PI * 2);
      ctx.fillStyle = leafColor;
      ctx.fill();
    }
    
    if (stage >= 4) {
      // Draw larger leaves
      ctx.beginPath();
      ctx.ellipse(-9, -10 * stage + 25, 9, 5, Math.PI / 4, 0, Math.PI * 2);
      ctx.fillStyle = leafColor;
      ctx.fill();
      
      ctx.beginPath();
      ctx.ellipse(9, -10 * stage + 28, 9, 5, -Math.PI / 4, 0, Math.PI * 2);
      ctx.fillStyle = leafColor;
      ctx.fill();
    }
    
    if (stage >= 5) {
      // Draw flower or fruit
      ctx.beginPath();
      ctx.arc(0, -10 * stage - 5, 6, 0, Math.PI * 2);
      
      // Color based on health
      if (health > 0.8) {
        ctx.fillStyle = 'rgb(255, 200, 100)'; // Healthy yellow flower
      } else if (health > 0.5) {
        ctx.fillStyle = 'rgb(200, 150, 100)'; // Less vibrant flower
      } else {
        ctx.fillStyle = 'rgb(150, 100, 100)'; // Wilting flower
      }
      
      ctx.fill();
      
      // Flower center
      ctx.beginPath();
      ctx.arc(0, -10 * stage - 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(100, 80, 0)';
      ctx.fill();
    }
    
    ctx.restore();
  }

  /**
   * Draw soil health indicator
   */
  drawHealthIndicator() {
    const ctx = this.ctx;
    const width = 60;
    const height = 8;
    const x = this.width - width - 10;
    const y = 10;
    
    // Draw background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(x, y, width, height);
    
    // Draw health bar
    const healthWidth = width * this.soilHealth;
    
    // Color gradient based on health
    let barColor;
    if (this.soilHealth > 0.7) {
      barColor = 'rgb(0, 150, 0)'; // Healthy green
    } else if (this.soilHealth > 0.4) {
      barColor = 'rgb(200, 200, 0)'; // Warning yellow
    } else {
      barColor = 'rgb(200, 0, 0)'; // Danger red
    }
    
    ctx.fillStyle = barColor;
    ctx.fillRect(x, y, healthWidth, height);
    
    // Draw border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.strokeRect(x, y, width, height);
    
    // Draw label
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.font = '10px Arial';
    ctx.textAlign = 'right';
    ctx.fillText('Soil Health', x - 5, y + height / 2 + 3);
  }

  /**
   * Update the soil health based on conversation state
   * @param {number} health - New health value (0.0 to 1.0)
   */
  updateSoilHealth(health) {
    // Smoothly transition to new health value
    const oldHealth = this.soilHealth;
    this.soilHealth = health;
    
    // Update soil particle colors
    this.particles.forEach(particle => {
      particle.color = this.getSoilParticleColor();
    });
    
    console.log(`[Visualization] Soil health updated: ${oldHealth.toFixed(2)} -> ${health.toFixed(2)}`);
  }

  /**
   * Add a new message to the visualization
   * @param {Object} message - Message object
   * @param {boolean} isPositive - Whether the message has positive sentiment
   */
  addMessage(message, isPositive = true) {
    this.messageCount++;
    
    // Skip soil health updates for system messages
    if (message.type === 'system') {
      console.log(`[Visualization] System message added, not affecting soil health`);
      return;
    }
    
    // Update positive/negative interaction counts
    if (isPositive) {
      this.positiveInteractions++;
      this.positiveMessageStreak++;
      
      // Gradually increase soil health for positive messages, capped at +0.05 per message
      let newHealth = this.soilHealth;
      
      // Cap at 0.8 until we have at least 6 positive messages
      const maxHealth = (this.positiveInteractions >= 6) ? 1.0 : 0.8;
      
      // Apply a small increase, capped at the maximum allowed health
      newHealth = Math.min(maxHealth, newHealth + 0.05);
      
      this.updateSoilHealth(newHealth);
      
    } else {
      this.negativeInteractions++;
      this.positiveMessageStreak = 0;
      
      // Decrease health slightly for negative messages
      const healthReduction = 0.03; // Small decrease for negative messages
      this.updateSoilHealth(Math.max(0.1, this.soilHealth - healthReduction));
    }
    
    // Add a ripple effect
    const rippleX = Math.random() * this.width;
    const rippleY = this.height - 20;
    
    let rippleColor;
    if (isPositive) {
      rippleColor = { r: 100, g: 200, b: 100 }; // Green for positive
    } else {
      rippleColor = { r: 200, g: 100, b: 100 }; // Red for negative
    }
    
    this.rippleEffects.push({
      x: rippleX,
      y: rippleY,
      radius: 5,
      speed: 20,
      alpha: 0.7,
      color: rippleColor
    });
    
    // Update plant growth stage based on message count
    this.plantGrowthStage = Math.min(5, Math.floor(this.messageCount / 5));
    
    // Reinitialize plants
    this.initializePlants();
    
    console.log(`[Visualization] Message added (${isPositive ? 'positive' : 'negative'}), total: ${this.messageCount}, health: ${this.soilHealth.toFixed(2)}`);
  }

  /**
   * Add a tension ripple to visualize tension in the conversation
   * @param {number} intensity - Intensity of the tension (0.0 to 1.0)
   */
  addTensionRipple(intensity) {
    const rippleCount = Math.floor(intensity * 5) + 1;
    
    for (let i = 0; i < rippleCount; i++) {
      const rippleX = Math.random() * this.width;
      const rippleY = this.height - 20;
      
      this.rippleEffects.push({
        x: rippleX,
        y: rippleY,
        radius: 5,
        speed: 30 + (intensity * 20),
        alpha: 0.5 + (intensity * 0.3),
        color: { r: 200, g: 50, b: 50 }
      });
    }
    
    // Decrease soil health based on tension intensity
    const healthReduction = intensity * 0.2;
    this.updateSoilHealth(Math.max(0.1, this.soilHealth - healthReduction));
    
    console.log(`[Visualization] Tension ripple added with intensity ${intensity.toFixed(2)}`);
  }

  /**
   * Stop the animation
   */
  stop() {
    this.isAnimating = false;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
  }
}

// Create global instance
window.conversationVisualization = new ConversationVisualization();
