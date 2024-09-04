const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'your-session-secret', // Replace with a strong secret
    resave: false,
    saveUninitialized: true,
}));

// Initialize PostgreSQL pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Set this in your Render environment variables
    ssl: {
        rejectUnauthorized: false,
    },
});

// Create tables if they don't exist
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        online BOOLEAN DEFAULT FALSE,
        socket_id TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender TEXT,
        receiver TEXT,
        message TEXT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
`, (err) => {
    if (err) {
        console.error('Error creating tables:', err);
    } else {
        console.log('Tables created or verified successfully.');
    }
});

const users = {};  // {username: {socketId: socketId, online: boolean}}

// Handle WebSocket connections
io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('set username', async ({ username, password }) => {
        try {
            const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            if (result.rows.length === 0) {
                socket.emit('login error', 'User does not exist');
                return;
            }
            
            const user = result.rows[0];
            const match = await bcrypt.compare(password, user.password);
            if (!match) {
                socket.emit('login error', 'Incorrect password');
                return;
            }

            // Check if user is already connected from another device
            if (user.socket_id && user.socket_id !== socket.id) {
                socket.emit('login error', 'User already logged in from another device');
                return;
            }

            // Save the user to the database and mark as online
            await pool.query(
                `UPDATE users SET online = TRUE, socket_id = $1 WHERE username = $2`,
                [socket.id, username]
            );

            users[username] = { socketId: socket.id, online: true };
            socket.username = username;

            // Send the users list to all clients
            updateUsersList();

            // Load the user's message history on login
            loadPrivateMessageHistory(username, null, (messages) => {
                socket.emit('chat history', messages);
            });
        } catch (err) {
            console.error('Error during login:', err);
            socket.emit('login error', 'An error occurred');
        }
    });

    socket.on('chat message', async ({ to, msg }) => {
        const message = { from: socket.username, msg, to };

        // Save the message to the database
        await saveMessage(socket.username, to, msg);

        // Notify the recipient if they are online
        if (users[to] && users[to].online) {
            io.to(users[to].socketId).emit('chat message', message);
            io.to(users[to].socketId).emit('new message notification', { from: socket.username, msg });
        }

        // Also send the message back to the sender
        socket.emit('chat message', message);
    });

    socket.on('load messages', ({ user }) => {
        loadPrivateMessageHistory(socket.username, user, (messages) => {
            socket.emit('chat history', messages);
        });
    });

    socket.on('disconnect', async () => {
        console.log('A user disconnected');
        if (socket.username) {
            // Mark the user as offline and remove the socket_id
            await pool.query(
                `UPDATE users SET online = FALSE, socket_id = NULL WHERE username = $1`,
                [socket.username]
            );

            delete users[socket.username];
            updateUsersList();
        }
    });
});

// Function to save a message to the PostgreSQL database
async function saveMessage(sender, receiver, message) {
    try {
        await pool.query(
            'INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)',
            [sender, receiver, message]
        );
    } catch (err) {
        console.error('Error saving message:', err);
    }
}

// Function to load private message history between two users
function loadPrivateMessageHistory(user1, user2, callback) {
    let query;
    let params;

    if (user2) {
        // Load messages between two users
        query = `
            SELECT sender, receiver, message, timestamp
            FROM messages
            WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
            ORDER BY timestamp ASC
        `;
        params = [user1, user2];
    } else {
        // Load all messages involving the user
        query = `
            SELECT sender, receiver, message, timestamp
            FROM messages
            WHERE sender = $1 OR receiver = $1
            ORDER BY timestamp ASC
        `;
        params = [user1];
    }

    pool.query(query, params, (err, result) => {
        if (err) {
            console.error('Error loading message history:', err);
            return;
        }
        const messages = result.rows.map(row => ({
            from: row.sender,
            to: row.receiver,
            msg: row.message,
            timestamp: row.timestamp,
        }));
        callback(messages);
    });
}

// Function to update the users list
function updateUsersList() {
    pool.query(
        `SELECT username, online FROM users`,
        (err, result) => {
            if (err) {
                console.error('Error fetching users list:', err);
                return;
            }

            const users = result.rows.map(row => ({
                username: row.username,
                online: row.online,
            }));

            io.emit('users list', users);
        }
    );
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
