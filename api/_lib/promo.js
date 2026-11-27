// Codes promo : créés dans le Dashboard Stripe (Catalogue de produits → Coupons → code promotionnel).
// Ce module retrouve un code actif et vérifie qu'il est utilisable sur le site ; Stripe revérifie
// tout au moment de la création de la session de paiement.

class PromoError extends Error {}
const UNKNOWN_CODE = 'Ce code promo n\'existe pas ou n\'est plus valable.';

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().slice(0, 50);
}

const MAX_CODES_PER_ORDER = 3;

// Stripe n'accepte qu'un code par paiement : quand le client en cumule plusieurs, le site
// applique une réduction unique créée pour la commande, et marque chaque code utilisé dans
// les métadonnées du paiement. Stripe ne compte alors pas ces utilisations : on les compte ici.
function stackedMetadataKey(code) {
  return `promo_${String(code).toUpperCase().replace(/[^A-Z0-9_-]/g, '_')}`;
}
async function countStackedUses(stripe, code) {
  const { data } = await stripe.paymentIntents.search({
    query: `status:'succeeded' AND metadata['${stackedMetadataKey(code)}']:'1'`,
    limit: 100
  });
  return data.length;
}

// Réduction totale (centimes) : les pourcentages s'additionnent sur le montant des maillots,
// puis les montants fixes s'ajoutent ; jamais plus que le montant des maillots.
function combinedDiscount(promos, baseAmount) {
  const percent = promos.reduce((sum, p) => sum + (p.percentOff || 0), 0);
  const fixed = promos.reduce((sum, p) => sum + (p.amountOff || 0), 0);
  return Math.min(baseAmount, Math.round(baseAmount * percent / 100) + fixed);
}

// Les acheteurs du site n'ont pas de compte client Stripe : Stripe ne peut donc pas savoir seul
// si c'est leur première commande. On cherche les paiements déjà faits avec cet email.
async function hasPaidOrderBefore(stripe, email) {
  const { data } = await stripe.checkout.sessions.list({ customer_details: { email }, limit: 100 });
  return data.some(session => session.payment_status === 'paid' && session.metadata?.source === 'jersey-select');
}

// baseAmount : montant des maillots en centimes, après le « 5e offert » et hors frais de port.
// email : email du compte client connecté (nécessaire pour les codes réservés).
async function findPromotionCode(stripe, rawCode, baseAmount, rawEmail) {
  const code = normalizeCode(rawCode);
  if (!code) throw new PromoError('Entre un code promo.');

  const { data } = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
  const promo = data[0];
  const coupon = promo && (promo.coupon || promo.promotion?.coupon);
  if (!promo || !coupon || typeof coupon !== 'object' || !coupon.valid) {
    throw new PromoError(UNKNOWN_CODE);
  }
  if (promo.expires_at && promo.expires_at * 1000 < Date.now()) {
    throw new PromoError('Ce code promo a expiré.');
  }
  const maxUses = promo.max_redemptions || coupon.max_redemptions;
  if (maxUses) {
    const used = Math.max(promo.times_redeemed || 0, coupon.times_redeemed || 0)
      + await countStackedUses(stripe, promo.code);
    if (used >= maxUses) {
      throw new PromoError('Ce code promo a déjà été utilisé le nombre maximum de fois.');
    }
  }
  if (coupon.amount_off && coupon.currency !== 'eur') {
    throw new PromoError('Ce code promo n\'est pas utilisable sur le site.');
  }

  const minAmount = promo.restrictions?.minimum_amount || 0;
  if (minAmount && Number.isFinite(baseAmount) && baseAmount < minAmount) {
    const min = (minAmount / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    throw new PromoError(`Ce code promo est valable dès ${min} € d'achat.`);
  }

  const email = String(rawEmail || '').trim().toLowerCase();
  const reservedCustomer = typeof promo.customer === 'string' ? promo.customer : promo.customer?.id;
  const firstOrderOnly = Boolean(promo.restrictions?.first_time_transaction);
  // Code réservé à un client : pour tous les autres, on fait comme s'il n'existait pas.
  if (reservedCustomer) {
    const owner = email ? await stripe.customers.retrieve(reservedCustomer) : null;
    if (!owner || owner.deleted || String(owner.email || '').trim().toLowerCase() !== email) {
      throw new PromoError(UNKNOWN_CODE);
    }
  }
  if (firstOrderOnly && !email) {
    throw new PromoError('Connecte-toi à ton compte pour utiliser ce code promo.');
  }
  if (firstOrderOnly && await hasPaidOrderBefore(stripe, email)) {
    throw new PromoError('Ce code promo est réservé à la première commande.');
  }

  return {
    id: promo.id,
    code: promo.code.toUpperCase(),
    customerId: reservedCustomer || null,
    percentOff: coupon.percent_off || 0,
    amountOff: coupon.amount_off || 0,
    minAmount
  };
}

module.exports = { findPromotionCode, combinedDiscount, stackedMetadataKey, PromoError, MAX_CODES_PER_ORDER };
