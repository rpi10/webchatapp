const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const uri = 'YOUR_MONGODB_CONNECTION_STRING';  // Replace with your MongoDB connection string
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

let db;

(async () => {
  try {
    await client.connect();
    db = client.db('webchatapp');
    await db.createCollection('messages');
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
  }
})();

app.use(express.static(path.join(__dirname, 'public')));

const users = {};  // {username: {socketId: socketId, online: boolean}}

io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('set username', (username) => {
    users[username] = { socketId: socket.id, online: true };
    socket.username = username;
    
    io.emit('users list', Object.keys(users).map(user => ({
      username: user,
      online: users[user].online
    })));
  });

  socket.on('chat message', async ({ to, msg }) => {
    const message = { from: socket.username, msg, to, timestamp: new Date() };

    // Save the message to MongoDB
    await db.collection('messages').insertOne(message);

    // Send the message to the recipient if they are online
    if (users[to] && users[to].online) {
      io.to(users[to].socketId).emit('chat message', message);
    }

    // Also send the message back to the sender
    socket.emit('chat message', message);
  });

  socket.on('load messages', async ({ user }) => {
    const messages = await db.collection('messages').find({
      $or: [
        { from: socket.username, to: user },
        { from: user, to: socket.username }
      ]
    }).sort({ timestamp: 1 }).toArray();

    socket.emit('chat history', messages);
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected');
    if (socket.username) {
      users[socket.username].online = false;
      io.emit('users list', Object.keys(users).map(user => ({
        username: user,
        online: users[user].online
      })));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
