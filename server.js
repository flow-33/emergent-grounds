/**
 * server.js
 * Express + Socket.io server for Emergent Grounds real-time chat
 */

// Load environment variables
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// Import custom modules
const sessionStore = require('./session-store');
const aiModerator = require('./ai-moderator');

// Messages for when a user joins the conversation
const FIRST_USER_MESSAGES = [
  "Welcome, {username}! You're the first one here. Waiting for another groundkeeper to join...",
  "You've created a new space as {username}. Waiting for someone else to join the conversation...",
  "This space is ready for connection. You've joined as {username}. Waiting for another participant to join you..."
];

const SECOND_USER_MESSAGES = [
  "You joined as {username}. {otherUsername} is already in the room. Say hello to them!",
  "Welcome, {username}! {otherUsername} has been waiting for someone to join. Feel free to say hello.",
  "You've entered as {username}. {otherUsername} is already here. Why not introduce yourself?"
];

// Function to get a personalized welcome message
function getWelcomeMessage(roomId, username) {
  const participants = sessionStore.getRoomParticipants(roomId);
  
  // If this is the first participant
  if (participants.length === 1) {
    const randomIndex = Math.floor(Math.random() * FIRST_USER_MESSAGES.length);
    return FIRST_USER_MESSAGES[randomIndex].replace('{username}', username);
  } 
  // If this is the second participant
  else if (participants.length === 2) {
    // Get the other participant's name
    const otherParticipant = participants.find(p => p.name !== username);
    if (otherParticipant) {
      const randomIndex = Math.floor(Math.random() * SECOND_USER_MESSAGES.length);
      return SECOND_USER_MESSAGES[randomIndex]
        .replace('{username}', username)
        .replace('{otherUsername}', otherParticipant.name);
    }
  }
  
  // Fallback to generic message
  return `${username} has joined the conversation.`;
}

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Global ritual completion tracking
const globalRitualParticipants = new Map(); // Map of roomId -> Set of socketIds that completed ritual

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  let participantData = null;

  // Handle ritual completion
  socket.on('ritual_complete', () => {
    try {
      console.log(`Participant ${socket.id} completed ritual`);
      
      // Assign to a room and get poetic name if not already assigned
      if (!participantData) {
        participantData = sessionStore.joinOrCreateRoom(socket.id);
      }
      
      const { roomId, name } = participantData;
      console.log(`Participant ${name} (${socket.id}) assigned to room ${roomId}`);
      
      // Initialize set for this room if it doesn't exist
      if (!globalRitualParticipants.has(roomId)) {
        globalRitualParticipants.set(roomId, new Set());
      }
      
      // Add this participant to the set of completed rituals
      globalRitualParticipants.get(roomId).add(socket.id);
      
      // Get all participants in the room
      const roomParticipants = sessionStore.getRoomParticipants(roomId);
      console.log(`Room ${roomId} participants:`, roomParticipants.map(p => `${p.name} (${p.socketId})`));
      console.log(`Ritual completed participants:`, [...globalRitualParticipants.get(roomId)]);
      
      // Check if all participants in the room have completed the ritual
      // Only consider active participants in the room
      const activeParticipantIds = new Set(roomParticipants.map(p => p.socketId));
      const activeCompletedRituals = [...globalRitualParticipants.get(roomId)]
        .filter(id => activeParticipantIds.has(id));
      
      console.log(`Active participants in room ${roomId}:`, 
        roomParticipants.map(p => `${p.name} (${p.socketId})`));
      console.log(`Active ritual completed participants:`, activeCompletedRituals);
      
      if (roomParticipants.length > 1 && 
          activeCompletedRituals.length === roomParticipants.length) {
        console.log(`All participants in room ${roomId} have completed the ritual`);
        
        // Notify all participants that both have completed the ritual
        roomParticipants.forEach(participant => {
          io.to(participant.socketId).emit('ritual_both_complete', {
            roomId,
            name: participant.name
          });
        });
      } else {
        console.log(`Waiting for other participants in room ${roomId}. Current: ${activeCompletedRituals.length}/${roomParticipants.length}`);
      }
    } catch (error) {
      console.error('Error in ritual_complete handler:', error);
      socket.emit('error', { message: 'Failed to process ritual completion' });
    }
  });

      // Handle participant joining with completed ritual
      socket.on('join_with_ritual', async (data) => {
        try {
          const { roomId, name, experienceLevel, suggestionThreshold } = data;
          
          console.log(`Participant ${name} (${socket.id}) attempting to join room ${roomId} after ritual`);
          console.log(`Experience level: ${experienceLevel}, Suggestion threshold: ${suggestionThreshold}`);
      
      // Validate the room exists
      const room = sessionStore.getRoom(roomId);
      if (!room) {
        console.error(`Room ${roomId} not found`);
        socket.emit('error', { message: 'Invalid room' });
        return;
      }
      
      // Join the socket.io room
      socket.join(roomId);
      
      // Store participant data in session store
      sessionStore.participants.set(socket.id, {
        roomId,
        name
      });
      
      // Add to room participants if not already there
      if (!room.participants.has(socket.id)) {
        room.participants.add(socket.id);
      }
      
      // Store participant data locally
      participantData = { 
        roomId, 
        name,
        experienceLevel,
        suggestionThreshold
      };
      
      console.log(`Participant ${name} (${socket.id}) joined room ${roomId} after ritual`);
      console.log(`Room participants:`, [...room.participants].map(id => {
        const p = sessionStore.participants.get(id);
        return p ? `${p.name} (${id})` : `Unknown (${id})`;
      }));
      
      // Get conversation starters if this is a new conversation
      const userId = socket.id;
      
      try {
        // Handle the case where getConversationStarters might return a Promise
        const conversationStarters = await Promise.resolve(aiModerator.getConversationStarters(roomId, userId, undefined, undefined, suggestionThreshold));
        
        console.log(`[Server] Got conversation starters for user ${userId}:`, conversationStarters ? 'yes' : 'no');
        
        // Send welcome message to the participant
        socket.emit('joined', {
          roomId,
          name,
          isNewRoom: false,
          conversationStarters: conversationStarters,
          experienceLevel: experienceLevel,
          suggestionThreshold: suggestionThreshold
        });
      } catch (error) {
        console.error('Error getting conversation starters:', error);
        
        // Send welcome message without starters if there was an error
        socket.emit('joined', {
          roomId,
          name,
          isNewRoom: false,
          experienceLevel: experienceLevel,
          suggestionThreshold: suggestionThreshold
        });
      }
      
    // Generate personalized welcome message
    const welcomeMessage = getWelcomeMessage(roomId, name);
    
    // Notify room of the new participant with personalized message
    io.to(roomId).emit('system_message', {
      type: 'system',
      content: welcomeMessage
    });
      
      // Get message history and filter out any "left the conversation" messages for this participant
      let messages = sessionStore.getMessages(roomId);
      
      // Filter out any recent "left the conversation" messages for this participant
      // This prevents the awkward situation where a user sees they "left the conversation"
      // right before they joined it (which happens during the ritual->conversation transition)
      messages = messages.filter(msg => {
        return !(
          msg.type === 'system' && 
          msg.content.includes(`${name} has left the conversation`)
        );
      });
      
      // Update the filtered messages in the session store
      sessionStore.rooms.get(roomId).messages = messages;
      
      // Send filtered message history to the new participant
      if (messages.length > 0) {
        socket.emit('message_history', messages);
      }
      
    } catch (error) {
      console.error('Error in join_with_ritual handler:', error);
      socket.emit('error', { message: 'Failed to join conversation' });
    }
  });
  
  // Legacy join handler (redirects to ritual)
  socket.on('join', () => {
    socket.emit('error', { message: 'Please complete the entry ritual first' });
  });
  
  // Handle request for conversation starters (including health-based resurfacing)
  socket.on('get_conversation_starters', async (data) => {
    try {
      if (!participantData) {
        socket.emit('error', { message: 'You must join a room first' });
        return;
      }
      
      const { roomId } = participantData;
      const userId = socket.id; // Use socket ID as user identifier
      const conversationHealth = data.health; // Optional health parameter
      const context = data.context; // Optional conversation context for smart suggestions
      
      // Get the user's threshold from the request or from participantData
      const userThreshold = data.suggestionThreshold || participantData.suggestionThreshold;
      console.log(`[Server] User ${userId} has threshold ${userThreshold} (from ${data.suggestionThreshold ? 'request' : 'participantData'})`);
      
      // Get conversation starters from AI moderator using the user's specific threshold
      const starters = await aiModerator.getConversationStarters(roomId, userId, conversationHealth, context, userThreshold);
      
      // If starters is an object with resurfaced property, it's a special case
      if (starters && starters.resurfaced) {
        console.log(`[Server] Resurfacing conversation starters for user ${userId} due to low health: ${conversationHealth}`);
        
        // Send special resurfaced starters
        socket.emit('conversation_starters', {
          starters: starters.starters,
          resurfaced: true,
          message: starters.message,
          userId: userId
        });
      } else if (starters) {
        // Send regular starters
        socket.emit('conversation_starters', { 
          starters: starters,
          userId: userId
        });
      }
      
    } catch (error) {
      console.error('Error in get_conversation_starters handler:', error);
      socket.emit('error', { message: 'Failed to get conversation starters' });
    }
  });

  // Handle typing indicator start
  socket.on('typing_start', () => {
    try {
      if (!participantData) return;
      
      const { roomId, name } = participantData;
      
      // Broadcast typing indicator to the room (except sender)
      socket.to(roomId).emit('typing', {
        sender: socket.id,
        name
      });
      
    } catch (error) {
      console.error('Error in typing_start handler:', error);
    }
  });
  
  // Handle typing indicator stop
  socket.on('typing_stop', () => {
    try {
      if (!participantData) return;
      
      const { roomId } = participantData;
      
      // Broadcast typing stop to the room (except sender)
      socket.to(roomId).emit('typing_stop', {
        sender: socket.id
      });
      
    } catch (error) {
      console.error('Error in typing_stop handler:', error);
    }
  });
  
  // Handle marking a suggestion as used
  socket.on('mark_suggestion_used', (data) => {
    try {
      if (!participantData) {
        socket.emit('error', { message: 'You must join a room first' });
        return;
      }
      
      const { roomId } = participantData;
      const userId = socket.id;
      const suggestion = data.suggestion;
      
      console.log(`[Server] Marking suggestion as used for user ${userId} in room ${roomId}: "${suggestion.substring(0, 30)}..."`);
      
      // Mark the starter as used in the AI moderator
      aiModerator.markStarterAsUsed(roomId, userId, suggestion);
      
      // Send confirmation back to the client
      socket.emit('suggestion_used_confirmed', { success: true });
      
    } catch (error) {
      console.error('Error in mark_suggestion_used handler:', error);
      socket.emit('error', { message: 'Failed to mark suggestion as used' });
    }
  });
  
  // Handle chat messages
  socket.on('send_message', async (messageData) => {
    try {
      if (!participantData) {
        socket.emit('error', { message: 'You must join a room first' });
        return;
      }
      
      const { roomId, name } = participantData;
      
      // Create the message object
      const message = {
        type: 'participant',
        name,
        content: messageData.content,
        sender: socket.id
      };
      
      // Store the message
      sessionStore.addMessage(roomId, message);
      
      // Broadcast to the room
      io.to(roomId).emit('new_message', message);
      
      // Process with AI moderator
      console.log(`[Server] Processing message with AI moderator for room ${roomId}`);
      // Note: processMessage is now async due to Perspective API integration
      const aiResponse = await aiModerator.processMessage(roomId, message);
      
      if (aiResponse) {
        console.log(`[Server] Received AI response: ${aiResponse.content}`);
        
        // Check if this is a force disconnect message
        if (aiResponse.metadata && aiResponse.metadata.forceDisconnect) {
          console.log(`[Server] Force disconnect triggered for user ${socket.id} in room ${roomId}`);
          
          // Send disconnect notification to the specific user
          socket.emit('force_disconnect', {
            content: aiResponse.content,
            reason: aiResponse.metadata.reason
          });
          
          // Also notify the room
          sessionStore.addMessage(roomId, {
            type: 'system',
            content: `${name} has been removed from the conversation due to moderation.`
          });
          
          io.to(roomId).emit('system_message', {
            type: 'system',
            content: `${name} has been removed from the conversation due to moderation.`
          });
          
          // Force disconnect the socket after a short delay to ensure the message is received
          setTimeout(() => {
            socket.disconnect(true);
          }, 1000);
        }
        // Check if this is a cooldown message
        else if (aiResponse.metadata && aiResponse.metadata.cooldown) {
          // Send cooldown notification to the specific user
          socket.emit('cooldown', {
            content: aiResponse.content,
            duration: aiResponse.metadata.duration || 10 // Use provided duration or default to 10 seconds
          });
          
          // Also send the message to the room so everyone sees it
          sessionStore.addMessage(roomId, {
            type: 'system',
            content: aiResponse.content
          });
          io.to(roomId).emit('system_message', {
            type: 'system',
            content: aiResponse.content
          });
        } else {
          // Add a slight delay before sending the AI response
          setTimeout(() => {
            console.log(`[Server] Sending AI response to room ${roomId}`);
            sessionStore.addMessage(roomId, aiResponse);
            
            // Check if this is a moderator message (vs a regular system message)
            if (aiResponse.isModerator) {
              // Send as moderator message
              io.to(roomId).emit('system_message', {
                ...aiResponse,
                isModerator: true
              });
            } else {
              // Send as regular system message
              io.to(roomId).emit('system_message', aiResponse);
            }
          }, 2000);
        }
      } else {
        console.log(`[Server] No AI response generated for this message`);
      }
      
    } catch (error) {
      console.error('Error in message handler:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    try {
      if (!participantData) return;
      
      const { roomId, name } = participantData;
      console.log(`Participant ${name} (${socket.id}) left room ${roomId}`);
      
      // Remove from ritual completion tracking
      if (globalRitualParticipants.has(roomId)) {
        globalRitualParticipants.get(roomId).delete(socket.id);
        console.log(`Removed ${socket.id} from ritual completion tracking for room ${roomId}`);
        console.log(`Ritual completed participants for room ${roomId}:`, 
          [...globalRitualParticipants.get(roomId)]);
      }
      
      // Remove from session store
      sessionStore.removeParticipant(socket.id);
      
      // Notify room of the departure
      const departureMessage = {
        type: 'system',
        content: `${name} has left the conversation.`
      };
      
      io.to(roomId).emit('system_message', departureMessage);
      sessionStore.addMessage(roomId, departureMessage);
      
      // Check if room is now empty
      const participants = sessionStore.getRoomParticipants(roomId);
      if (participants.length === 1) {
        // Notify remaining participant they're alone with their name
        const remainingParticipant = participants[0];
        io.to(roomId).emit('system_message', {
          type: 'system',
          content: `You are now alone in this space, ${remainingParticipant.name}. Waiting for another participant to join...`
        });
      }
      
    } catch (error) {
      console.error('Error in disconnect handler:', error);
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Emergent Grounds server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to access the application`);
});
