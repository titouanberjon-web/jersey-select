// Les commandes payées sont envoyées uniquement depuis le webhook Stripe signé.
module.exports = (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
  return res.status(410).json({ error: 'Les commandes payées sont désormais traitées par le webhook Stripe.' });
};
