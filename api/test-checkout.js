// Checkout de démonstration isolé : n'accepte que les clés Stripe de test.
const Stripe = require('stripe');

function getTestStripe(res) {
  const secretKey = process.env.STRIPE_TEST_SECRET_KEY || '';
  const publishableKey = process.env.STRIPE_TEST_PUBLISHABLE_KEY || '';
  if (!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')) {
    res.status(503).json({ error: 'Clés Stripe de test manquantes. Configure STRIPE_TEST_SECRET_KEY et STRIPE_TEST_PUBLISHABLE_KEY sur Vercel.' });
    return null;
  }
  return { stripe: new Stripe(secretKey), publishableKey };
}

module.exports = async (req, res) => {
  const config = getTestStripe(res);
  if (!config) return;

  if (req.method === 'POST') {
    try {
      const session = await config.stripe.checkout.sessions.create({
        mode: 'payment',
        ui_mode: 'embedded',
        payment_method_types: ['card'],
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: 50,
            product_data: {
              name: 'Article de test — aucun envoi',
              description: 'Paiement Stripe en mode test uniquement.'
            }
          }
        }],
        return_url: 'https://jersey-select.com/test-paiement.html?session_id={CHECKOUT_SESSION_ID}',
        metadata: { source: 'jersey-select-test', no_fulfillment: 'true' }
      });
      return res.status(200).json({ clientSecret: session.client_secret, publishableKey: config.publishableKey });
    } catch (error) {
      console.error('Erreur Stripe test Checkout:', error.message);
      return res.status(500).json({ error: 'Impossible de créer la session de test Stripe.' });
    }
  }

  if (req.method === 'GET') {
    const sessionId = String(req.query?.session_id || '');
    if (!/^cs_test_[A-Za-z0-9]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'Session de test invalide.' });
    }
    try {
      const session = await config.stripe.checkout.sessions.retrieve(sessionId);
      const validTestPayment = session.metadata?.source === 'jersey-select-test'
        && session.payment_status === 'paid'
        && session.amount_total === 50
        && session.currency === 'eur';
      return res.status(200).json({ paid: validTestPayment, testMode: true });
    } catch (error) {
      console.error('Erreur vérification Stripe test:', error.message);
      return res.status(404).json({ error: 'Session de test introuvable.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Méthode non autorisée.' });
};
