# Emergent Grounds

> Tending the space between us—one conversation at a time.

Emergent Grounds is a real-time conversation space that facilitates meaningful dialogue between two participants, with gentle AI moderation to encourage depth and reflection.

## Philosophy

This is not about debate, winning, or agreement. It is about *emergence*. The space between participants is treated as sacred and alive, and it is there that new understanding, new compassion, and new ideas can arise.

### Foundational Principles

- **Honor the Space Between:** Truth does not live in either of us—it lives between us.
- **Respect Before Inquiry:** Acknowledge the other's worth, independent of appearance, background, or behavior.
- **Stay in the Moment:** Truth emerges through presence, not preconception.
- **Ask, Don't Assume:** Curiosity is the engine. Assumptions are the brakes.
- **Co-discover, Don't Convince:** This is not about conversion but creation.
- **Slow Down to Tune In:** Pauses are part of the rhythm.
- **Leave With More Questions:** Completion isn't resolution, but insight that leads to more depth.

## Overview

This project creates a two-person real-time conversation space moderated by an AI (OpenAI/Claude), using Socket.io and a lightweight Node.js backend. The experience is designed to foster thoughtful, present, and emotionally spacious dialogue.

## Features

- **Real-time chat** using Socket.io
- **Poetic participant names** assigned automatically
- **Layered AI moderation system:**
  - **Layer 1:** Client-side tone caution using TensorFlow.js
  - **Layer 2:** Server-side harm detection using Perspective API
  - **Layer 3:** Contextual + relational insight using OpenAI GPT-3.5
- **Ritual entry & intention setting**
- **Minimalist, calming UI** with soft colors and thoughtful spacing

## Technical Architecture

- **Frontend**: HTML, CSS, and vanilla JavaScript
- **Backend**: Node.js with Express
- **Real-time Communication**: Socket.io
- **AI Integration**: OpenAI API (optional)
- **Session Management**: In-memory storage

## Project Structure

```
root/
├── public/                 // Static assets (HTML, CSS, JS frontend)
│   ├── index.html          // Landing page
│   ├── conversation.html   // Chat UI
│   ├── manifesto.html      // Project manifesto
│   ├── ritual.html         // Ritual entry experience
│   ├── css/
│   │   └── styles.css      // Styling
│   └── js/
│       └── harm-detection.js // Client-side tone caution (Layer 1)
├── server.js               // Express + Socket.io server
├── ai-moderator.js         // AI moderation logic (Layer 3)
├── perspective-api.js      // Server-side harm detection (Layer 2)
├── session-store.js        // Manage in-memory sessions
├── package.json            // Dependencies
└── .env                    // Environment variables (not in repo)
```

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn

### Installation

1. Clone the repository
   ```
   git clone https://github.com/yourusername/emergent-grounds.git
   cd emergent-grounds
   ```

2. Install dependencies
   ```
   npm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```
   PORT=3000
   NODE_ENV=development
   
   # OpenAI Configuration - Layer 3: Contextual + Relational Insight
   OPENAI_API_KEY=your_openai_api_key_here
   OPENAI_MODEL=gpt-3.5-turbo
   
   # Google Perspective API Key - Layer 2: Server-Side Harm Detection
   # Get your API key from: https://developers.perspectiveapi.com/s/docs-get-started
   PERSPECTIVE_API_KEY=your_perspective_api_key_here
   ```

4. Start the server
   ```
   npm start
   ```

5. Visit `http://localhost:3000` in your browser

## Usage

1. Open the application in your browser
2. Click "Enter Conversation Space"
3. Complete the ritual entry process to set your intentions
4. You'll be assigned a poetic name and placed in a room
5. Wait for another participant to join, or open another browser window to simulate a second participant
6. Begin your conversation with the support of the layered moderation system:
   - As you type, the client-side TensorFlow.js model analyzes your message for potentially harmful content
   - When you send a message, the server-side Perspective API performs a deeper analysis
   - The OpenAI-powered moderator offers reflective prompts and intervenes if needed
7. The conversation is guided by gentle AI interventions that help maintain a respectful, thoughtful space

## License

This project is licensed under the GPL-3.0 License - see the LICENSE file for details.
