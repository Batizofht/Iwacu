const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { initDatabase } = require('./config/database');

// Import routes
const authRoutes = require('./routes/auth');
const categoriesRoutes = require('./routes/categories');
const itemsRoutes = require('./routes/items');
const suppliersRoutes = require('./routes/suppliers');
const stockRoutes = require('./routes/stock');
const debtsRoutes = require('./routes/debts');
const installmentsRoutes = require('./routes/installments');
const purchaseOrdersRoutes = require('./routes/purchaseOrders');
const clientsRoutes = require('./routes/clients');
const salesRoutes = require('./routes/sales');
const expensesRoutes = require('./routes/expenses');
const notificationsRoutes = require('./routes/notifications');
const emailSettingsRoutes = require('./routes/emailSettings');
const reportsRoutes = require('./routes/reports');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/items', itemsRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/debts', debtsRoutes);
app.use('/api/installments', installmentsRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/email-settings', emailSettingsRoutes);
app.use('/api/reports', reportsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Iwacu Shop API is running' });
});

// Initialize database and start server
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
