// Fonction serverless Vercel : crée une session Stripe Checkout pour payer la commande en ligne.
// Variable d'environnement requise (Vercel → Settings → Environment Variables) :
//   STRIPE_SECRET_KEY — clé secrète Stripe (jamais exposée côté front)
//   STRIPE_PUBLISHABLE_KEY — clé publique Stripe, requise pour Checkout intégré.

const Stripe = require('stripe');
const VINTAGE_PRODUCT_IDS = new Set([101, 201, 505, 506, 507, 508, 509, 510, 511, 513, 514, 515, 516, 517]);

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
  let line_items;
  try {
    line_items = items.map(item => {
      const version = String(item.version || '');
      const productId = Number(item.productId);
      if (!['Standard', 'Player', 'Manches longues Standard', 'Manches longues Player', 'Vintage'].includes(version)) {
        throw new Error('Version invalide');
      }
      if (!Number.isInteger(productId) || productId <= 0 || VINTAGE_PRODUCT_IDS.has(productId) !== (version === 'Vintage')) {
        throw new Error('Produit invalide');
      }
      const name = String(item.name || 'Maillot Jersey Select').slice(0, 100);
      const club = String(item.club || '').slice(0, 100);
      const size = String(item.size || '').slice(0, 20);
      const flocage = String(item.flocage || '').slice(0, 100);
      if (!['S', 'M', 'L', 'XL', 'XXL'].includes(size)) {
        throw new Error('Taille invalide');
      }
      const flocageText = flocage.replace(/(?: · )?Short assorti inclus$/, '');
      const flocageParts = flocageText === 'Sans flocage' ? [] : flocageText.split(' · ').filter(Boolean);
      const hasNumber = flocageParts.some(part => /^N°\d{1,2}$/.test(part));
      const hasText = flocageParts.some(part => !/^N°\d{1,2}$/.test(part));
      const hasShort = flocage.endsWith('Short assorti inclus');
      const basePrice = version === 'Vintage' || version.endsWith('Player') ? 25 : 20;
      const unitAmount = Math.round((basePrice + (hasNumber ? 2.5 : 0) + (hasText ? 2.5 : 0) + (hasShort ? 10 : 0)) * 100);

      const productData = {
        name: [name, club].filter(Boolean).join(' · ') || 'Maillot Jersey Select',
        description: [version, `Taille ${size}`, flocage]
          .filter(Boolean).join(' — ') || undefined,
        metadata: {
          club,
          version,
          size,
          flocage
        }
      };
      if (item.image && /^https?:\/\//.test(item.image)) {
        const imageUrl = new URL(item.image);
        if (imageUrl.hostname === 'jersey-select.com' || imageUrl.hostname === 'www.jersey-select.com') {
          productData.images = [imageUrl.href];
        }
      }

      return {
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: unitAmount,
          product_data: productData
        }
      };
    });
  } catch (e) {
    return res.status(400).json({ error: 'Article de panier invalide' });
  }

  try {
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
    const secretMode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';
    const publishableMatch = publishableKey.match(/^pk_(test|live)_/);
    if (publishableKey && (!publishableMatch || publishableMatch[1] !== secretMode)) {
      return res.status(500).json({ error: 'Les clés Stripe test/live ne correspondent pas.' });
    }
    const useEmbeddedCheckout = Boolean(publishableMatch);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      customer_email: customer?.email || undefined,
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU'] },
      ...(useEmbeddedCheckout
        ? { ui_mode: 'embedded', return_url: 'https://jersey-select.com/commande-confirmee?session_id={CHECKOUT_SESSION_ID}' }
        : { success_url: 'https://jersey-select.com/commande-confirmee?session_id={CHECKOUT_SESSION_ID}', cancel_url: 'https://jersey-select.com/panier' }),
      metadata: {
        source: 'jersey-select',
        orderReference: orderReference || '',
        customerName: customer?.name || '',
        customerEmail: customer?.email || '',
        customerPhone: customer?.phone || ''
      }
    });

    return res.status(200).json(useEmbeddedCheckout
      ? { clientSecret: session.client_secret, publishableKey }
      : { url: session.url });
  } catch (error) {
    console.error('Erreur Stripe Checkout:', error);
    return res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
};
