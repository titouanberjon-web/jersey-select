// Règles de prix du panier, partagées par les fonctions serverless.
// À garder synchronisées avec computeCartPricing() dans index.html.
//   - Frais de port : 4,90 € pour toute commande de moins de 3 maillots, offerts dès 3.
//   - Promo : 4 maillots achetés, le 5e offert (le moins cher de chaque lot de 5).
// Les quantités comptent : une ligne « 3 × maillot » vaut 3 maillots.

const SHIPPING_FEE_CENTS = 490;
const FREE_SHIPPING_MIN_ITEMS = 3;
const PROMO_GROUP_SIZE = 5;
const MAX_QUANTITY_PER_LINE = 10;

// lines : [{ amount, quantity }] — prix unitaire en centimes, dans l'ordre du panier.
// freeQuantities[i] = nombre de maillots offerts sur la ligne i.
function computePricing(lines) {
  const units = [];
  lines.forEach((line, index) => {
    for (let n = 0; n < line.quantity; n++) units.push({ amount: line.amount, index });
  });
  const count = units.length;
  const freeCount = Math.floor(count / PROMO_GROUP_SIZE);
  const freeQuantities = lines.map(() => 0);
  units
    .slice()
    .sort((a, b) => a.amount - b.amount || a.index - b.index)
    .slice(0, freeCount)
    .forEach(unit => { freeQuantities[unit.index] += 1; });
  const subtotal = units.reduce((sum, unit) => sum + unit.amount, 0);
  const discount = lines.reduce((sum, line, index) => sum + line.amount * freeQuantities[index], 0);
  const shipping = count > 0 && count < FREE_SHIPPING_MIN_ITEMS ? SHIPPING_FEE_CENTS : 0;
  return { count, freeQuantities, subtotal, discount, shipping, total: subtotal - discount + shipping };
}

module.exports = { computePricing, SHIPPING_FEE_CENTS, FREE_SHIPPING_MIN_ITEMS, PROMO_GROUP_SIZE, MAX_QUANTITY_PER_LINE };
