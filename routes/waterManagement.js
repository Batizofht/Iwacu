const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { logActivity } = require('../utils/activityLogger');

// Auto-migrate: Add required columns and consolidate to quantity-based
(async () => {
  try {
    await pool.query(`ALTER TABLE water_additions ADD COLUMN IF NOT EXISTS bottle_price DECIMAL(10, 2) DEFAULT 0`);
    await pool.query(`ALTER TABLE water_additions ADD COLUMN IF NOT EXISTS status ENUM('filled', 'empty') DEFAULT 'filled'`);
    
    // Add quantity column to water_jerrycans if it doesn't exist
    await pool.query(`ALTER TABLE water_jerrycans ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1`);
    
    // Check if we need to consolidate (if there are many rows with quantity=1)
    const [checkRows] = await pool.query(`SELECT COUNT(*) as cnt FROM water_jerrycans WHERE quantity = 1`);
    const rowCount = checkRows[0]?.cnt || 0;
    
    if (rowCount > 50) {
      console.log('🔄 Consolidating water_jerrycans rows...');
      // Consolidate rows by water_name, capacity, status
      await pool.query(`
        CREATE TEMPORARY TABLE IF NOT EXISTS temp_consolidated AS
        SELECT 
          COALESCE(water_name, 'Water') as water_name,
          capacity,
          status,
          MAX(selling_price) as selling_price,
          MAX(COALESCE(bottle_price, 0)) as bottle_price,
          MAX(COALESCE(bottle_health, 'good')) as bottle_health,
          SUM(COALESCE(quantity, 1)) as quantity,
          MAX(created_at) as created_at
        FROM water_jerrycans
        GROUP BY water_name, capacity, status
      `);
      
      await pool.query(`DELETE FROM water_jerrycans`);
      
      await pool.query(`
        INSERT INTO water_jerrycans (water_name, capacity, status, selling_price, bottle_price, bottle_health, quantity, serial_number, created_at)
        SELECT 
          water_name, capacity, status, selling_price, bottle_price, bottle_health, quantity,
          CONCAT('STOCK-', REPLACE(water_name, ' ', '-'), '-', capacity, 'L-', status),
          created_at
        FROM temp_consolidated
      `);
      
      await pool.query(`DROP TEMPORARY TABLE IF EXISTS temp_consolidated`);
      console.log('✅ Consolidated water_jerrycans rows');
    }
    
    console.log('✅ Water management tables ready');
  } catch (err) {
    console.log('Water management migration:', err.message);
  }
})();

// GET available water stats
router.get('/available-water', async (req, res) => {
  try {
    const [filledResult] = await pool.query(
      'SELECT SUM(COALESCE(quantity, 1)) as count, SUM(capacity * COALESCE(quantity, 1)) as totalLiters FROM water_jerrycans WHERE status = "filled"'
    );
    
    const filledCount = filledResult[0].count || 0;
    const availableLiters = filledResult[0].totalLiters || 0;
    
    res.json({
      success: true,
      data: {
        totalLiters: availableLiters,
        totalJerrycans: filledCount,
        filledJerrycans: filledCount
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET available products (water_name + capacity with filled stock) for selling
router.get('/available-products', async (req, res) => {
  try {
    // Get available jerrycans grouped by water_name and capacity, include MAX bottle_price
    const [rows] = await pool.query(`
      SELECT COALESCE(j.water_name, 'Water') as water_name, 
             j.capacity, 
             MAX(j.selling_price) as selling_price, 
             MAX(COALESCE(j.bottle_price, 0)) as bottle_price,
             SUM(COALESCE(j.quantity, 1)) as available
      FROM water_jerrycans j
      WHERE j.status = 'filled'
      GROUP BY j.water_name, j.capacity
      HAVING available > 0
      ORDER BY j.water_name, j.capacity
    `);

    const products = rows.map((r) => ({
      water_name: r.water_name,
      capacity: r.capacity || 20,
      selling_price: parseFloat(r.selling_price) || 0,
      bottle_price: parseFloat(r.bottle_price) || 0,
      available: r.available,
      label: `${(r.water_name || 'Water').toUpperCase()} ${r.capacity || 20} LITRES`
    }));
    
    res.json({ success: true, data: products });
  } catch (error) {
    console.error('Error in available-products:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET water sales with filtering
router.get('/sales', async (req, res) => {
  try {
    const { period, start_date, end_date } = req.query;
    let dateFilter = '';
    
    if (period === 'today') {
      dateFilter = 'DATE(created_at) = CURDATE()';
    } else if (period === 'yesterday') {
      dateFilter = 'DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
    } else if (period === 'this_week') {
      dateFilter = 'DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    } else if (period === 'this_month') {
      dateFilter = 'MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())';
    } else if (start_date && end_date) {
      dateFilter = 'DATE(created_at) BETWEEN ? AND ?';
    }
    
    let query = 'SELECT * FROM water_sales';
    let params = [];
    
    if (dateFilter) {
      query += ' WHERE ' + dateFilter;
      if (start_date && end_date) {
        params = [start_date, end_date];
      }
    }
    
    query += ' ORDER BY created_at DESC';
    
    const [sales] = await pool.query(query, params);
    
    // Calculate summary
    const totalSales = sales.reduce((sum, sale) => sum + (sale.jerrycans_sold * 20), 0);
    const totalRevenue = sales.reduce((sum, sale) => sum + parseFloat(sale.total_amount || 0), 0);
    const salesCount = sales.length;
    
    // We need to fetch total costs (investments) for the same period to calculate accurate profit
    let additionsQuery = 'SELECT SUM(total_buying_cost) as totalCost FROM water_additions';
    let additionsParams = [];
    if (dateFilter) {
      additionsQuery += ' WHERE ' + dateFilter;
      if (start_date && end_date) {
        additionsParams = [start_date, end_date];
      }
    }
    const [costResult] = await pool.query(additionsQuery, additionsParams);
    const totalCost = parseFloat(costResult[0].totalCost || 0);
    const netProfit = totalRevenue - totalCost;

    const summary = {
      totalLiters: totalSales,
      totalRevenue,
      totalProfit: netProfit, // Using Net Profit (Revenue - Investment) as requested
      salesCount,
      totalCost,
      netProfit
    };
    
    res.json({
      success: true,
      data: {
        sales,
        summary
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE water sale (with optional water_name + capacity for product-based selling)
router.post('/sales', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { jerrycans_sold, price_per_jerrycan, customer_name, payment_method, notes, water_name, capacity, customer_brings_bottle, includes_bottle } = req.body;

    if (!jerrycans_sold || !price_per_jerrycan) {
      return res.status(400).json({ error: 'Jerrycans sold and price per jerrycan are required' });
    }

    const total_amount = jerrycans_sold * price_per_jerrycan;
    const profit = 0; // Set to 0 as we calculate profit globally (Revenue - Investment)
    const custName = customer_name && String(customer_name).trim() ? String(customer_name).trim() : 'Client';
    const wName = water_name && String(water_name).trim() ? String(water_name).trim() : null;
    const cap = capacity != null ? parseInt(capacity, 10) : null;
    const customerBringsBottle = customer_brings_bottle === true;
    const includesBottle = includes_bottle === true;

    // Find filled stock for this product (quantity-based)
    const [stockRows] = await pool.query(
      'SELECT id, COALESCE(quantity, 1) as quantity FROM water_jerrycans WHERE status = ? AND water_name = ? AND capacity = ? LIMIT 1',
      ['filled', wName || 'Water', cap || 20]
    );
    
    if (stockRows.length === 0 || stockRows[0].quantity < jerrycans_sold) {
      const available = stockRows.length > 0 ? stockRows[0].quantity : 0;
      return res.status(400).json({ error: `Amacupa ahari ni ${available} gusa` });
    }

    const stockId = stockRows[0].id;
    const currentQty = stockRows[0].quantity;

    // Create sale record with bottle tracking information
    const [result] = await pool.query(
      'INSERT INTO water_sales (water_name, capacity, jerrycans_sold, price_per_jerrycan, total_amount, profit, customer_name, payment_method, notes, customer_brings_bottle, includes_bottle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [wName || 'Water', cap || 20, jerrycans_sold, price_per_jerrycan, total_amount, profit, custName, payment_method || 'cash', notes || '', customerBringsBottle, includesBottle]
    );

    // Handle bottle inventory based on whether customer takes bottle or brings their own
    if (includesBottle && !customerBringsBottle) {
      // Customer takes the bottle (buys it) - reduce filled quantity
      const newQty = currentQty - jerrycans_sold;
      if (newQty <= 0) {
        await pool.query('DELETE FROM water_jerrycans WHERE id = ?', [stockId]);
      } else {
        await pool.query('UPDATE water_jerrycans SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newQty, stockId]);
      }
    } else {
      // Customer brings their own bottle (swaps) - reduce filled, add to empty
      const newFilledQty = currentQty - jerrycans_sold;
      if (newFilledQty <= 0) {
        await pool.query('DELETE FROM water_jerrycans WHERE id = ?', [stockId]);
      } else {
        await pool.query('UPDATE water_jerrycans SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newFilledQty, stockId]);
      }
      
      // Add to empty stock
      const [emptyRows] = await pool.query(
        'SELECT id, quantity FROM water_jerrycans WHERE status = ? AND water_name = ? AND capacity = ? LIMIT 1',
        ['empty', wName || 'Water', cap || 20]
      );
      
      if (emptyRows.length > 0) {
        await pool.query('UPDATE water_jerrycans SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [jerrycans_sold, emptyRows[0].id]);
      } else {
        await pool.query(
          'INSERT INTO water_jerrycans (water_name, capacity, status, serial_number, selling_price, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
          [wName || 'Water', cap || 20, 'empty', `STOCK-${wName || 'Water'}-${cap || 20}L-empty`, 0, jerrycans_sold]
        );
      }
    }

    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'water_sale',
        entityId: result.insertId,
        entityName: `Water Sale #${result.insertId}`,
        description: `yagurishije amazi ya ${jerrycans_sold} jerrycans ${customerBringsBottle ? "(umukiriya azanya icupa)" : "(aratwara icupa)"}`,
        metadata: { jerrycans_sold, total_amount, profit, customerBringsBottle, includesBottle }
      });
    }

    res.json({
      success: true,
      data: {
        id: result.insertId,
        water_name: wName || 'Water',
        capacity: cap || 20,
        jerrycans_sold,
        price_per_jerrycan,
        total_amount,
        profit,
        customer_name: custName,
        payment_method: payment_method || 'cash',
        notes: notes || '',
        customer_brings_bottle: customerBringsBottle,
        includes_bottle: includesBottle
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE water sale
router.put('/sales/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    const { jerrycans_sold, price_per_jerrycan, customer_name, payment_method, notes } = req.body;
    if (!jerrycans_sold || !price_per_jerrycan) {
      return res.status(400).json({ error: 'Jerrycans sold and price per jerrycan are required' });
    }
    const total_amount = jerrycans_sold * price_per_jerrycan;
    const profit = 0; // We don't track per-sale profit anymore
    await pool.query(
      'UPDATE water_sales SET jerrycans_sold = ?, price_per_jerrycan = ?, total_amount = ?, profit = ?, customer_name = ?, payment_method = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [jerrycans_sold, price_per_jerrycan, total_amount, profit, customer_name || 'Walk-in Customer', payment_method || 'cash', notes || '', id]
    );
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'update',
        entityType: 'water_sale',
        entityId: parseInt(id),
        entityName: `Water Sale #${id}`,
        description: `yahuje igurisha amazi #${id}`,
        metadata: { jerrycans_sold, total_amount, profit }
      });
    }
    res.json({ success: true, message: 'Sale updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE water sale
router.delete('/sales/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    await pool.query('DELETE FROM water_sales WHERE id = ?', [id]);
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'delete',
        entityType: 'water_sale',
        entityId: parseInt(id),
        entityName: `Water Sale #${id}`,
        description: `yasibe igurisha amazi #${id}`,
        metadata: {}
      });
    }
    res.json({ success: true, message: 'Sale deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET water additions (with optional period, start_date, end_date)
router.get('/additions', async (req, res) => {
  try {
    const { period, start_date, end_date } = req.query;
    let dateFilter = '';
    let params = [];
    if (period === 'today') {
      dateFilter = 'DATE(created_at) = CURDATE()';
    } else if (period === 'yesterday') {
      dateFilter = 'DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
    } else if (period === 'this_week') {
      dateFilter = 'DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    } else if (period === 'this_month') {
      dateFilter = 'MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())';
    } else if (start_date && end_date) {
      dateFilter = 'DATE(created_at) BETWEEN ? AND ?';
      params = [start_date, end_date];
    }
    let query = 'SELECT id, water_name, status, jerrycans_added, liters_per_jerrycan, total_liters, buying_price_per_jerrycan, selling_price_per_jerrycan, COALESCE(bottle_price, 0) as bottle_price, total_buying_cost AS total_cost, total_selling_price, expected_profit, supplier_name, date, created_at, updated_at FROM water_additions';
    if (dateFilter) {
      query += ' WHERE ' + dateFilter;
    }
    query += ' ORDER BY created_at DESC';
    const [additions] = await pool.query(query, params);
    res.json({
      success: true,
      data: additions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE water addition (water_name, status empty/filled, number, liters; optional buying/selling price)
router.post('/additions', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const {
      water_name,
      status = 'filled',
      jerrycans_added,
      liters_per_jerrycan,
      buying_price_per_jerrycan = 0,
      selling_price_per_jerrycan = 0,
      bottle_price = 0,
      bottle_health = 'good',
      supplier_name,
      date
    } = req.body;

    if (!jerrycans_added || !liters_per_jerrycan) {
      return res.status(400).json({ error: 'Number of jerrycans and litres per jerrycan are required' });
    }
    const wName = (water_name && String(water_name).trim()) ? String(water_name).trim() : 'Water';
    const jerrycanStatus = status === 'empty' ? 'empty' : 'filled';
    const buying = parseFloat(buying_price_per_jerrycan) || 0;
    const selling = parseFloat(selling_price_per_jerrycan) || 0;
    const bottlePrice = parseFloat(bottle_price) || 0;
    const health = ['good', 'damaged', 'needs_repair'].includes(bottle_health) ? bottle_health : 'good';

    const total_liters = jerrycanStatus === 'filled' ? jerrycans_added * liters_per_jerrycan : 0;
    const total_buying_cost = jerrycans_added * (buying + bottlePrice);
    const total_selling_price = jerrycans_added * selling;
    const expected_profit = total_selling_price - total_buying_cost;
    // Fix date format - ensure it's YYYY-MM-DD
    let dateVal = new Date().toISOString().split('T')[0];
    if (date) {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        dateVal = d.toISOString().split('T')[0];
      }
    }

    const [result] = await pool.query(
      'INSERT INTO water_additions (water_name, status, jerrycans_added, liters_per_jerrycan, total_liters, buying_price_per_jerrycan, selling_price_per_jerrycan, bottle_price, total_buying_cost, total_selling_price, expected_profit, supplier_name, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [wName, jerrycanStatus, jerrycans_added, liters_per_jerrycan, total_liters, buying, selling, bottlePrice, total_buying_cost, total_selling_price, expected_profit, supplier_name || '', dateVal]
    );

    // Use quantity-based approach: check if record exists, update quantity or insert new
    const [existingRows] = await pool.query(
      'SELECT id, quantity FROM water_jerrycans WHERE water_name = ? AND capacity = ? AND status = ? LIMIT 1',
      [wName, liters_per_jerrycan, jerrycanStatus]
    );
    
    if (existingRows.length > 0) {
      // Update existing record's quantity and prices
      await pool.query(
        'UPDATE water_jerrycans SET quantity = quantity + ?, selling_price = ?, bottle_price = ?, bottle_health = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [jerrycans_added, selling, bottlePrice, health, existingRows[0].id]
      );
    } else {
      // Insert new record with quantity
      await pool.query(
        'INSERT INTO water_jerrycans (water_name, capacity, status, serial_number, selling_price, bottle_price, bottle_health, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [wName, liters_per_jerrycan, jerrycanStatus, `STOCK-${wName}-${liters_per_jerrycan}L-${jerrycanStatus}`, selling, bottlePrice, health, jerrycans_added]
      );
    }

    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'water_addition',
        entityId: result.insertId,
        entityName: `Water Purchase #${result.insertId}`,
        description: `yaguze amazi ya ${jerrycans_added} jerrycans (${wName} ${liters_per_jerrycan}L)`,
        metadata: { jerrycans_added, total_liters, total_buying_cost }
      });
    }

    res.json({
      success: true,
      data: {
        id: result.insertId,
        water_name: wName,
        status: jerrycanStatus,
        jerrycans_added,
        liters_per_jerrycan,
        total_liters,
        buying_price_per_jerrycan: buying,
        selling_price_per_jerrycan: selling,
        bottle_price: bottlePrice,
        bottle_health: health,
        total_buying_cost,
        total_selling_price,
        expected_profit,
        supplier_name: supplier_name || '',
        date: dateVal
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE water addition
router.put('/additions/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    const { jerrycans_added, liters_per_jerrycan, buying_price_per_jerrycan, selling_price_per_jerrycan, bottle_price = 0, supplier_name, date, status } = req.body;
    if (!jerrycans_added || !liters_per_jerrycan) {
      return res.status(400).json({ error: 'Jerrycans and liters are required' });
    }
    const buying = parseFloat(buying_price_per_jerrycan) || 0;
    const selling = parseFloat(selling_price_per_jerrycan) || 0;
    const bottlePrice = parseFloat(bottle_price) || 0;
    const jerrycanStatus = status === 'empty' ? 'empty' : 'filled';
    const total_liters = jerrycanStatus === 'filled' ? jerrycans_added * liters_per_jerrycan : 0;
    const total_buying_cost = jerrycans_added * (buying + bottlePrice);
    const total_selling_price = jerrycans_added * selling;
    const expected_profit = total_selling_price - total_buying_cost;
    
    // Fix date format - ensure it's YYYY-MM-DD
    let dateVal = new Date().toISOString().split('T')[0];
    if (date) {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        dateVal = d.toISOString().split('T')[0];
      }
    }
    
    // Get the water_name from the existing record
    const [existingRecord] = await pool.query('SELECT water_name FROM water_additions WHERE id = ?', [id]);
    const waterName = existingRecord[0]?.water_name || '';
    
    await pool.query(
      'UPDATE water_additions SET jerrycans_added = ?, liters_per_jerrycan = ?, total_liters = ?, buying_price_per_jerrycan = ?, selling_price_per_jerrycan = ?, bottle_price = ?, status = ?, total_buying_cost = ?, total_selling_price = ?, expected_profit = ?, supplier_name = ?, date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [jerrycans_added, liters_per_jerrycan, total_liters, buying, selling, bottlePrice, jerrycanStatus, total_buying_cost, total_selling_price, expected_profit, supplier_name || '', dateVal, id]
    );
    
    // Also update bottle_price in water_jerrycans for matching bottles
    if (bottlePrice > 0) {
      await pool.query(
        'UPDATE water_jerrycans SET bottle_price = ?, selling_price = ? WHERE (water_name = ? OR (water_name IS NULL AND ? = "")) AND capacity = ? AND (bottle_price = 0 OR bottle_price IS NULL OR bottle_price < ?)',
        [bottlePrice, selling, waterName, waterName, liters_per_jerrycan, bottlePrice]
      );
    }
    
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'update',
        entityType: 'water_addition',
        entityId: parseInt(id),
        entityName: `Water Purchase #${id}`,
        description: `yahuje igura amazi #${id}`,
        metadata: { jerrycans_added, total_buying_cost }
      });
    }
    res.json({ success: true, message: 'Purchase updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE water addition
router.delete('/additions/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    await pool.query('DELETE FROM water_additions WHERE id = ?', [id]);
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'delete',
        entityType: 'water_addition',
        entityId: parseInt(id),
        entityName: `Water Purchase #${id}`,
        description: `yasibe igura amazi #${id}`,
        metadata: {}
      });
    }
    res.json({ success: true, message: 'Purchase deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET recent additions
router.get('/recent-additions', async (req, res) => {
  try {
    const [additions] = await pool.query(
      'SELECT * FROM water_additions ORDER BY created_at DESC LIMIT 10'
    );
    
    res.json({
      success: true,
      data: additions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET water stats
router.get('/stats', async (req, res) => {
  try {
    // Total jerrycans
    const [totalJerrycans] = await pool.query('SELECT COUNT(*) as count FROM water_jerrycans');
    
    // Total liters (Current Available Water)
    const [totalLiters] = await pool.query('SELECT SUM(capacity) as total FROM water_jerrycans WHERE status = "filled"');
    
    // Total cost
    const [totalCost] = await pool.query('SELECT SUM(total_buying_cost) as total FROM water_additions');
    
    // Today's additions
    const [todayAdditions] = await pool.query(
      'SELECT COUNT(*) as count FROM water_additions WHERE DATE(created_at) = CURDATE()'
    );
    
    res.json({
      success: true,
      data: {
        totalJerrycans: totalJerrycans[0].count || 0,
        totalLiters: totalLiters[0].total || 0,
        totalCost: parseFloat(totalCost[0].total || 0),
        todayAdditions: todayAdditions[0].count || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET jerrycans
router.get('/jerrycans', async (req, res) => {
  try {
    const [jerrycans] = await pool.query(
      'SELECT * FROM water_jerrycans ORDER BY created_at DESC'
    );
    
    res.json({
      success: true,
      data: jerrycans
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE jerrycan status
router.patch('/jerrycans/:id/status', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['filled', 'empty', 'maintenance'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    await pool.query(
      'UPDATE water_jerrycans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );
    
    // Log activity
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'update',
        entityType: 'water_jerrycan',
        entityId: parseInt(id),
        entityName: `Jerrycan #${id}`,
        description: `yahinduriye imiterere ya jerrycan #${id} kuri "${status}"`,
        metadata: { status }
      });
    }
    
    res.json({
      success: true,
      message: 'Jerrycan status updated successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADD new jerrycans
router.post('/jerrycans', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { count, capacity = 20 } = req.body;
    
    if (!count || count < 1) {
      return res.status(400).json({ error: 'Valid count is required' });
    }
    
    const addedJerrycans = [];
    for (let i = 0; i < count; i++) {
      const [result] = await pool.query(
        'INSERT INTO water_jerrycans (capacity, status, serial_number, created_at) VALUES (?, "empty", ?, CURRENT_TIMESTAMP)',
        [capacity, `JRC-${Date.now()}-${i}`]
      );
      addedJerrycans.push({
        id: result.insertId,
        serial_number: `JRC-${Date.now()}-${i}`,
        capacity,
        status: 'empty'
      });
    }
    
    // Log activity
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'water_jerrycan',
        entityId: addedJerrycans[0]?.id,
        entityName: `${count} New Jerrycans`,
        description: `yongeremo jerrycans ${count} nshya`,
        metadata: { count, capacity }
      });
    }
    
    res.json({
      success: true,
      data: addedJerrycans
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET jerrycan stats
router.get('/jerrycan-stats', async (req, res) => {
  try {
    const [stats] = await pool.query(`
      SELECT 
        SUM(COALESCE(quantity, 1)) as total,
        SUM(CASE WHEN status = 'filled' THEN COALESCE(quantity, 1) ELSE 0 END) as filled,
        SUM(CASE WHEN status = 'empty' THEN COALESCE(quantity, 1) ELSE 0 END) as empty,
        SUM(CASE WHEN status = 'maintenance' THEN COALESCE(quantity, 1) ELSE 0 END) as maintenance
      FROM water_jerrycans
    `);
    
    res.json({
      success: true,
      data: {
        total: stats[0].total || 0,
        filled: stats[0].filled || 0,
        empty: stats[0].empty || 0,
        inMaintenance: stats[0].maintenance || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET water reports
router.get('/reports', async (req, res) => {
  try {
    const { period, start_date, end_date } = req.query;
    let dateFilter = '';
    let params = [];
    
    if (period === 'today') {
      dateFilter = 'DATE(created_at) = CURDATE()';
    } else if (period === 'yesterday') {
      dateFilter = 'DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
    } else if (period === 'this_week') {
      dateFilter = 'DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    } else if (period === 'this_month') {
      dateFilter = 'MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())';
    } else if (start_date && end_date) {
      dateFilter = 'DATE(created_at) BETWEEN ? AND ?';
      params = [start_date, end_date];
    }
    
    // Get sales
    let salesQuery = 'SELECT * FROM water_sales';
    if (dateFilter) {
      salesQuery += ' WHERE ' + dateFilter;
    }
    salesQuery += ' ORDER BY created_at DESC';
    
    const [sales] = await pool.query(salesQuery, params);
    
    // Get additions
    let additionsQuery = 'SELECT * FROM water_additions';
    if (dateFilter) {
      additionsQuery += ' WHERE ' + dateFilter;
    }
    additionsQuery += ' ORDER BY created_at DESC';
    
    const [additions] = await pool.query(additionsQuery, params);
    const additionsWithCost = additions.map(a => ({ ...a, total_cost: a.total_buying_cost || a.total_cost || 0 }));
    
    // Calculate summary
    const totalSales = sales.reduce((sum, sale) => sum + (sale.jerrycans_sold || 0), 0);
    const totalRevenue = sales.reduce((sum, sale) => sum + parseFloat(sale.total_amount || 0), 0);
    // Profit is calculated as Revenue - Investment (Cost)
    const totalAdditions = additions.reduce((sum, addition) => sum + (addition.jerrycans_added || 0), 0);
    const totalCost = additions.reduce((sum, addition) => sum + parseFloat(addition.total_buying_cost || addition.total_cost || 0), 0);
    const netProfit = totalRevenue - totalCost;
    
    // Set totalProfit to netProfit to align with frontend expectations or keep them separate
    // We will use netProfit as the main profit indicator
    const totalProfit = netProfit; 
    
    res.json({
      success: true,
      data: {
        sales,
        additions: additionsWithCost,
        summary: {
          totalSales,
          totalRevenue,
          totalProfit, // This is now Revenue - Cost
          totalAdditions,
          totalCost,
          netProfit // Same as totalProfit
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
