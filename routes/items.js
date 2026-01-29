const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET all items
router.get('/', async (req, res) => {
  try {
    const [items] = await pool.query(`
      SELECT 
        i.*,
        c.name AS category_name,
        s.current_stock AS stock_quantity
      FROM items i
      LEFT JOIN categories c ON i.category_id = c.id
      LEFT JOIN stock s ON i.id = s.item_id
    `);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET categories for items
router.get('/categories', async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT * FROM categories');
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE item
router.post('/', async (req, res) => {
  try {
    const { name, sku, status = 'active', category, price, cost, minStock = 5, description, stock = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (price === undefined) return res.status(400).json({ error: 'Price is required' });
    if (cost === undefined) return res.status(400).json({ error: 'Cost is required' });

    const [existingName] = await pool.query(
      'SELECT id FROM items WHERE LOWER(name) = LOWER(?) LIMIT 1',
      [String(name).trim()]
    );
    if (existingName.length > 0) {
      return res.status(400).json({ error: 'Item name already exists' });
    }

    const [result] = await pool.query(
      'INSERT INTO items (name, sku, status, category_id, price, cost, min_stock, description, stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, sku || '', status, category || null, price, cost, minStock, description || '', stock]
    );

    res.json({
      id: result.insertId,
      name,
      sku,
      status,
      category,
      price,
      cost,
      min_stock: minStock,
      description,
      stock
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE item
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, status = 'active', category, price, cost, minStock = 5, stock = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (price === undefined) return res.status(400).json({ error: 'Price is required' });
    if (cost === undefined) return res.status(400).json({ error: 'Cost is required' });

    const [existingName] = await pool.query(
      'SELECT id FROM items WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1',
      [String(name).trim(), id]
    );
    if (existingName.length > 0) {
      return res.status(400).json({ error: 'Item name already exists' });
    }

    if (category) {
      await pool.query(
        'UPDATE items SET name = ?, category_id = ?, status = ?, price = ?, cost = ?, min_stock = ?, stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [name, category, status, price, cost, minStock, stock, id]
      );
    } else {
      await pool.query(
        'UPDATE items SET name = ?, status = ?, price = ?, cost = ?, min_stock = ?, stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [name, status, price, cost, minStock, stock, id]
      );
    }

    res.json({ message: 'Updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE item
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM items WHERE id = ?', [id]);
    res.json({ message: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
