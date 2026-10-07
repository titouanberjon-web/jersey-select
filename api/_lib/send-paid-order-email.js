function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function money(cents) {
  return (Number(cents || 0) / 100).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function orderItem(lineItem) {
  const product = String(lineItem.description || 'Maillot Jersey Select');
  const details = String(lineItem.price?.product?.description || '');
  const parts = details.split(' — ');
  const nameClub = product.split(' · ');
  return {
    product: nameClub[0] || product,
    club: nameClub.slice(1).join(' · '),
    version: parts[0] || '',
    size: (parts.find(part => /^Taille\s/i.test(part)) || '').replace(/^Taille\s*/i, ''),
    flocage: parts.slice(2).join(' — ') || 'Sans flocage',
    quantity: lineItem.quantity || 1,
    amount: lineItem.amount_total
  };
}

module.exports = async function sendPaidOrderEmail(session, lineItems) {
  if (!process.env.RESEND_API_KEY || !process.env.ORDER_EMAIL_TO) {
    throw new Error('RESEND_API_KEY ou ORDER_EMAIL_TO manquante');
  }

  const metadata = session.metadata || {};
  const customer = session.customer_details || {};
  const name = customer.name || metadata.customerName || 'Client';
  const email = customer.email || metadata.customerEmail || '';
  const phone = customer.phone || metadata.customerPhone || '';
  const reference = metadata.orderReference || session.id;
  const items = lineItems.map(orderItem);
  const rows = items.map(item => `
    <tr>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb">${esc(item.product)}${item.club ? ` · ${esc(item.club)}` : ''}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb">${esc(item.version)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb">${esc(item.size)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb">${esc(item.flocage)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${money(item.amount)} €</td>
    </tr>`).join('');

  const address = customer.address || {};
  const addressLines = [
    session.shipping_details?.name,
    session.shipping_details?.address?.line1 || address.line1,
    session.shipping_details?.address?.line2 || address.line2,
    [session.shipping_details?.address?.postal_code || address.postal_code,
      session.shipping_details?.address?.city || address.city].filter(Boolean).join(' '),
    session.shipping_details?.address?.country || address.country
  ].filter(Boolean);
  const shipping = addressLines.length
    ? `<p><strong>Adresse de livraison :</strong><br>${addressLines.map(esc).join('<br>')}</p>`
    : '<p><strong>Adresse de livraison :</strong> non fournie par Stripe</p>';
  const total = session.amount_total;
  const paidAt = new Date((session.created || Math.floor(Date.now() / 1000)) * 1000)
    .toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:720px;margin:auto;color:#111827">
      <div style="background:#0a0e1a;padding:20px 24px;color:#fff">
        <strong style="color:#00e676;font-size:22px">JERSEY SELECT</strong>
        <span style="float:right">Bon de commande ${esc(reference)}</span>
      </div>
      <div style="padding:24px">
        <h2 style="margin-top:0">Paiement confirmé — commande à préparer</h2>
        <p><strong>Client :</strong> ${esc(name)}<br>
          <strong>Email :</strong> ${esc(email || 'non fourni')}<br>
          ${phone ? `<strong>Téléphone :</strong> ${esc(phone)}<br>` : ''}
          <strong>Payé le :</strong> ${esc(paidAt)}<br>
          <strong>Référence Stripe :</strong> ${esc(session.id)}</p>
        ${shipping}
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead><tr style="background:#f3f4f6">
            <th style="padding:9px 10px;text-align:left">Maillot</th>
            <th style="padding:9px 10px;text-align:left">Version</th>
            <th style="padding:9px 10px;text-align:left">Taille</th>
            <th style="padding:9px 10px;text-align:left">Flocage</th>
            <th style="padding:9px 10px;text-align:right">Montant</th>
          </tr></thead><tbody>${rows}</tbody>
        </table>
        <p style="font-size:18px;text-align:right"><strong>Total payé : ${money(total)} €</strong></p>
        <p style="color:#6b7280;font-size:12px">Ce bon est envoyé automatiquement après confirmation du paiement par Stripe.</p>
      </div>
    </div>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `paid-order/${session.id}`
    },
    body: JSON.stringify({
      from: 'Jersey Select <onboarding@resend.dev>',
      to: [process.env.ORDER_EMAIL_TO],
      subject: `🛒 Commande payée ${reference} — ${name} (${money(total)} €)`,
      html
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Resend ${response.status}: ${JSON.stringify(result)}`);
  }
  return result;
};
