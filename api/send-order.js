// Fonction serverless Vercel : envoie le bon de commande par email via Resend.
// Variables d'environnement requises (Vercel → Settings → Environment Variables) :
//   RESEND_API_KEY  — clé API Resend
//   ORDER_EMAIL_TO  — adresse email qui reçoit les commandes

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!process.env.RESEND_API_KEY || !process.env.ORDER_EMAIL_TO) {
    return res.status(500).json({ error: 'Variables RESEND_API_KEY / ORDER_EMAIL_TO non configurées sur Vercel' });
  }

  const { orderNumber, name, email, phone, items, total, pdfBase64 } = req.body || {};

  if (!orderNumber || !name || !Array.isArray(items) || !items.length || typeof total !== 'number') {
    return res.status(400).json({ error: 'Données de commande manquantes ou invalides' });
  }
  // Garde-fou : ~3 Mo de PDF max (limite corps de requête Vercel : 4,5 Mo)
  if (pdfBase64 && pdfBase64.length > 4_000_000) {
    return res.status(413).json({ error: 'PDF trop volumineux' });
  }

  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escHtml(i.product)} · ${escHtml(i.club)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escHtml(i.version)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escHtml(i.size)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escHtml(i.flocage)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${escHtml(i.price)} €</td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#0a0e1a;padding:20px 24px;">
      <span style="color:#00e676;font-size:22px;font-weight:bold;">JERSEY SELECT</span>
      <span style="color:#fff;float:right;font-size:14px;line-height:28px;">Commande ${escHtml(orderNumber)}</span>
    </div>
    <div style="padding:24px;">
      <p><strong>Client :</strong> ${escHtml(name)}<br>
      <strong>Email :</strong> ${escHtml(email)}<br>
      ${phone ? `<strong>Téléphone :</strong> ${escHtml(phone)}<br>` : ''}
      <strong>Date :</strong> ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;text-align:left;">Maillot</th>
          <th style="padding:8px 12px;text-align:left;">Version</th>
          <th style="padding:8px 12px;text-align:left;">Taille</th>
          <th style="padding:8px 12px;text-align:left;">Flocage</th>
          <th style="padding:8px 12px;text-align:right;">Prix</th>
        </tr>
        ${rows}
      </table>
      <p style="font-size:18px;text-align:right;"><strong>Total : <span style="color:#00a050;">${escHtml(total)} €</span></strong></p>
      <p style="color:#888;font-size:12px;">Le bon de commande PDF est en pièce jointe. Le client va aussi te contacter sur WhatsApp.</p>
    </div>
  </div>`;

  const payload = {
    from: 'Jersey Select <onboarding@resend.dev>',
    to: [process.env.ORDER_EMAIL_TO],
    subject: `🛒 Commande ${orderNumber} — ${name} (${total} €)`,
    html,
  };
  if (pdfBase64) {
    payload.attachments = [{ filename: `bon-de-commande-${orderNumber}.pdf`, content: pdfBase64 }];
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Erreur Resend:', r.status, JSON.stringify(data));
      return res.status(502).json({ error: 'Envoi email refusé par Resend', details: data });
    }
    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    console.error('Erreur envoi email:', e);
    return res.status(500).json({ error: 'Erreur interne lors de l\'envoi de l\'email' });
  }
};
