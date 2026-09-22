const nodemailer = require('nodemailer');

// ============================================================
//  CONFIGURATION
//  Les identifiants viennent du .env, jamais du code :
//
//    MAIL_USER=adresse@gmail.com
//    MAIL_PASS=xxxx xxxx xxxx xxxx     (mot de passe d'application)
//    MAIL_DESTINATAIRE=adresse@gmail.com
//    LOGO_URL=https://res.cloudinary.com/.../logo-horizontal.png   (facultatif)
// ============================================================

const MAIL_USER = process.env.MAIL_USER;
const MAIL_PASS = process.env.MAIL_PASS;
const DESTINATAIRE = process.env.MAIL_DESTINATAIRE || MAIL_USER;
const LOGO_URL = process.env.LOGO_URL || '';

// Transporteur cree une seule fois, et non a chaque requete
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: MAIL_USER, pass: MAIL_PASS },
});

// ============================================================
//  PALETTE DU LOGO
//  Les clients mail ignorent les feuilles de style : tout est
//  ecrit en attributs style, et la mise en page utilise des
//  tableaux, seule structure fiable dans Gmail et Outlook.
// ============================================================
const C = {
  navy: '#12314B',
  navy900: '#081724',
  navy600: '#1B4A6F',
  orange: '#F2762E',
  orange700: '#C25317',
  orange50: '#FFF4ED',
  texte: '#12314B',
  dim: '#435A76',
  mute: '#647489',
  ligne: '#DFE5EE',
  fond: '#F6F8FB',
};

/**
 * Echappe les caracteres HTML.
 * Sans cela, un visiteur qui ecrit <a href="..."> dans la
 * description glisse un lien dans le mail que tu recois.
 */
const echapper = (valeur) =>
  String(valeur ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Conserve les retours a la ligne de la description */
const paragraphes = (texte) => echapper(texte).replace(/\r?\n/g, '<br>');

/** Numero au format international pour les liens tel: et WhatsApp */
const numeroInternational = (tel) => {
  const chiffres = String(tel || '').replace(/\D/g, '');
  if (!chiffres) return '';
  return chiffres.startsWith('221') ? chiffres : `221${chiffres}`;
};

/** Une ligne libelle / valeur du tableau d'informations */
const ligneInfo = (libelle, valeur) => `
  <tr>
    <td style="padding:9px 0;border-bottom:1px solid ${C.ligne};font-size:13px;color:${C.mute};width:130px;vertical-align:top;">
      ${libelle}
    </td>
    <td style="padding:9px 0;border-bottom:1px solid ${C.ligne};font-size:14px;color:${C.texte};font-weight:600;">
      ${valeur || '<span style="color:' + C.mute + ';font-weight:400;">Non renseigné</span>'}
    </td>
  </tr>`;

/**
 * En-tete de marque. Sans logo heberge, on reproduit le mot-symbole
 * en texte : MAIFA en bleu nuit, AUTO en orange, comme sur le logo.
 * Une image locale serait invisible pour le destinataire.
 */
const entete = () =>
  LOGO_URL
    ? `<img src="${LOGO_URL}" alt="MAIFA-AUTO" height="40" style="display:block;height:40px;border:0;">`
    : `<span style="font-size:26px;font-weight:800;letter-spacing:-0.5px;">
         <span style="color:#FFFFFF;">MAIFA</span><span style="color:${C.orange};">-AUTO</span>
       </span>`;

/** Gabarit complet du mail recu par le gestionnaire */
const gabaritDemande = (d) => {
  const intl = numeroInternational(d.telephone);
  const vehicule = [d.marque, d.modele].filter(Boolean).join(' ');
  const messageWa = encodeURIComponent(
    `Bonjour ${d.nom}, MAIFA-AUTO au sujet de votre demande de pièce pour ${vehicule}.`,
  );

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nouvelle demande de pièce</title>
</head>
<body style="margin:0;padding:0;background:${C.fond};font-family:Arial,Helvetica,sans-serif;">

  <!-- Apercu affiche dans la liste des mails -->
  <div style="display:none;max-height:0;overflow:hidden;">
    ${echapper(d.nom)} recherche une pièce pour ${echapper(vehicule)}.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.fond};padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="max-width:600px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid ${C.ligne};">

          <!-- EN-TETE BLEU NUIT -->
          <tr>
            <td style="background:${C.navy900};background-image:linear-gradient(135deg,${C.navy900},${C.navy} 60%,${C.navy600});padding:26px 30px;">
              ${entete()}
            </td>
          </tr>

          <!-- BANDEAU ORANGE -->
          <tr>
            <td style="height:4px;line-height:4px;font-size:0;background:${C.orange};">&nbsp;</td>
          </tr>

          <!-- TITRE -->
          <tr>
            <td style="padding:28px 30px 8px;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${C.orange700};">
                Nouvelle demande de pièce
              </p>
              <h1 style="margin:0;font-size:22px;line-height:1.3;color:${C.navy};">
                ${echapper(d.nom)} recherche une pièce
              </h1>
            </td>
          </tr>

          <!-- VEHICULE EN AVANT -->
          <tr>
            <td style="padding:16px 30px 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                     style="background:${C.orange50};border:1px solid #F8C9A8;border-radius:10px;">
                <tr>
                  <td style="padding:16px 18px;">
                    <p style="margin:0;font-size:12px;color:${C.orange700};font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">
                      Véhicule concerné
                    </p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:800;color:${C.navy};">
                      ${echapper(vehicule) || 'Non précisé'}
                      ${d.annee ? `<span style="font-weight:600;color:${C.dim};"> · ${echapper(d.annee)}</span>` : ''}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- DESCRIPTION DU BESOIN -->
          <tr>
            <td style="padding:22px 30px 6px;">
              <h2 style="margin:0 0 10px;font-size:15px;color:${C.navy};">Description du besoin</h2>
              <div style="background:${C.fond};border-left:4px solid ${C.orange};border-radius:6px;padding:14px 16px;font-size:14px;line-height:1.6;color:${C.texte};">
                ${paragraphes(d.description) || '<em style="color:' + C.mute + ';">Aucune description fournie</em>'}
              </div>
            </td>
          </tr>

          <!-- COORDONNEES -->
          <tr>
            <td style="padding:22px 30px 8px;">
              <h2 style="margin:0 0 6px;font-size:15px;color:${C.navy};">Coordonnées du client</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${ligneInfo('Nom', echapper(d.nom))}
                ${ligneInfo('Email', d.email ? `<a href="mailto:${echapper(d.email)}" style="color:${C.orange700};text-decoration:none;">${echapper(d.email)}</a>` : '')}
                ${ligneInfo('Téléphone', echapper(d.telephone))}
              </table>
            </td>
          </tr>

          <!-- ACTIONS RAPIDES -->
          ${
            intl
              ? `
          <tr>
            <td style="padding:20px 30px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:10px;">
                    <a href="https://wa.me/${intl}?text=${messageWa}"
                       style="display:inline-block;padding:12px 22px;border-radius:99px;background:#25D366;color:#FFFFFF;font-size:14px;font-weight:700;text-decoration:none;">
                      Répondre sur WhatsApp
                    </a>
                  </td>
                  <td>
                    <a href="tel:+${intl}"
                       style="display:inline-block;padding:12px 22px;border-radius:99px;background:${C.orange};color:${C.navy900};font-size:14px;font-weight:700;text-decoration:none;">
                      Appeler le client
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
              : ''
          }

          <!-- PIED -->
          <tr>
            <td style="padding:26px 30px 28px;">
              <p style="margin:0;padding-top:18px;border-top:1px solid ${C.ligne};font-size:12px;line-height:1.5;color:${C.mute};">
                Mail généré automatiquement depuis le formulaire de demande MAIFA-AUTO.
                Cliquer sur « Répondre » écrit directement au client.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/** Version texte, pour les clients qui n'affichent pas le HTML */
const texteDemande = (d) =>
  [
    'NOUVELLE DEMANDE DE PIECE — MAIFA-AUTO',
    '',
    `Client     : ${d.nom}`,
    `Email      : ${d.email || 'non renseigné'}`,
    `Téléphone  : ${d.telephone || 'non renseigné'}`,
    `Véhicule   : ${[d.marque, d.modele].filter(Boolean).join(' ')} ${d.annee ? '(' + d.annee + ')' : ''}`,
    '',
    'Description :',
    d.description || 'aucune',
  ].join('\n');

// ============================================================
//  POST /api/demande
// ============================================================
exports.envoyerDemande = async (req, res) => {
  const { nom, email, telephone, marque, modele, annee, description } = req.body;

  // Configuration absente : on le dit clairement plutot que d'echouer en silence
  if (!MAIL_USER || !MAIL_PASS) {
    console.error('❌ MAIL_USER ou MAIL_PASS absent du .env');
    return res.status(500).json({ error: 'Service de messagerie non configuré.' });
  }

  if (!nom || !description || (!email && !telephone)) {
    return res.status(400).json({
      error: 'Le nom, la description et un moyen de contact sont obligatoires.',
    });
  }

  const donnees = { nom, email, telephone, marque, modele, annee, description };
  const vehicule = [marque, modele].filter(Boolean).join(' ') || 'véhicule non précisé';

  const mailOptions = {
    // L'expediteur reste TON compte : Gmail le reecrit de toute facon,
    // et usurper l'adresse du client fait echouer les controles
    // anti-usurpation, ce qui envoie tes propres mails en spam.
    from: `"MAIFA-AUTO · Demandes" <${MAIL_USER}>`,
    to: DESTINATAIRE,
    // Repondre ecrit directement au client
    replyTo: email || undefined,
    // Le sujet est du texte brut : les retours a la ligne sont retires
    // pour eviter toute injection d'en-tete
    subject: `Demande de pièce : ${String(vehicule)
      .replace(/[\r\n]/g, ' ')
      .toUpperCase()} — ${String(nom).replace(/[\r\n]/g, ' ')}`,
    html: gabaritDemande(donnees),
    text: texteDemande(donnees),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Demande envoyée pour ${nom} (${vehicule})`);
    res.status(200).json({ message: 'Demande envoyée avec succès' });
  } catch (error) {
    console.error('❌ Erreur Nodemailer :', error.message);
    res.status(500).json({ error: "Impossible d'envoyer l'e-mail" });
  }
};

// Exporte pour pouvoir previsualiser le gabarit sans envoyer de mail
exports._gabaritDemande = gabaritDemande;
