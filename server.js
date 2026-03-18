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
  origin: [process.env.FRONTEND_URL, 'https://specter-henna.vercel.app', /\.vercel\.app$/, 'http://localhost:5174'],
  methods: ['GET', 'POST'],
}));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use('/api/', limiter);

app.use('/api', scanRoute);

// Pro payment notification
app.post('/api/pro-payment', async (req, res) => {
  try {
    const { wallet, signature, email } = req.body;
    console.log(`[pro] Payment! Wallet: ${wallet} | Sig: ${signature} | Email: ${email}`);

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Specter <onboarding@resend.dev>',
        to: 'shivammehta713@gmail.com',
        subject: '💰 New Specter Pro Payment!',
        html: `
          <h2>New Pro Subscription Payment</h2>
          <p><strong>Wallet:</strong> ${wallet}</p>
          <p><strong>Transaction:</strong> <a href="https://solscan.io/tx/${signature}">${signature}</a></p>
          <p><strong>Email:</strong> ${email || 'Not provided'}</p>
          <p>Activate their Pro access manually.</p>
        `,
      }),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[pro-payment]', err.message);
    res.json({ success: false });
  }
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n👻 Specter backend running on http://localhost:${PORT}\n`);
});
