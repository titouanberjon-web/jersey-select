const crypto = require('crypto');
const admin = require('firebase-admin');

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const RESEND_DELAY_MS = 60 * 1000;
const DAILY_SEND_LIMIT = 10;
const MAX_ATTEMPTS = 5;

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON manquante');
  const serviceAccount = JSON.parse(raw);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}

function hash(value) {
  return crypto.createHmac('sha256', process.env.ACCOUNT_CODE_SECRET).update(value).digest('hex');
}

function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function normalizeChanges(body) {
  const newEmail = String(body.newEmail || '').trim().toLowerCase();
  const newPassword = String(body.newPassword || '');
  if (newEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) || newEmail.length > 100)) {
    throw new Error('Adresse email invalide.');
  }
  if (newPassword && (newPassword.length < 6 || newPassword.length > 100)) {
    throw new Error('Le nouveau mot de passe doit contenir entre 6 et 100 caractères.');
  }
  if (!newEmail && !newPassword) throw new Error('Aucun changement demandé.');
  if (newEmail && newPassword) throw new Error('Modifie une seule information à la fois, puis recommence pour l’autre.');
  return { newEmail, newPassword };
}

async function sendCode(authUser, changes, db) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const ref = db.collection('accountSecurityCodes').doc(authUser.uid);
  const limitRef = db.collection('accountSecurityLimits').doc(authUser.uid);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const changesHash = hash(JSON.stringify(changes));

  await db.runTransaction(async (tx) => {
    const [challengeSnap, limitSnap] = await Promise.all([tx.get(ref), tx.get(limitRef)]);
    const challenge = challengeSnap.exists ? challengeSnap.data() : {};
    const previousLimit = limitSnap.exists ? limitSnap.data() : {};
    const count = previousLimit.day === day ? Number(previousLimit.sentToday || 0) : 0;
    if (challenge.expiresAt?.toMillis?.() > now && now - Number(previousLimit.sentAt || 0) < RESEND_DELAY_MS) {
      throw new Error('Attends une minute avant de demander un autre code.');
    }
    if (count >= DAILY_SEND_LIMIT) throw new Error('Limite de 10 codes par jour atteinte. Réessaie demain.');
    tx.set(ref, {
      codeHash: hash(`${authUser.uid}:${code}`),
      changesHash,
      expiresAt: admin.firestore.Timestamp.fromMillis(now + CODE_LIFETIME_MS),
      attempts: 0
    });
    tx.set(limitRef, { day, sentToday: count + 1, sentAt: now });
  });

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `account-security/${authUser.uid}/${now}`
    },
    body: JSON.stringify({
      from: process.env.ACCOUNT_SECURITY_FROM_EMAIL,
      to: [authUser.email],
      subject: 'Ton code de sécurité Jersey Select',
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#111827"><h2>Confirmation de sécurité</h2><p>Voici le code demandé pour modifier les informations de ton compte Jersey Select :</p><p style="font-size:30px;font-weight:bold;letter-spacing:8px">${code}</p><p>Ce code expire dans 10 minutes. Si tu n’es pas à l’origine de cette demande, ignore cet email et change ton mot de passe.</p></div>`
    })
  });
    await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Échec Resend pour un code de sécurité:', response.status);
    throw new Error('L’email n’a pas pu être envoyé. Réessaie plus tard.');
  }
}

async function confirmCode(authUser, changes, code, db) {
  if (!/^\d{6}$/.test(code)) throw new Error('Code invalide ou expiré.');
  const ref = db.collection('accountSecurityCodes').doc(authUser.uid);
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'missing';
    const challenge = snap.data();
    if (challenge.expiresAt.toMillis() <= Date.now() || challenge.attempts >= MAX_ATTEMPTS) {
      tx.delete(ref);
      return 'expired';
    }
    const correct = sameHash(challenge.codeHash, hash(`${authUser.uid}:${code}`));
    const sameChanges = sameHash(challenge.changesHash, hash(JSON.stringify(changes)));
    if (!correct || !sameChanges) {
      tx.update(ref, {
        attempts: admin.firestore.FieldValue.increment(1),
        ...(correct ? { attempts: MAX_ATTEMPTS } : {})
      });
      return correct ? 'changes' : 'wrong';
    }
    tx.delete(ref);
    return 'valid';
  });
  if (outcome === 'missing') throw new Error('Code invalide ou expiré. Demande-en un nouveau.');
  if (outcome === 'expired') throw new Error('Code expiré ou trop de tentatives. Demande-en un nouveau.');
  if (outcome === 'changes') throw new Error('Les changements demandés ont changé. Demande un nouveau code.');
  if (outcome === 'wrong') throw new Error('Code incorrect.');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });
  if (!process.env.ACCOUNT_CODE_SECRET || process.env.ACCOUNT_CODE_SECRET.length < 32) {
    return res.status(500).json({ error: 'La confirmation sécurisée par email n’est pas encore configurée.' });
  }
  if (!process.env.RESEND_API_KEY || !process.env.ACCOUNT_SECURITY_FROM_EMAIL) {
    return res.status(500).json({ error: 'L’envoi des emails de sécurité n’est pas encore configuré.' });
  }

  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Reconnecte-toi pour continuer.' });
    const fb = getFirebaseAdmin();
    const authUser = await fb.auth().verifyIdToken(token, true);
    if (!authUser.email || Date.now() / 1000 - authUser.auth_time > 300) {
      return res.status(401).json({ error: 'Reconnecte-toi avec ton mot de passe puis recommence.' });
    }
    const changes = normalizeChanges(req.body || {});
    if (changes.newEmail && changes.newEmail === authUser.email.toLowerCase()) {
      return res.status(400).json({ error: 'Cette adresse est déjà utilisée par ton compte.' });
    }
    const db = fb.firestore();

    if (req.body.action === 'request') {
      await sendCode(authUser, changes, db);
      return res.status(200).json({ sent: true });
    }
    if (req.body.action !== 'verify') return res.status(400).json({ error: 'Action inconnue.' });
    await confirmCode(authUser, changes, String(req.body.code || ''), db);
    if (changes.newPassword) await fb.auth().updateUser(authUser.uid, { password: changes.newPassword });
    return res.status(200).json({ verified: true, passwordChanged: Boolean(changes.newPassword) });
  } catch (error) {
    const clientError = /^(Attends|Limite|Code|Les changements|Adresse|Le nouveau|Aucun|Modifie)/.test(error.message || '');
    if (!clientError) console.error('Erreur API sécurité du compte:', error.message);
    return res.status(clientError ? 400 : 500).json({ error: clientError ? error.message : 'Une erreur est survenue. Réessaie plus tard.' });
  }
};
