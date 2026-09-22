const db = require('../db');

const SEUIL_DEFAUT = 3;

/** Fabrique un slug URL : "Plaquettes avant" + "RENAULT CLIO V" + 42 */
const construireSlug = (piece) => {
  const brut = [piece.description, piece.marque, piece.modele].filter(Boolean).join(' ');
  const slug = brut
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'piece'}-${piece.id}`;
};

const formatPiece = (row) => ({
  ...row,
  prix: row.prix !== null ? Number(row.prix) : null,
  quantite: Number(row.quantite) || 0,
  annee: row.annee !== null ? Number(row.annee) : null,
  seuil_alerte: Number(row.seuil_alerte ?? SEUIL_DEFAUT),
  slug: construireSlug(row),
});

/** Version allégée pour les blocs de rebond */
const formatCarte = (row) => ({
  id: row.id,
  ref: row.ref,
  description: row.description,
  categorie: row.categorie,
  etat: row.etat,
  prix: Number(row.prix) || 0,
  quantite: Number(row.quantite) || 0,
  img_principale: row.img_principale,
  slug: construireSlug(row),
});

// ==========================================================
//  GET /api/piece/:id
//  Renvoie tout ce dont la fiche a besoin en un seul appel
// ==========================================================
exports.getFiche = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Identifiant invalide.' });

    // --- 1. La pièce ---
    const [rows] = await db.query('SELECT * FROM pieces WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Cette pièce n’est plus disponible.' });
    }
    const piece = formatPiece(rows[0]);

    // --- 2. Véhicules compatibles ---
    const [compatibilites] = await db.query(
      `SELECT pc.id, pc.id_modele, pc.annee_min, pc.annee_max, pc.motorisation,
              mo.modele, ma.nom AS marque, ma.id AS id_marque
       FROM piece_compatibilite pc
       JOIN modeles mo ON mo.id = pc.id_modele
       JOIN marques ma ON ma.id = mo.id_marque
       WHERE pc.id_piece = ?
       ORDER BY ma.nom, mo.modele`,
      [id],
    );

    // --- 3. Références (interne, OE, équivalences) ---
    const [references] = await db.query(
      `SELECT id, reference, type, fabricant
       FROM piece_references
       WHERE id_piece = ?
       ORDER BY FIELD(type, 'OE', 'equivalent', 'fournisseur'), reference`,
      [id],
    );

    // --- 4. Autres pièces pour ce véhicule, avec repli en cascade ---
    const autres = await autresPiecesVehicule(id, piece, compatibilites);

    // --- 5. Pièces portant une référence identique ---
    const [equivalences] = await db.query(
      `SELECT DISTINCT p.id, p.ref, p.description, p.categorie, p.etat, p.prix,
              p.quantite, p.img_principale, p.marque, p.modele
       FROM pieces p
       JOIN piece_references pr ON pr.id_piece = p.id
       WHERE p.id <> ?
         AND p.visible_catalogue = 1
         AND pr.reference_norm IN (
           SELECT reference_norm FROM piece_references WHERE id_piece = ?
         )
       LIMIT 6`,
      [id, id],
    );

    res.status(200).json({
      piece,
      compatibilites,
      references,
      autres_vehicule: autres.pieces,
      autres_titre: autres.titre,
      equivalences: equivalences.map(formatCarte),
      images: ['img_principale', 'img1', 'img2', 'img3', 'img4']
        .map((c) => piece[c])
        .filter(Boolean),
    });
  } catch (error) {
    console.error('Erreur fiche pièce :', error);
    res.status(500).json({ message: 'Erreur interne du serveur.', error: error.message });
  }
};

/**
 * Cascade de repli pour ne jamais afficher un bloc vide :
 * même modèle -> même marque -> même catégorie -> derniers ajouts.
 */
async function autresPiecesVehicule(id, piece, compatibilites) {
  const LIMITE = 8;
  const idsModeles = compatibilites.map((c) => c.id_modele);
  const vus = new Set([id]);
  const resultat = [];
  let titre = 'Autres pièces disponibles';

  const ajouter = (rows) => {
    rows.forEach((r) => {
      if (!vus.has(r.id) && resultat.length < LIMITE) {
        vus.add(r.id);
        resultat.push(formatCarte(r));
      }
    });
  };

  const champs = `p.id, p.ref, p.description, p.categorie, p.etat, p.prix,
                  p.quantite, p.img_principale, p.marque, p.modele`;

  // Niveau 1 : les pièces qui vont sur le même modèle
  if (idsModeles.length) {
    const [r1] = await db.query(
      `SELECT DISTINCT ${champs}
       FROM pieces p
       JOIN piece_compatibilite pc ON pc.id_piece = p.id
       WHERE pc.id_modele IN (?) AND p.id <> ? AND p.visible_catalogue = 1
       ORDER BY p.quantite > 0 DESC, p.date_ajout DESC
       LIMIT ?`,
      [idsModeles, id, LIMITE],
    );
    if (r1.length) {
      const premier = compatibilites[0];
      titre = `Autres pièces pour cette ${premier.marque} ${premier.modele}`;
      ajouter(r1);
    }
  }

  // Niveau 2 : même marque de véhicule
  if (resultat.length < LIMITE && compatibilites.length) {
    const idsMarques = [...new Set(compatibilites.map((c) => c.id_marque))];
    const [r2] = await db.query(
      `SELECT DISTINCT ${champs}
       FROM pieces p
       JOIN piece_compatibilite pc ON pc.id_piece = p.id
       JOIN modeles mo ON mo.id = pc.id_modele
       WHERE mo.id_marque IN (?) AND p.id <> ? AND p.visible_catalogue = 1
       ORDER BY p.quantite > 0 DESC, p.date_ajout DESC
       LIMIT ?`,
      [idsMarques, id, LIMITE],
    );
    if (r2.length && !resultat.length) {
      titre = `Autres pièces ${compatibilites[0].marque}`;
    }
    ajouter(r2);
  }

  // Niveau 3 : même catégorie
  if (resultat.length < LIMITE && piece.categorie) {
    const [r3] = await db.query(
      `SELECT ${champs} FROM pieces p
       WHERE p.categorie = ? AND p.id <> ? AND p.visible_catalogue = 1
       ORDER BY p.quantite > 0 DESC, p.date_ajout DESC
       LIMIT ?`,
      [piece.categorie, id, LIMITE],
    );
    if (r3.length && !resultat.length) {
      titre = `Autres pièces de ${piece.categorie}`;
    }
    ajouter(r3);
  }

  // Niveau 4 : derniers ajouts, pour combler
  if (resultat.length < LIMITE) {
    const [r4] = await db.query(
      `SELECT ${champs} FROM pieces p
       WHERE p.id <> ? AND p.visible_catalogue = 1 AND p.quantite > 0
       ORDER BY p.date_ajout DESC
       LIMIT ?`,
      [id, LIMITE],
    );
    ajouter(r4);
  }

  return { pieces: resultat, titre };
}
