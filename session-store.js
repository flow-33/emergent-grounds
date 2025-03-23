/**
 * session-store.js
 * Manages in-memory sessions for Emergent Grounds conversations
 */

// Poetic name pairs for participants
const POETIC_NAMES = [
  ['Curious Fox', 'Listening Brook'],
  ['Gentle Wind', 'Patient Oak'],
  ['Quiet River', 'Thoughtful Mountain'],
  ['Wandering Cloud', 'Steady Earth'],
  ['Morning Light', 'Evening Shadow'],
  ['Flowing Stream', 'Standing Stone'],
  ['Dancing Leaf', 'Rooted Tree'],
  ['Rising Tide', 'Distant Shore'],
  ['Whispering Reed', 'Silent Lake'],
  ['Soaring Hawk', 'Watching Deer']
];

class SessionStore {
  constructor() {
    // Map of roomId -> room data
    this.rooms = new Map();
    // Map of socketId -> { roomId, name }
    this.participants = new Map();
  }

  /**
   * Create a new room or join an existing one with available space
   * @returns {Object} Room data including roomId and assigned name
   */
  joinOrCreateRoom(socketId) {
    // Find an existing room with only one participant
    let availableRoom = null;
    let availableRoomId = null;

    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.size === 1) {
        availableRoom = room;
        availableRoomId = roomId;
        break;
      }
    }

    // If no available room, create a new one
    if (!availableRoom) {
      const roomId = this._generateRoomId();
      const namePair = this._getRandomNamePair();
      
      this.rooms.set(roomId, {
        participants: new Set([socketId]),
        messages: [],
        createdAt: new Date(),
        namePair
      });

      // Assign first name from pair
      this.participants.set(socketId, {
        roomId,
        name: namePair[0]
      });

      return {
        roomId,
        name: namePair[0],
        isNewRoom: true
      };
    }

    // Join existing room
    const namePair = availableRoom.namePair;
    const existingParticipantName = [...availableRoom.participants].map(
      id => this.participants.get(id).name
    )[0];
    
    // Determine which name to assign (the one not taken)
    const assignedName = namePair[0] === existingParticipantName ? namePair[1] : namePair[0];
    
    // Add to room
    availableRoom.participants.add(socketId);
    
    // Register participant
    this.participants.set(socketId, {
      roomId: availableRoomId,
      name: assignedName
    });

    return {
      roomId: availableRoomId,
      name: assignedName,
      isNewRoom: false
    };
  }

  /**
   * Add a message to the room's history
   */
  addMessage(roomId, message) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.messages.push({
        ...message,
        timestamp: new Date()
      });
      return true;
    }
    return false;
  }

  /**
   * Get all messages for a room
   */
  getMessages(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.messages : [];
  }

  /**
   * Get participant info by socket ID
   */
  getParticipant(socketId) {
    return this.participants.get(socketId);
  }

  /**
   * Get room data by room ID
   */
  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  /**
   * Remove a participant from their room
   */
  removeParticipant(socketId) {
    const participant = this.participants.get(socketId);
    if (!participant) return null;

    const { roomId } = participant;
    const room = this.rooms.get(roomId);
    
    if (room) {
      room.participants.delete(socketId);
      
      // If room is empty, remove it
      if (room.participants.size === 0) {
        this.rooms.delete(roomId);
      }
    }
    
    this.participants.delete(socketId);
    return participant;
  }

  /**
   * Get all participants in a room
   */
  getRoomParticipants(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    
    return [...room.participants].map(socketId => ({
      socketId,
      ...this.participants.get(socketId)
    }));
  }

  /**
   * Generate a random room ID
   * @private
   */
  _generateRoomId() {
    return Math.random().toString(36).substring(2, 10);
  }

  /**
   * Get a random pair of poetic names
   * @private
   */
  _getRandomNamePair() {
    const index = Math.floor(Math.random() * POETIC_NAMES.length);
    return POETIC_NAMES[index];
  }
}

module.exports = new SessionStore();
