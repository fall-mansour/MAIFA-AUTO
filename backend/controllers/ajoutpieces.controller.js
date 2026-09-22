const db = require('../db');
const { nettoyerUploads } = require('../cloudinaryConfig');

/** Transforme les chaînes vides du FormData en NULL SQL */
const nn = (v) => (v === undefined || v === null || v === '' ? null : v);

/** Parse un champ FormData contenant du JSON (tableaux envoyés par le front) */
const parseJson = (valeur, defaut = []) => {
  if (!valeur) return defaut;
  if (Array.isArray(valeur)) return valeur;
  try {
    const parse = JSON.parse(valeur);
    return Array.isArray(parse) ? parse : defaut;
  } catch {
    return defaut;
  }
};

/**
 * Retrouve l'id d'un modèle depuis les libellés texte.
 * Filet de sécurité pour l'ancien formulaire, qui envoie encore
 * "Renault" / "Clio 5" au lieu d'un id_modele.
 */
const resoudreModele = async (conn, marque, modele) => {
  if (!marque || !modele) return null;

  const [rows] = await conn.query(
    `SELECT mo.id
     FROM modeles mo
     JOIN marques ma ON ma.id = mo.id_marque
     WHERE ma.nom = TRIM(?)
       AND REPLACE(mo.modele, ' ', '') = REPLACE(TRIM(?), ' ', '')
     LIMIT 1`,
    [marque, modele],
  );

  return rows.length ? rows[0].id : null;
};

// ==========================================================
//  POST /api/pieces/ajouter
// ==========================================================
exports.ajouterPiece = async (req, res) => {
  console.log("--- Tentative d'ajout de pièce via Cloudinary ---");

  const {
    description,
    marque,
    categorie,
    modele,
    annee,
    fournisseur,
    equipementier,
    prix,
    etat,
    quantite,
  } = req.body;

  const reference = nn(req.body.reference ?? req.body.ref);
  const refOe = nn(req.body.ref_oe);
  const sousCategorie = nn(req.body.sous_categorie);

  // Champs structurés, facultatifs tant que le front n'est pas migré :
  //   compatibilites : [{ id_modele, annee_min, annee_max, motorisation }]
  //   references     : [{ reference, type, fabricant }]
  const compatibilites = parseJson(req.body.compatibilites);
  const referencesCroisees = parseJson(req.body.references);

  // 1. Champs obligatoires
  if (!description || !categorie || !prix || !quantite) {
    return res.status(400).json({ message: 'Veuillez remplir tous les champs obligatoires.' });
  }

  if (compatibilites.length === 0 && (!marque || !modele)) {
    return res
      .status(400)
      .json({ message: 'Indiquez au moins un véhicule compatible pour cette pièce.' });
  }

  // 2. Images obligatoires
  if (!req.files || !req.files['img_principale'] || !req.files['img1'] || !req.files['img2']) {
    console.error('❌ Erreur : Images obligatoires manquantes.');
    return res
      .status(400)
      .json({ message: "L'image principale ainsi que les images 1 et 2 sont obligatoires." });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const img_principale = req.files['img_principale'][0].path;
    const img1 = req.files['img1'][0].path;
    const img2 = req.files['img2'][0].path;
    const img3 = req.files['img3'] ? req.files['img3'][0].path : null;
    const img4 = req.files['img4'] ? req.files['img4'][0].path : null;

    // 3. Catégorie texte -> id_categorie (famille générale)
    const [cat] = await conn.query(
      `SELECT id FROM categories
       WHERE (slug = LOWER(TRIM(?)) OR nom = TRIM(?)) AND id_parent IS NULL
       LIMIT 1`,
      [categorie, categorie],
    );
    const idCategorie = cat.length ? cat[0].id : null;

    // 4. Sous-catégorie : on vérifie qu'elle appartient bien à la famille choisie.
    //    Sinon on l'ignore, plutôt que d'enregistrer une incohérence.
    let idSousCategorie = null;
    if (sousCategorie && idCategorie) {
      const [sous] = await conn.query(
        `SELECT id FROM categories
         WHERE (slug = LOWER(TRIM(?)) OR id = ?) AND id_parent = ?
         LIMIT 1`,
        [sousCategorie, Number(sousCategorie) || 0, idCategorie],
      );
      idSousCategorie = sous.length ? sous[0].id : null;

      if (!idSousCategorie) {
        console.warn(`⚠️ Sous-catégorie "${sousCategorie}" hors de la famille, ignorée.`);
      }
    }

    // 5. Insertion de la pièce
    const [result] = await conn.query(
      `INSERT INTO pieces
        (description, marque, categorie, id_categorie, id_sous_categorie, modele, annee,
         fournisseur, equipementier, prix, etat, quantite, ref, ref_oe,
         img_principale, img1, img2, img3, img4)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        description,
        nn(marque),
        categorie,
        idCategorie,
        idSousCategorie,
        nn(modele),
        nn(annee),
        nn(fournisseur),
        nn(equipementier),
        prix,
        nn(etat),
        quantite,
        reference,
        refOe,
        img_principale,
        img1,
        img2,
        img3,
        img4,
      ],
    );

    const idPiece = result.insertId;

    // 6. Compatibilités véhicules
    let lignesCompat = compatibilites;

    if (lignesCompat.length === 0) {
      const idModele = await resoudreModele(conn, marque, modele);
      if (!idModele) {
        await conn.rollback();
        await nettoyerUploads(req.files);
        return res.status(400).json({
          message: `Le véhicule "${marque} ${modele}" ne figure pas dans le référentiel. Choisissez un modèle dans la liste.`,
        });
      }
      lignesCompat = [{ id_modele: idModele, annee_min: nn(annee), annee_max: nn(annee) }];
    }

    for (const c of lignesCompat) {
      await conn.query(
        `INSERT IGNORE INTO piece_compatibilite
           (id_piece, id_modele, annee_min, annee_max, motorisation)
         VALUES (?, ?, ?, ?, ?)`,
        [idPiece, c.id_modele, nn(c.annee_min), nn(c.annee_max), nn(c.motorisation)],
      );
    }

    // 7. Références croisées
    const toutesRefs = [...referencesCroisees];
    if (reference) toutesRefs.push({ reference, type: 'fournisseur', fabricant: nn(fournisseur) });
    if (refOe) toutesRefs.push({ reference: refOe, type: 'OE', fabricant: nn(marque) });

    for (const r of toutesRefs) {
      if (!r.reference) continue;
      await conn.query(
        `INSERT IGNORE INTO piece_references (id_piece, reference, type, fabricant, source)
         VALUES (?, ?, ?, ?, 'saisie')`,
        [idPiece, String(r.reference).trim(), r.type || 'equivalent', nn(r.fabricant)],
      );
    }

    await conn.commit();

    console.log(`✅ Pièce ${idPiece} enregistrée — ${lignesCompat.length} compatibilité(s)`);
    res.status(201).json({
      message: 'Pièce ajoutée avec succès !',
      id: idPiece,
      ref: reference,
      sous_categorie: idSousCategorie,
      compatibilites: lignesCompat.length,
      references: toutesRefs.length,
      url_principale: img_principale,
    });
  } catch (error) {
    await conn.rollback();

    // La ligne SQL n'existe plus : on retire les images envoyées à Cloudinary
    await nettoyerUploads(req.files);

    if (error.code === 'ER_DUP_ENTRY') {
      console.error('❌ Référence déjà utilisée :', reference);
      return res
        .status(409)
        .json({ message: `La référence ${reference} existe déjà pour une autre pièce.` });
    }

    console.error("❌ ERREUR lors de l'insertion Cloudinary/SQL :", error);
    res.status(500).json({ message: 'Erreur interne du serveur.', error: error.message });
  } finally {
    conn.release();
  }
};

// ==========================================================
//  POST /api/pieces/:id/compatibilites
//  Ajouter un véhicule compatible à une pièce existante
// ==========================================================
exports.ajouterCompatibilite = async (req, res) => {
  try {
    const { id_modele, annee_min, annee_max, motorisation } = req.body;

    if (!id_modele) {
      return res.status(400).json({ message: 'Le modèle est obligatoire.' });
    }

    await db.query(
      `INSERT IGNORE INTO piece_compatibilite
         (id_piece, id_modele, annee_min, annee_max, motorisation)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, id_modele, nn(annee_min), nn(annee_max), nn(motorisation)],
    );

    res.status(201).json({ message: 'Compatibilité ajoutée.' });
  } catch (error) {
    console.error('Erreur ajout compatibilité:', error);
    res.status(500).json({ message: "Erreur lors de l'ajout", error: error.message });
  }
};

// ==========================================================
//  DELETE /api/pieces/compatibilites/:id
// ==========================================================
exports.supprimerCompatibilite = async (req, res) => {
  try {
    const [r] = await db.query('DELETE FROM piece_compatibilite WHERE id = ?', [req.params.id]);
    if (r.affectedRows === 0) {
      return res.status(404).json({ message: 'Compatibilité introuvable.' });
    }
    res.status(200).json({ message: 'Compatibilité retirée.' });
  } catch (error) {
    console.error('Erreur suppression compatibilité:', error);
    res.status(500).json({ message: 'Erreur lors de la suppression', error: error.message });
  }
};
