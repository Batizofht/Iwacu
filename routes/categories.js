const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET all categories
router.get('/', async (req, res) => {
  try {
    const [categories] = await pool.query(`
      SELECT 
        c.*,
        COUNT(i.id) AS total_items
      FROM categories c
      LEFT JOIN items i ON i.category_id = c.id
      GROUP BY c.id
      ORDER BY c.id DESC
    `);
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE category
router.post('/', async (req, res) => {
  try {
    const { name, description, status = 'active' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const [result] = await pool.query(
      'INSERT INTO categories (name, description, status) VALUES (?, ?, ?)',
      [name, description || '', status]
    );

    res.json({
      id: result.insertId,
      name,
      description,
      status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE category
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, status = 'active' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    await pool.query(
      'UPDATE categories SET name = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, description || '', status, id]
    );

    res.json({ message: 'Updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE category
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM categories WHERE id = ?', [id]);
    res.json({ message: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
