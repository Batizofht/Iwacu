const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    const [users] = await pool.query(
      'SELECT * FROM users WHERE username = ? AND status = ?',
      [username, 'active']
    );

    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const user = users[0];
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Update last login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    // Return user data (without password)
    const { password: _, ...userData } = user;
    userData.permissions = typeof userData.permissions === 'string' 
      ? JSON.parse(userData.permissions) 
      : userData.permissions;

    res.json({ success: true, data: userData });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current user (verify session)
router.get('/me', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const [users] = await pool.query(
      'SELECT id, username, full_name, role, permissions, avatar_color, status, last_login, created_at FROM users WHERE id = ? AND status = ?',
      [userId, 'active']
    );

    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const user = users[0];
    user.permissions = typeof user.permissions === 'string' 
      ? JSON.parse(user.permissions) 
      : user.permissions;

    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all users (superadmin only)
router.get('/users', async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, username, full_name, role, permissions, avatar_color, status, last_login, created_at FROM users ORDER BY created_at DESC'
    );

    const parsedUsers = users.map(user => ({
      ...user,
      permissions: typeof user.permissions === 'string' 
        ? JSON.parse(user.permissions) 
        : user.permissions
    }));

    res.json({ success: true, data: parsedUsers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create user (superadmin only)
router.post('/users', async (req, res) => {
  try {
    const { username, password, full_name, role, permissions, avatar_color } = req.body;

    if (!username || !password || !full_name) {
      return res.status(400).json({ success: false, error: 'Username, password, and full name are required' });
    }

    // Check if username exists
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const defaultPermissions = {
      dashboard: true,
      quickSell: true,
      stock: true,
      sales: true,
      purchases: true,
      items: true,
      categories: true,
      debts: false,
      expenses: false,
      reports: false,
      aiSummary: false,
      userManagement: false,
      help: true
    };

    const [result] = await pool.query(
      'INSERT INTO users (username, password, full_name, role, permissions, avatar_color) VALUES (?, ?, ?, ?, ?, ?)',
      [
        username,
        hashedPassword,
        full_name,
        role || 'staff',
        JSON.stringify(permissions || defaultPermissions),
        avatar_color || '#10b981'
      ]
    );

    res.json({
      success: true,
      data: {
        id: result.insertId,
        username,
        full_name,
        role: role || 'staff',
        permissions: permissions || defaultPermissions,
        avatar_color: avatar_color || '#10b981',
        status: 'active'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update user
router.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password, full_name, role, permissions, avatar_color, status } = req.body;

    // Check if user exists
    const [existing] = await pool.query('SELECT id FROM users WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Check username uniqueness if changing
    if (username) {
      const [usernameCheck] = await pool.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, id]);
      if (usernameCheck.length > 0) {
        return res.status(400).json({ success: false, error: 'Username already exists' });
      }
    }

    let updateQuery = 'UPDATE users SET ';
    const updateValues = [];
    const updates = [];

    if (username) { updates.push('username = ?'); updateValues.push(username); }
    if (password) { 
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push('password = ?'); 
      updateValues.push(hashedPassword); 
    }
    if (full_name) { updates.push('full_name = ?'); updateValues.push(full_name); }
    if (role) { updates.push('role = ?'); updateValues.push(role); }
    if (permissions) { updates.push('permissions = ?'); updateValues.push(JSON.stringify(permissions)); }
    if (avatar_color) { updates.push('avatar_color = ?'); updateValues.push(avatar_color); }
    if (status) { updates.push('status = ?'); updateValues.push(status); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    updateQuery += updates.join(', ') + ' WHERE id = ?';
    updateValues.push(id);

    await pool.query(updateQuery, updateValues);

    // Get updated user
    const [users] = await pool.query(
      'SELECT id, username, full_name, role, permissions, avatar_color, status, last_login, created_at FROM users WHERE id = ?',
      [id]
    );

    const user = users[0];
    user.permissions = typeof user.permissions === 'string' 
      ? JSON.parse(user.permissions) 
      : user.permissions;

    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent deleting the last superadmin
    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'superadmin' AND status = 'active'");
    const [userToDelete] = await pool.query('SELECT role FROM users WHERE id = ?', [id]);
    
    if (userToDelete.length > 0 && userToDelete[0].role === 'superadmin' && admins.length <= 1) {
      return res.status(400).json({ success: false, error: 'Cannot delete the last superadmin' });
    }

    await pool.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Change password
router.post('/change-password', async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;

    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = users[0];
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
