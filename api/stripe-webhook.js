// Fonction serverless Vercel : webhook Stripe.
// Écoute les événements Checkout réussis pour confirmer le paiement et envoyer le bon.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY      — clé secrète Stripe
//   STRIPE_WEBHOOK_SECRET  — secret de signature du endpoint (Stripe Dashboard → Webhooks)
//
// Configuration Stripe Dashboard : ajouter un endpoint pointant vers
//   https://jersey-select.com/api/stripe-webhook
// et sélectionner "checkout.session.completed" (et, si moyens différés activés,
// "checkout.session.async_payment_succeeded").
//
const Stripe = require('stripe');
const sendPaidOrderEmail = require('./_lib/send-paid-order-email');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET non configurées sur Vercel');
    return res.status(500).json({ error: 'Webhook Stripe non configuré' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook Stripe invalide :', err.message);
    return res.status(400).json({ error: `Signature invalide : ${err.message}` });
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const eventSession = event.data.object;
    if (eventSession.metadata?.source !== 'jersey-select') {
      return res.status(200).json({ received: true, ignored: true });
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(eventSession.id);
      if (session.payment_status !== 'paid') {
        return res.status(200).json({ received: true, paymentPending: true });
      }

      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        limit: 100,
        expand: ['data.price.product']
      });
      if (!lineItems.data.length) throw new Error('Aucun article dans la session Stripe payée');

      const email = await sendPaidOrderEmail(session, lineItems.data);
      console.log('Email de commande payé envoyé', {
        sessionId: session.id,
        orderReference: session.metadata?.orderReference || null,
        emailId: email.id
      });
    } catch (error) {
      console.error('Échec du traitement de commande payée:', error.message);
      // Un 5xx demande à Stripe de réessayer l'événement.
      return res.status(500).json({ error: 'Envoi du bon de commande échoué' });
    }
  }

  return res.status(200).json({ received: true });
}

// Stripe a besoin du corps brut (non parsé) pour vérifier la signature : on attache
// ce `config` à la fonction handler APRÈS l'avoir définie, sinon module.exports = handler
// (juste en dessous) écraserait cette propriété.
handler.config = {
  api: { bodyParser: false }
};

module.exports = handler;
