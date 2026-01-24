const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET all clients
router.get('/', async (req, res) => {
  try {
    const [clients] = await pool.query('SELECT * FROM clients ORDER BY name');
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE client
router.post('/', async (req, res) => {
  try {
    const { name, phone = '', contact = '', email = '', address = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const [result] = await pool.query(
      'INSERT INTO clients (name, phone, contact, email, address) VALUES (?, ?, ?, ?, ?)',
      [name, phone, contact, email, address]
    );

    res.json({
      id: result.insertId,
      name,
      phone,
      contact,
      email,
      address
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE client
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone = '', contact = '', email = '', address = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    await pool.query(
      'UPDATE clients SET name = ?, phone = ?, contact = ?, email = ?, address = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, phone, contact, email, address, id]
    );

    res.json({
      id,
      name,
      phone,
      contact,
      email,
      address
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE client
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM clients WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
