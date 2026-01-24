const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET all suppliers
router.get('/', async (req, res) => {
  try {
    const [suppliers] = await pool.query('SELECT * FROM suppliers ORDER BY name');
    res.json(suppliers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE supplier
router.post('/', async (req, res) => {
  try {
    const { name, contact, phone, email, address } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!contact) return res.status(400).json({ error: 'Contact is required' });

    const [result] = await pool.query(
      'INSERT INTO suppliers (name, contact, phone, email, address) VALUES (?, ?, ?, ?, ?)',
      [name, contact, phone || '', email || '', address || '']
    );

    res.json({
      id: result.insertId,
      name,
      contact,
      phone,
      email,
      address
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE supplier
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM suppliers WHERE id = ?', [id]);
    res.json({ message: 'deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
