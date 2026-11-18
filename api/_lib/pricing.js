// Règles de prix du panier, partagées par les fonctions serverless.
// À garder synchronisées avec computeCartPricing() dans index.html.
//   - Frais de port : 4,90 € pour toute commande de moins de 3 maillots, offerts dès 3.
//   - Promo : 4 maillots achetés, le 5e offert (le moins cher de chaque lot de 5).

const SHIPPING_FEE_CENTS = 490;
const FREE_SHIPPING_MIN_ITEMS = 3;
const PROMO_GROUP_SIZE = 5;

// amounts : prix unitaires en centimes, dans l'ordre du panier.
function computePricing(amounts) {
  const count = amounts.length;
  const freeCount = Math.floor(count / PROMO_GROUP_SIZE);
  const freeIndexes = new Set(
    amounts
      .map((amount, index) => ({ amount, index }))
      .sort((a, b) => a.amount - b.amount || a.index - b.index)
      .slice(0, freeCount)
      .map(entry => entry.index)
  );
  const subtotal = amounts.reduce((sum, amount) => sum + amount, 0);
  const discount = amounts.reduce((sum, amount, index) => sum + (freeIndexes.has(index) ? amount : 0), 0);
  const shipping = count > 0 && count < FREE_SHIPPING_MIN_ITEMS ? SHIPPING_FEE_CENTS : 0;
  return { freeIndexes, subtotal, discount, shipping, total: subtotal - discount + shipping };
}

module.exports = { computePricing, SHIPPING_FEE_CENTS, FREE_SHIPPING_MIN_ITEMS, PROMO_GROUP_SIZE };
