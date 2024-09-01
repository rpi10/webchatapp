const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database
const db = new sqlite3.Database(':memory:');  // Use ':memory:' for an in-memory database, or specify a file path for persistent storage

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

const users = {};  // {username: {socketId: socketId, online: boolean}}

io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('set username', (username) => {
        users[username] = { socketId: socket.id, online: true };
        socket.username = username;
        
        // Send the users list to all clients
        io.emit('users list', Object.keys(users).map(user => ({
            username: user,
            online: users[user].online
        })));
        
        // Load the user's message history on login
        loadMessageHistory(username, (messages) => {
            socket.emit('chat history', messages);
        });
    });

    socket.on('chat message', ({ to, msg }) => {
        const message = { from: socket.username, msg, to };

        // Save the message to the database
        saveMessage(socket.username, to, msg);

        // Send the message to the recipient if they are online
        if (users[to] && users[to].online) {
            io.to(users[to].socketId).emit('chat message', message);
        }

        // Also send the message back to the sender
        socket.emit('chat message', message);
    });

    socket.on('load messages', ({ user }) => {
        loadMessageHistory(user, (messages) => {
            socket.emit('chat history', messages);
        });
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

// Function to save a message to the SQLite database
function saveMessage(sender, receiver, message) {
    db.run("INSERT INTO messages (sender, receiver, message) VALUES (?, ?, ?)", [sender, receiver, message]);
}

// Function to load message history between two users
function loadMessageHistory(user, callback) {
    db.all("SELECT sender, receiver, message, timestamp FROM messages WHERE sender = ? OR receiver = ? ORDER BY timestamp ASC", [user, user], (err, rows) => {
        if (err) {
            console.error(err);
            return;
        }
        const messages = rows.map(row => ({
            from: row.sender,
            to: row.receiver,
            msg: row.message,
            timestamp: row.timestamp
        }));
        callback(messages);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
