// Fonction serverless Vercel : webhook Stripe.
// Écoute checkout.session.completed pour confirmer qu'une commande a bien été payée.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY      — clé secrète Stripe
//   STRIPE_WEBHOOK_SECRET  — secret de signature du endpoint (Stripe Dashboard → Webhooks)
//
// Configuration Stripe Dashboard : ajouter un endpoint pointant vers
//   https://jersey-select.com/api/stripe-webhook
// et sélectionner l'événement "checkout.session.completed".
//
// TODO (v2 — pas encore fait) :
//   Aujourd'hui, l'email de confirmation + le PDF sont envoyés depuis le NAVIGATEUR du client
//   sur la page /commande-confirmee, une fois revenu de Stripe (voir index.html,
//   handlePostCheckoutRouting()). Ça fonctionne pour la V1, mais ce n'est pas fiable à 100 % :
//   si le client ferme l'onglet juste après le paiement, l'email ne part jamais alors que
//   la commande EST payée.
//   La version robuste serait de déplacer l'envoi de l'email ici, déclenché uniquement par
//   Stripe (donc garanti même si le client ferme son navigateur) :
//     1. Récupérer les line_items de la session (stripe.checkout.sessions.listLineItems).
//     2. Générer le PDF côté serveur (jsPDF ne fonctionne qu'en navigateur : il faudrait une
//        lib Node comme pdfkit ou pdf-lib, ou simplement envoyer un email HTML sans PDF).
//     3. Appeler la même logique que /api/send-order.js (ou l'importer) pour l'envoi Resend.
//     4. Marquer la commande comme "payée" quelque part (Firestore) pour éviter les doublons
//        avec l'envoi déclenché côté client.

const Stripe = require('stripe');

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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Pour l'instant : on log simplement la confirmation de paiement.
    // Voir le TODO en haut de fichier pour la suite (envoi email/PDF depuis le serveur).
    console.log('✅ Paiement confirmé via Stripe', {
      sessionId: session.id,
      orderReference: session.metadata?.orderReference || null,
      customerEmail: session.metadata?.customerEmail || session.customer_details?.email || null,
      amountTotal: session.amount_total,
    });
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
