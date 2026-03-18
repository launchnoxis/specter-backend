require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const scanRoute = require('./routes/scan');

const app = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: [process.env.FRONTEND_URL, /\.vercel\.app$/, 'http://localhost:5174'],
  methods: ['GET', 'POST'],
}));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use('/api/', limiter);

app.use('/api', scanRoute);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n👻 Specter backend running on http://localhost:${PORT}\n`);
});
