 const socket = io();
        const form = document.getElementById('form');
        const input = document.getElementById('input');
        const messages = document.getElementById('messages');
        const usersList = document.getElementById('users-list');
        const loginScreen = document.getElementById('login-screen');
        const loginButton = document.getElementById('login-button');
        const usernameInput = document.getElementById('username-input');
        const passwordInput = document.getElementById('password-input');
        let currentUser = null;
        let currentConversation = null;
        let unseenMessages = {};
    
        // Check if user is already logged in via localStorage
        document.addEventListener('DOMContentLoaded', () => {
            const savedUsername = localStorage.getItem('username');
            const savedPassword = localStorage.getItem('password');
            if (savedUsername && savedPassword) {
                // Auto-login using saved credentials
                socket.emit('login', { username: savedUsername, password: savedPassword });
            }
        });
    
        // Play sound for new message
        function playBeep() {
            const beepSound = document.getElementById('beep-sound');
            beepSound.play();
        }
    
        // Show notification for messages
        function showNotification(title, body) {
            if (Notification.permission === 'granted') {
                new Notification(title, {
                    body: body,
                    icon: '/path/to/icon.png' // Optional: Add an icon
                });
            }
        }
    
        // Handle login or signup
        loginButton.addEventListener('click', () => {
            const username = usernameInput.value.trim();
            const password = passwordInput.value.trim();
            if (username && password) {
                // Store login info in localStorage for future use
                localStorage.setItem('username', username);
                localStorage.setItem('password', password);
                socket.emit('login', { username, password });
            } else {
                alert('Please enter both username and password.');
            }
        });
    
        // If login is successful, hide login screen
        socket.on('login success', (username) => {
            currentUser = username;
            loginScreen.style.display = 'none';
            socket.emit('load users');
        });
    
        // Prompt for signup if user is not found or password is missing
        socket.on('prompt signup', (message) => {
            const confirmed = confirm(message);
            if (confirmed) {
                const username = usernameInput.value.trim();
                const password = passwordInput.value.trim();
                if (username && password) {
                    socket.emit('signup', { username, password });
                } else {
                    alert('Please enter both username and password.');
                }
            }
        });
    
        // Handle successful signup
        socket.on('signup successful', (username) => {
            alert('Signup successful! You are now logged in.');
            currentUser = username;
            loginScreen.style.display = 'none';
            socket.emit('load users');
        });
    
        // If login fails (invalid password or other issue)
        socket.on('login failed', (message) => {
            alert(message);
        });
    
        // Handle signup failure
        socket.on('signup failed', (message) => {
            alert(message);
        });
    
        // Handle password setup response
        socket.on('password setup successful', () => {
            alert('Password setup successful! You are now logged in.');
            loginScreen.style.display = 'none';
            socket.emit('load users');
        });
    
        socket.on('setup failed', (message) => {
            alert(message);
        });
    
        // Display messages in the chat window
       function displayMessage({ from, msg, timestamp }) {
    const item = document.createElement('li');
    item.className = from === currentUser ? 'message-from-me' : 'message-from-others';
    item.textContent = `${from}: ${msg} (${timestamp})`; // Append the timestamp here
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;  // Scroll to the bottom
}
    
        // Update the conversation view when switching between users
        function updateConversation(conversation) {
            currentConversation = conversation;
            document.getElementById('chat-header').textContent = `Chat with ${conversation}`;
            document.querySelectorAll('#users-list li').forEach(li => li.classList.remove('selected'));
            const item = Array.from(usersList.children).find(li => li.textContent.trim() === conversation);
            if (item) {
                item.classList.add('selected');
            }
            messages.innerHTML = ''; // Clear previous messages before loading new ones
            socket.emit('load messages', { user: currentConversation });
        }
    
        // Handle receiving new chat messages
        socket.on('chat message', (data) => {
            displayMessage(data);
            if (data.from !== currentUser) {
                playBeep();
                showNotification(data.from, data.msg); // Show notification for new messages
                unseenMessages[data.from] = (unseenMessages[data.from] || 0) + 1;
                const userItem = Array.from(usersList.children).find(li => li.textContent.trim().startsWith(data.from));
                if (userItem) {
                    let count = userItem.querySelector('.unseen-count');
                    if (!count) {
                        count = document.createElement('span');
                        count.className = 'unseen-count';
                        userItem.appendChild(count);
                    }
                    count.textContent = unseenMessages[data.from];
                }
            }
        });
    
        // Handle loading chat history for the user
        socket.on('chat history', (messages) => {
            messages.forEach(displayMessage);
        });
    
        // Update users list and hide the current user from it
        socket.on('users', (users) => {
            usersList.innerHTML = ''; // Clear existing list
            users.filter(user => user.username !== currentUser).forEach(user => {
                const item = document.createElement('li');
                item.textContent = `${user.username}`;
                if (user.online) {
                    item.innerHTML = `<span class="online-status online"></span> ${item.textContent}`;
                } else {
                    item.innerHTML = `<span class="online-status offline"></span> ${item.textContent}`;
                }
                item.addEventListener('click', () => updateConversation(user.username));
                usersList.appendChild(item);
            });
        });
    
        // Handle sending new chat messages
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (input.value && currentConversation) {
                socket.emit('chat message', { to: currentConversation, msg: input.value });
                input.value = '';
            }
        });
    
        // Handle user logout
        socket.on('disconnect', () => {
            currentUser = null;
            loginScreen.style.display = 'block';
        });