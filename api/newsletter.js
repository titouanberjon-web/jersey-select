// Inscription à la newsletter.
// 1) Si RESEND_AUDIENCE_ID est défini, l'email est ajouté à cette audience Resend
//    (liste de contacts avec désinscription gérée par Resend).
// 2) Dans tous les cas, une notification est envoyée à NEWSLETTER_EMAIL_TO
//    (ou ORDER_EMAIL_TO à défaut), pour qu'aucune inscription ne soit perdue.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

async function resend(path, body, idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`https://api.resend.com${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, result };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  // Champ piège invisible : rempli uniquement par les robots.
  if (body.website) {
    return res.status(200).json({ ok: true });
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (body.consent !== true) {
    return res.status(400).json({ error: 'Merci de cocher la case de consentement.' });
  }

  const notifyTo = process.env.NEWSLETTER_EMAIL_TO || process.env.ORDER_EMAIL_TO;
  if (!process.env.RESEND_API_KEY || (!process.env.RESEND_AUDIENCE_ID && !notifyTo)) {
    console.error('Newsletter : RESEND_API_KEY et RESEND_AUDIENCE_ID ou ORDER_EMAIL_TO manquants');
    return res.status(500).json({ error: 'Inscription momentanément indisponible.' });
  }

  let saved = false;

  if (process.env.RESEND_AUDIENCE_ID) {
    const contact = await resend(`/audiences/${encodeURIComponent(process.env.RESEND_AUDIENCE_ID)}/contacts`, {
      email,
      unsubscribed: false
    });
    // 409 / "already exists" : déjà inscrit, ce n'est pas une erreur.
    if (contact.ok || contact.status === 409 || /exist/i.test(JSON.stringify(contact.result))) {
      saved = true;
    } else {
      console.error('Newsletter : ajout audience Resend échoué', contact.status, contact.result);
    }
  }

  if (notifyTo) {
    const subscribedAt = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
    const mail = await resend('/emails', {
      from: 'Jersey Select <onboarding@resend.dev>',
      to: [notifyTo],
      subject: `📬 Nouvelle inscription newsletter : ${email}`,
      html: `<div style="font-family:Arial,sans-serif">
        <p><strong>Nouvel inscrit à la newsletter Jersey Select</strong></p>
        <p>Email : ${esc(email)}<br>Date : ${esc(subscribedAt)}<br>
        Consentement : case cochée sur le site</p>
      </div>`
    }, `newsletter/${email}`);
    if (mail.ok) {
      saved = true;
    } else {
      console.error('Newsletter : email de notification échoué', mail.status, mail.result);
    }
  }

  if (!saved) {
    return res.status(502).json({ error: 'Inscription momentanément indisponible. Réessayez plus tard.' });
  }
  return res.status(200).json({ ok: true });
};

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
