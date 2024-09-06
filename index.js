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

    // Handle user login with password or signup
    socket.on('login', async ({ username, password }) => {
        try {
            const userQuery = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            const user = userQuery.rows[0];

            if (user) {
                // Check if password is set
                if (!user.password) {
                    // Send prompt to user to set up a password
                    socket.emit('require sign up', username);
                } else {
                    // Check password match for existing user
                    const match = await bcrypt.compare(password, user.password);
                    if (match) {
                        // Successful login
                        socket.username = username;

                        // Update user online status in the database
                        await pool.query('UPDATE users SET online = TRUE WHERE username = $1', [username]);
                        users[username] = { socketId: socket.id, online: true };

                        // Save session information
                        socket.request.session.username = username;
                        socket.request.session.save();

                        // Update users list for all clients
                        updateUsersList();

                        // Send chat history to the user
                        loadPrivateMessageHistory(username, null, (messages) => {
                            socket.emit('chat history', messages);
                        });

                        socket.emit('login success', username);
                    } else {
                        // Password mismatch
                        socket.emit('login failed', 'Invalid password.');
                    }
                }
            } else {
                // User not found, prompt for sign up
                socket.emit('require sign up', username);
            }
        } catch (err) {
            console.error('Error during login:', err);
            socket.emit('login failed', 'An error occurred.');
        }
    });

    // Handle user signup process
    socket.on('signup', async ({ username, password }) => {
        try {
            // Check if user already exists
            const userQuery = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            const user = userQuery.rows[0];

            if (!user) {
                // Hash password and insert new user into the database
                const hashedPassword = await bcrypt.hash(password, 10);
                await pool.query('INSERT INTO users (username, password, online) VALUES ($1, $2, TRUE)', [username, hashedPassword]);

                socket.username = username;
                users[username] = { socketId: socket.id, online: true };

                // Save session information
                socket.request.session.username = username;
                socket.request.session.save();

                // Update the users list for all clients
                updateUsersList();

                socket.emit('signup successful', username);
            } else {
                socket.emit('signup failed', 'Username is already taken.');
            }
        } catch (err) {
            console.error('Error during signup:', err);
            socket.emit('signup failed', 'An error occurred.');
        }
    });

    // Handle sending chat messages
    socket.on('chat message', ({ to, msg }) => {
        if (!socket.username) return;

        const message = { from: socket.username, msg, to };
        saveMessage(socket.username, to, msg);

        // Send message to the recipient if they are online
        if (users[to] && users[to].online) {
            io.to(users[to].socketId).emit('chat message', message);
            io.to(users[to].socketId).emit('new message notification', { from: socket.username, msg });
        }

        // Send the message back to the sender as well
        socket.emit('chat message', message);
    });

    // Load messages between the current user and another user
    socket.on('load messages', ({ user }) => {
        if (socket.username) {
            loadPrivateMessageHistory(socket.username, user, (messages) => {
                socket.emit('chat history', messages);
            });
        }
    });

    // Handle user disconnect
    socket.on('disconnect', () => {
        if (socket.username) {
            pool.query('UPDATE users SET online = FALSE WHERE username = $1', [socket.username], (err) => {
                if (err) {
                    console.error('Error marking user offline:', err);
                } else {
                    // Update the user's online status and broadcast the updated users list
                    users[socket.username].online = false;
                    updateUsersList();
                }
            });
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
        // Load conversation between two users
        query = `
            SELECT sender, receiver, message, timestamp
            FROM messages
            WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
            ORDER BY timestamp ASC
        `;
        params = [user1, user2];
    } else {
        // Load all messages for a single user
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

// Update the users list and notify all connected clients
function updateUsersList() {
    pool.query('SELECT username, online FROM users', (err, result) => {
        if (err) {
            console.error('Error fetching users list:', err);
            return;
        }

        const userList = result.rows.map(row => ({
            username: row.username,
            online: row.online,
        }));

        io.emit('users', userList);  // Broadcast the users list to all clients
    });
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
