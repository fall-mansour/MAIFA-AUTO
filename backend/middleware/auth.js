const jwt = require('jsonwebtoken');

// ⚠️ À définir dans le .env : une chaîne longue et aléatoire.
// Si elle change, tous les jetons émis deviennent invalides.
const SECRET = process.env.JWT_SECRET || 'teranga_secret_a_remplacer_absolument';
const DUREE = process.env.JWT_DUREE || '2h';

/**
 * Liste blanche des gestionnaires, definie dans le .env :
 *
 *   GESTIONNAIRES_AUTORISES=a@b.com,c@d.com,e@f.com
 *
 * Elle double le controle du role stocke en base. Interet reel :
 * si quelqu'un parvenait a modifier la colonne `role` d'un compte,
 * la liste bloquerait quand meme l'acces. Et une liste dans le .env
 * s'ajuste sans toucher au code ni redeployer.
 *
 * Liste vide = controle desactive, seul le role en base fait foi.
 */
const GESTIONNAIRES = (process.env.GESTIONNAIRES_AUTORISES || '')
  .split(',')
  .map((m) => m.trim().toLowerCase())
  .filter(Boolean);

/** L'adresse figure-t-elle dans la liste blanche ? */
const estGestionnaireAutorise = (mail) => {
  if (GESTIONNAIRES.length === 0) return true; // controle desactive
  return GESTIONNAIRES.includes(
    String(mail || '')
      .trim()
      .toLowerCase(),
  );
};

/**
 * Role reellement accorde : le role en base ET la liste blanche
 * doivent concorder. Un compte marque gestionnaire hors liste est
 * traite comme un client, et l'anomalie est signalee.
 */
const roleEffectif = (user) => {
  const role = user.role || 'client';
  if (role !== 'gestionnaire') return 'client';

  if (!estGestionnaireAutorise(user.mail)) {
    console.warn(
      `🚨 ALERTE : le compte ${user.mail} porte le role gestionnaire ` +
        `mais ne figure pas dans GESTIONNAIRES_AUTORISES. Acces refuse.`,
    );
    return 'client';
  }

  return 'gestionnaire';
};

/** Génère un jeton pour un utilisateur */
const signerJeton = (user) =>
  jwt.sign(
    {
      id: user.id,
      mail: user.mail,
      role: roleEffectif(user),
    },
    SECRET,
    { expiresIn: DUREE },
  );

/** Date d'expiration en millisecondes, transmise au front pour l'affichage */
const expirationJeton = (token) => {
  try {
    const { exp } = jwt.decode(token);
    return exp ? exp * 1000 : null;
  } catch {
    return null;
  }
};

/**
 * Vérifie le jeton présent dans l'en-tête Authorization.
 * Place les informations de l'utilisateur dans req.utilisateur.
 */
const verifierJeton = (req, res, next) => {
  const entete = req.headers.authorization || '';
  const token = entete.startsWith('Bearer ') ? entete.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentification requise.', code: 'JETON_ABSENT' });
  }

  try {
    req.utilisateur = jwt.verify(token, SECRET);
    next();
  } catch (error) {
    // Le front distingue les deux cas : expiré = reconnexion, invalide = déconnexion
    const expire = error.name === 'TokenExpiredError';
    return res.status(401).json({
      message: expire ? 'Session expirée, reconnectez-vous.' : 'Session invalide.',
      code: expire ? 'JETON_EXPIRE' : 'JETON_INVALIDE',
    });
  }
};

/**
 * Restreint l'accès à certains rôles.
 * Exemple : router.get('/', verifierJeton, exigerRole('gestionnaire'), ctrl.liste)
 */
const exigerRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.utilisateur) {
      return res.status(401).json({ message: 'Authentification requise.', code: 'JETON_ABSENT' });
    }
    if (!roles.includes(req.utilisateur.role)) {
      return res.status(403).json({ message: 'Accès réservé.', code: 'ROLE_INSUFFISANT' });
    }

    // Second controle sur la liste blanche : un jeton emis avant un
    // retrait de la liste resterait sinon valable jusqu'a son echeance
    if (roles.includes('gestionnaire') && !estGestionnaireAutorise(req.utilisateur.mail)) {
      console.warn(`🚨 Jeton gestionnaire hors liste blanche : ${req.utilisateur.mail}`);
      return res.status(403).json({ message: 'Accès réservé.', code: 'ROLE_INSUFFISANT' });
    }

    next();
  };

/**
 * Jeton facultatif : renseigne req.utilisateur s'il est valide,
 * mais laisse passer les visiteurs sans compte.
 * Utile pour la validation du panier, ouverte aux invités.
 */
const jetonFacultatif = (req, res, next) => {
  const entete = req.headers.authorization || '';
  const token = entete.startsWith('Bearer ') ? entete.slice(7) : null;

  if (token) {
    try {
      req.utilisateur = jwt.verify(token, SECRET);
    } catch {
      req.utilisateur = null;
    }
  }
  next();
};

module.exports = {
  signerJeton,
  expirationJeton,
  verifierJeton,
  exigerRole,
  jetonFacultatif,
  estGestionnaireAutorise,
  roleEffectif,
  GESTIONNAIRES,
};
