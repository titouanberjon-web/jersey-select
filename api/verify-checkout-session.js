// Confirme côté serveur qu'une session Stripe appartient au site et est payée.
const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Paiement indisponible' });
  }

  const sessionId = String(req.query?.session_id || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'Session de paiement invalide' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.metadata?.source === 'jersey-select' && session.payment_status === 'paid';
    const lineItems = paid
      ? await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 })
      : { data: [] };
    return res.status(200).json({
      paid,
      orderReference: session.metadata?.orderReference || null,
      amountTotal: paid ? session.amount_total : null,
      items: lineItems.data.map(item => ({ amountTotal: item.amount_total, quantity: item.quantity }))
    });
  } catch (error) {
    console.error('Erreur de vérification Stripe:', error.message);
    return res.status(404).json({ error: 'Session de paiement introuvable' });
  }
};
