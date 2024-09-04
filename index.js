const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

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
        online BOOLEAN DEFAULT FALSE
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

io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('set username', (username) => {
        socket.username = username;

        // Save the user to the database and mark as online
        pool.query(
            `INSERT INTO users (username, online) 
             VALUES ($1, TRUE)
             ON CONFLICT (username) DO UPDATE SET online = TRUE`,
            [username],
            (err) => {
                if (err) {
                    console.error('Error saving user:', err);
                    return;
                }

                // Send the users list to all clients
                updateUsersList();
            }
        );

        // Load the user's message history on login
        loadPrivateMessageHistory(username, null, (messages) => {
            socket.emit('chat history', messages);
        });
    });

    socket.on('chat message', ({ to, msg }) => {
        const message = { from: socket.username, msg, to };

        // Save the message to the database
        saveMessage(socket.username, to, msg);

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

    socket.on('disconnect', () => {
        console.log('A user disconnected');
        if (socket.username) {
            // Mark the user as offline
            pool.query(
                `UPDATE users SET online = FALSE WHERE username = $1`,
                [socket.username],
                (err) => {
                    if (err) {
                        console.error('Error marking user offline:', err);
                    } else {
                        updateUsersList();
                    }
                }
            );
        }
    });
});

// Function to save a message to the PostgreSQL database
function saveMessage(sender, receiver, message) {
    pool.query(
        'INSERT INTO messages (sender, receiver, message) VALUES ($1, $2, $3)',
        [sender, receiver, message],
        (err) => {
            if (err) {
                console.error('Error saving message:', err);
            }
        }
    );
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
