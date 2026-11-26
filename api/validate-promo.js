// Fonction serverless Vercel : vérifie un code promo saisi dans le panier.
// Le montant affiché dans le panier n'est qu'un aperçu : la réduction réelle est appliquée
// par Stripe dans /api/create-checkout-session.

const Stripe = require('stripe');
const { findPromotionCode, PromoError } = require('./_lib/promo');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Paiement non configuré' });
  }

  const { code, amount } = req.body || {};
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const promo = await findPromotionCode(stripe, code, Number(amount));
    return res.status(200).json({
      code: promo.code,
      percentOff: promo.percentOff,
      amountOff: promo.amountOff,
      minAmount: promo.minAmount
    });
  } catch (error) {
    if (error instanceof PromoError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Erreur vérification code promo:', error);
    return res.status(500).json({ error: 'Impossible de vérifier le code pour le moment.' });
  }
};
