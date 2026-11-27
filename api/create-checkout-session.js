// Fonction serverless Vercel : crée une session Stripe Checkout pour payer la commande en ligne.
// Variable d'environnement requise (Vercel → Settings → Environment Variables) :
//   STRIPE_SECRET_KEY — clé secrète Stripe (jamais exposée côté front)
//   STRIPE_PUBLISHABLE_KEY — clé publique Stripe, requise pour Checkout intégré.

const Stripe = require('stripe');
const { computePricing, MAX_QUANTITY_PER_LINE } = require('./_lib/pricing');
const { findPromotionCode, combinedDiscount, stackedMetadataKey, PromoError, MAX_CODES_PER_ORDER } = require('./_lib/promo');
const VINTAGE_PRODUCT_IDS = new Set([101, 201, 505, 506, 507, 508, 509, 510, 511, 513, 514, 515, 516, 517]);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY non configurée sur Vercel' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { items, customer, orderReference, promoCode, promoCodes } = req.body || {};

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Panier vide' });
  }
  let cartLines;
  try {
    cartLines = items.map((item, cartIndex) => {
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
      const quantity = item.quantity === undefined ? 1 : Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
        throw new Error('Quantité invalide');
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
          cartIndex: String(cartIndex),
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

      return { quantity, unitAmount, productData };
    });
  } catch (e) {
    return res.status(400).json({ error: 'Article de panier invalide' });
  }

  // Promo « 4 achetés, le 5e offert » + frais de port sous 3 maillots, quantités comprises.
  // Une ligne du panier dont une partie est offerte devient deux lignes Stripe :
  // les maillots payés, puis les maillots offerts à 0 €.
  const pricing = computePricing(cartLines.map(line => ({ amount: line.unitAmount, quantity: line.quantity })));
  const line_items = [];
  cartLines.forEach((line, index) => {
    const freeQuantity = pricing.freeQuantities[index];
    if (line.quantity > freeQuantity) {
      line_items.push({
        quantity: line.quantity - freeQuantity,
        price_data: { currency: 'eur', unit_amount: line.unitAmount, product_data: line.productData }
      });
    }
    if (freeQuantity > 0) {
      line_items.push({
        quantity: freeQuantity,
        price_data: {
          currency: 'eur',
          unit_amount: 0,
          product_data: {
            ...line.productData,
            name: `🎁 Offert — ${line.productData.name}`.slice(0, 250),
            metadata: { ...line.productData.metadata, promo: '5e maillot offert' }
          }
        }
      });
    }
  });
  const shipping_options = [{
    shipping_rate_data: {
      type: 'fixed_amount',
      display_name: pricing.shipping ? 'Livraison' : 'Livraison offerte (dès 3 maillots)',
      fixed_amount: { amount: pricing.shipping, currency: 'eur' }
    }
  }];

  // Codes promo saisis dans le panier : revérifiés ici, puis appliqués sur les maillots
  // (pas sur les frais de port).
  const requestedCodes = [...new Set(
    (Array.isArray(promoCodes) ? promoCodes : [promoCode])
      .map(code => String(code || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  if (requestedCodes.length > MAX_CODES_PER_ORDER) {
    return res.status(400).json({ error: `${MAX_CODES_PER_ORDER} codes promo maximum par commande.` });
  }
  const baseAmount = pricing.subtotal - pricing.discount;
  const promotions = [];
  for (const code of requestedCodes) {
    try {
      promotions.push(await findPromotionCode(stripe, code, baseAmount, customer?.email));
    } catch (error) {
      if (error instanceof PromoError) {
        return res.status(400).json({ error: `${code} : ${error.message}`, promoInvalid: true, invalidCode: code });
      }
      console.error('Erreur vérification code promo:', error);
      return res.status(500).json({ error: 'Impossible de vérifier le code promo pour le moment.' });
    }
  }
  const reservedCustomerId = promotions.find(p => p.customerId)?.customerId || null;

  // Un seul code : Stripe l'applique et compte lui-même son utilisation.
  // Plusieurs codes : réduction unique créée pour cette commande (Stripe n'en accepte qu'une).
  let discounts;
  const paymentMetadata = {};
  if (promotions.length === 1) {
    discounts = [{ promotion_code: promotions[0].id }];
  } else if (promotions.length > 1) {
    const amountOff = combinedDiscount(promotions, baseAmount);
    if (amountOff > 0) {
      let coupon;
      try {
        coupon = await stripe.coupons.create({
          amount_off: amountOff,
          currency: 'eur',
          duration: 'once',
          max_redemptions: 1,
          name: `Codes ${promotions.map(p => p.code).join(' + ')}`.slice(0, 40),
          metadata: { source: 'jersey-select', promoCodes: promotions.map(p => p.code).join(',') }
        });
      } catch (error) {
        console.error('Erreur création réduction cumulée:', error);
        return res.status(500).json({ error: 'Impossible d\'appliquer les codes promo pour le moment.' });
      }
      discounts = [{ coupon: coupon.id }];
      promotions.forEach(p => { paymentMetadata[stackedMetadataKey(p.code)] = '1'; });
    }
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
      // Code réservé à un client : Stripe exige que la session soit rattachée à ce client.
      ...(reservedCustomerId
        ? { customer: reservedCustomerId }
        : { customer_email: customer?.email || undefined }),
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU'] },
      shipping_options,
      ...(discounts ? { discounts } : {}),
      ...(Object.keys(paymentMetadata).length ? { payment_intent_data: { metadata: paymentMetadata } } : {}),
      ...(useEmbeddedCheckout
        ? { ui_mode: 'embedded', return_url: 'https://jersey-select.com/commande-confirmee?session_id={CHECKOUT_SESSION_ID}' }
        : { success_url: 'https://jersey-select.com/commande-confirmee?session_id={CHECKOUT_SESSION_ID}', cancel_url: 'https://jersey-select.com/panier' }),
      metadata: {
        source: 'jersey-select',
        orderReference: orderReference || '',
        customerName: customer?.name || '',
        customerEmail: customer?.email || '',
        customerPhone: customer?.phone || '',
        promoCode: promotions.map(p => p.code).join(' + ')
      }
    });

    return res.status(200).json(useEmbeddedCheckout
      ? { clientSecret: session.client_secret, publishableKey }
      : { url: session.url });
  } catch (error) {
    console.error('Erreur Stripe Checkout:', error);
    if (promotions.length && error.type === 'StripeInvalidRequestError') {
      return res.status(400).json({ error: 'Ce code promo ne peut pas être appliqué à cette commande.', promoInvalid: true });
    }
    return res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
};
