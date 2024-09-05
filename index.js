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

// Middleware for session management
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Initialize PostgreSQL pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// Create or update tables if necessary
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT,
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

// Track users and their socket connections
const users = {};  // {username: {socketId: socketId, online: boolean}}

io.on('connection', (socket) => {
    console.log('A user connected');

    // Handle user login with password
    socket.on('login', async ({ username, password }) => {
        try {
            const userQuery = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            const user = userQuery.rows[0];

            if (user) {
                if (!user.password) {
                    // Require password setup for new users without a password
                    socket.emit('require password setup');
                } else {
                    // Check if password matches
                    const match = await bcrypt.compare(password, user.password);
                    if (match) {
                        // Successful login
                        socket.username = username;

                        // Update online status in DB and broadcast users list
                        await pool.query('UPDATE users SET online = TRUE WHERE username = $1', [username]);
                        users[username] = { socketId: socket.id, online: true };

                        // Save session information
                        socket.request.session.username = username;
                        socket.request.session.save();

                        // Update the users list for everyone
                        updateUsersList();
                        
                        // Load and send chat history to the user
                        loadPrivateMessageHistory(username, null, (messages) => {
                            socket.emit('chat history', messages);
                        });
                    } else {
                        socket.emit('login failed', 'Invalid password.');
                    }
                }
            } else {
                socket.emit('login failed', 'User does not exist.');
            }
        } catch (err) {
            console.error('Error during login:', err);
            socket.emit('login failed', 'An error occurred.');
        }
    });

    // Handle new password setup for users without a password
    socket.on('setup password', async ({ username, password }) => {
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashedPassword, username]);
            socket.emit('password setup successful');
        } catch (err) {
            console.error('Error setting up password:', err);
            socket.emit('setup failed', 'Password setup failed.');
        }
    });

    // Handle sending chat messages
    socket.on('chat message', ({ to, msg }) => {
        if (!socket.username) return;

        const message = { from: socket.username, msg, to };
        saveMessage(socket.username, to, msg);

        // Deliver message to the recipient if online
        if (users[to] && users[to].online) {
            io.to(users[to].socketId).emit('chat message', message);
            io.to(users[to].socketId).emit('new message notification', { from: socket.username, msg });
        }

        // Echo message back to the sender
        socket.emit('chat message', message);
    });

    // Load messages between two users
    socket.on('load messages', ({ user }) => {
        if (socket.username) {
            loadPrivateMessageHistory(socket.username, user, (messages) => {
                socket.emit('chat history', messages);
            });
        }
    });

    // Handle user disconnecting
    socket.on('disconnect', () => {
        if (socket.username) {
            pool.query(
                'UPDATE users SET online = FALSE WHERE username = $1',
                [socket.username],
                (err) => {
                    if (err) {
                        console.error('Error marking user offline:', err);
                    } else {
                        // Update user's online status
                        users[socket.username].online = false;
                        updateUsersList();
                    }
                }
            );
        }
        console.log('A user disconnected');
    });
});

// Save messages to the PostgreSQL database
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

// Load private message history between two users
function loadPrivateMessageHistory(user1, user2, callback) {
    let query, params;
    if (user2) {
        // Load conversation between user1 and user2
        query = `
            SELECT sender, receiver, message, timestamp
            FROM messages
            WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
            ORDER BY timestamp ASC
        `;
        params = [user1, user2];
    } else {
        // Load all messages involving user1
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

// Update users list and notify all connected clients
function updateUsersList() {
    pool.query(
        'SELECT username, online FROM users',
        (err, result) => {
            if (err) {
                console.error('Error fetching users list:', err);
                return;
            }

            const userList = result.rows.map(row => ({
                username: row.username,
                online: row.online,
            }));

            io.emit('users list', userList);  // Broadcast users list to all clients
        }
    );
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
