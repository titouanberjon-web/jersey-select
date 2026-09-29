// Fonction serverless Vercel : crée une session Stripe Checkout pour payer la commande en ligne.
// Variable d'environnement requise (Vercel → Settings → Environment Variables) :
//   STRIPE_SECRET_KEY — clé secrète Stripe (jamais exposée côté front)

const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY non configurée sur Vercel' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { items, customer, orderReference } = req.body || {};

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Panier vide' });
  }

  // TODO sécurité (v2) : on fait ici confiance au prix envoyé par le front (item.price),
  // qui peut être manipulé côté navigateur avant l'appel à cette API. Pour une mise en
  // production sérieuse, reconstruire le prix ici à partir d'un catalogue serveur
  // (id produit + options choisies) plutôt que d'utiliser item.price tel quel.
  let line_items;
  try {
    line_items = items.map(item => {
      const price = Number(item.price);
      if (!isFinite(price) || price <= 0) throw new Error('Prix invalide');

      const productData = {
        name: [item.name, item.club].filter(Boolean).join(' · ') || 'Maillot Jersey Select',
        description: [item.version, item.size ? `Taille ${item.size}` : '', item.flocage]
          .filter(Boolean).join(' — ') || undefined,
        metadata: {
          club: item.club || '',
          version: item.version || '',
          size: item.size || '',
          flocage: item.flocage || ''
        }
      };
      if (item.image && /^https?:\/\//.test(item.image)) {
        productData.images = [item.image];
      }

      return {
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(price * 100),
          product_data: productData
        }
      };
    });
  } catch (e) {
    return res.status(400).json({ error: 'Article de panier invalide' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      customer_email: customer?.email || undefined,
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU'] },
      success_url: 'https://jersey-select.com/commande-confirmee?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://jersey-select.com/panier',
      metadata: {
        source: 'jersey-select',
        orderReference: orderReference || '',
        customerName: customer?.name || '',
        customerEmail: customer?.email || '',
        customerPhone: customer?.phone || ''
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Erreur Stripe Checkout:', error);
    return res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
};
