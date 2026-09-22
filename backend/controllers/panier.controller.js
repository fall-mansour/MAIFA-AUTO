const db = require('../db');

const MODES_PAIEMENT = ['livraison', 'wave', 'om'];

/** Chaîne vide -> NULL */
const nn = (v) =>
  v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();

// ==========================================================
//  POST /api/panier/verifier
//  Contrôle la disponibilité et les prix AVANT le formulaire.
//  Le client envoie seulement des id et des quantités.
// ==========================================================
exports.verifierPanier = async (req, res) => {
  try {
    const articles = Array.isArray(req.body.articles) ? req.body.articles : [];
    if (articles.length === 0) {
      return res.status(400).json({ message: 'Le panier est vide.' });
    }

    const ids = [...new Set(articles.map((a) => Number(a.id_piece)).filter(Boolean))];
    if (ids.length === 0) {
      return res.status(400).json({ message: 'Aucune pièce valide dans le panier.' });
    }

    const [rows] = await db.query(
      `SELECT id, description, ref, marque, modele, etat, prix, quantite,
              img_principale, visible_catalogue
       FROM pieces WHERE id IN (?)`,
      [ids],
    );
    const parId = new Map(rows.map((r) => [r.id, r]));

    let total = 0;
    const lignes = articles.map((a) => {
      const id = Number(a.id_piece);
      const demandee = Math.max(1, Number(a.quantite) || 1);
      const p = parId.get(id);

      if (!p || !p.visible_catalogue) {
        return {
          id_piece: id,
          disponible: false,
          probleme: 'retiree',
          message: 'Cette pièce n’est plus au catalogue.',
        };
      }

      const stock = Number(p.quantite) || 0;
      const prix = Number(p.prix) || 0;
      const quantite = Math.min(demandee, stock);
      const montant = prix * quantite;
      total += montant;

      return {
        id_piece: id,
        designation: p.description,
        ref: p.ref,
        vehicule: [p.marque, p.modele].filter(Boolean).join(' '),
        etat: p.etat,
        img_principale: p.img_principale,
        prix_unitaire: prix,
        quantite,
        quantite_demandee: demandee,
        stock,
        montant,
        disponible: stock > 0,
        probleme: stock === 0 ? 'rupture' : demandee > stock ? 'stock_insuffisant' : null,
        message:
          stock === 0
            ? 'Cette pièce vient d’être vendue.'
            : demandee > stock
              ? `Il ne reste que ${stock} unité${stock > 1 ? 's' : ''}.`
              : null,
      };
    });

    res.status(200).json({
      lignes,
      total,
      nb_articles: lignes.reduce((s, l) => s + (l.quantite || 0), 0),
      tout_disponible: lignes.every((l) => l.disponible && !l.probleme),
    });
  } catch (error) {
    console.error('❌ Erreur vérification panier :', error);
    res.status(500).json({ message: 'Erreur lors de la vérification du panier.' });
  }
};

// ==========================================================
//  POST /api/panier/valider
//  Crée la commande et décrémente le stock, en une transaction.
//  Le prix vient TOUJOURS de la base, jamais du navigateur.
// ==========================================================
exports.validerPanier = async (req, res) => {
  const { articles, client, mode_paiement, id_user } = req.body;

  // --- 1. Validations de forme ---
  if (!Array.isArray(articles) || articles.length === 0) {
    return res.status(400).json({ message: 'Le panier est vide.' });
  }

  if (!client || !nn(client.nom) || !nn(client.telephone)) {
    return res.status(400).json({ message: 'Le nom et le téléphone sont obligatoires.' });
  }

  const mode = MODES_PAIEMENT.includes(mode_paiement) ? mode_paiement : 'livraison';

  // Le paiement en ligne exige un compte : il demande une traçabilité
  if (mode !== 'livraison' && !id_user) {
    return res.status(403).json({
      message: 'Le paiement en ligne nécessite un compte. Choisissez le paiement à la livraison.',
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const ids = [...new Set(articles.map((a) => Number(a.id_piece)).filter(Boolean))];

    // --- 2. Verrouillage des lignes le temps de la transaction ---
    // Empêche deux clients de commander la même pièce simultanément
    const [pieces] = await conn.query(
      `SELECT id, description, ref, marque, modele, etat, prix, quantite,
              img_principale, visible_catalogue
       FROM pieces WHERE id IN (?) FOR UPDATE`,
      [ids],
    );
    const parId = new Map(pieces.map((p) => [p.id, p]));

    // --- 3. Contrôle de disponibilité et calcul du total côté serveur ---
    const lignes = [];
    const conflits = [];
    let total = 0;
    let nbArticles = 0;

    for (const a of articles) {
      const id = Number(a.id_piece);
      const demandee = Math.max(1, Number(a.quantite) || 1);
      const p = parId.get(id);

      if (!p || !p.visible_catalogue) {
        conflits.push({ id_piece: id, message: 'Pièce retirée du catalogue.' });
        continue;
      }

      const stock = Number(p.quantite) || 0;
      if (stock < demandee) {
        conflits.push({
          id_piece: id,
          designation: p.description,
          stock,
          demandee,
          message:
            stock === 0
              ? `« ${p.description} » vient d’être vendue.`
              : `« ${p.description} » : il ne reste que ${stock} unité${stock > 1 ? 's' : ''}.`,
        });
        continue;
      }

      const prix = Number(p.prix) || 0;
      const montant = prix * demandee;
      total += montant;
      nbArticles += demandee;

      lignes.push([
        null, // id_commande, complété plus bas
        id,
        p.description,
        p.ref,
        [p.marque, p.modele].filter(Boolean).join(' ') || null,
        p.etat,
        p.img_principale,
        prix,
        demandee,
        montant,
      ]);
    }

    // Un seul conflit annule tout : mieux vaut prévenir que livrer partiellement
    if (conflits.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        message: 'Certaines pièces ne sont plus disponibles.',
        conflits,
      });
    }

    // --- 4. Création de la commande ---
    const [resCmd] = await conn.query(
      `INSERT INTO commandes
        (id_user, nom, prenom, telephone, email, adresse_livraison, commentaire,
         mode_paiement, total, nb_articles, stock_decremente)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        id_user || null,
        nn(client.nom),
        nn(client.prenom),
        nn(client.telephone),
        nn(client.email),
        nn(client.adresse_livraison),
        nn(client.commentaire),
        mode,
        total,
        nbArticles,
      ],
    );

    const idCommande = resCmd.insertId;

    // Référence lisible, générée depuis l'id : aucun risque de collision
    const [[{ reference }]] = await conn.query(
      `SELECT CONCAT('TM-', YEAR(NOW()), '-', LPAD(?, 4, '0')) AS reference`,
      [idCommande],
    );
    await conn.query('UPDATE commandes SET reference = ? WHERE id = ?', [reference, idCommande]);

    // --- 5. Articles ---
    for (const l of lignes) {
      l[0] = idCommande;
      await conn.query(
        `INSERT INTO commande_articles
          (id_commande, id_piece, designation, ref, vehicule, etat, img_principale,
           prix_unitaire, quantite, montant)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        l,
      );
    }

    // --- 6. Le stock N'EST PAS décrémenté ici ---
    // Il l'est à la confirmation par le gestionnaire (voir majStatut).
    // La pièce reste donc visible pour d'autres clients : la page de
    // gestion signale les commandes concurrentes sur un même article.

    await conn.commit();

    console.log(`🛒 Commande ${reference} en attente — ${nbArticles} article(s), ${total} FCFA`);

    res.status(201).json({
      message: 'Commande enregistrée, en attente de confirmation.',
      reference,
      id: idCommande,
      total,
      nb_articles: nbArticles,
      mode_paiement: mode,
      articles: lignes.map((l) => ({
        designation: l[2],
        ref: l[3],
        prix_unitaire: l[7],
        quantite: l[8],
        montant: l[9],
      })),
    });
  } catch (error) {
    await conn.rollback();
    console.error('❌ Erreur validation panier :', error);
    res.status(500).json({ message: 'Erreur interne du serveur.', error: error.message });
  } finally {
    conn.release();
  }
};

// ==========================================================
//  GET /api/panier/commande/:reference
//  Récapitulatif après validation (page de confirmation)
// ==========================================================
exports.getCommande = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM commandes WHERE reference = ?', [
      req.params.reference,
    ]);
    if (rows.length === 0) return res.status(404).json({ message: 'Commande introuvable.' });

    const commande = rows[0];
    const [articles] = await db.query(
      'SELECT * FROM commande_articles WHERE id_commande = ? ORDER BY id',
      [commande.id],
    );

    res.status(200).json({
      ...commande,
      total: Number(commande.total),
      articles: articles.map((a) => ({
        ...a,
        prix_unitaire: Number(a.prix_unitaire),
        montant: Number(a.montant),
      })),
    });
  } catch (error) {
    console.error('❌ Erreur récupération commande :', error);
    res.status(500).json({ message: 'Erreur lors de la récupération de la commande.' });
  }
};

// ==========================================================
//  PATCH /api/panier/commande/:id/statut   (gestion)
//
//  C'est ICI que le stock bouge :
//   - en_attente -> confirmee : décrémentation
//   - confirmee/livree -> annulee : restitution
//  Le drapeau stock_decremente garantit une seule opération.
// ==========================================================
exports.majStatut = async (req, res) => {
  const STATUTS = ['en_attente', 'confirmee', 'livree', 'annulee'];
  const { statut } = req.body;

  if (!STATUTS.includes(statut)) {
    return res.status(400).json({ message: 'Statut invalide.' });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, reference, statut, stock_decremente FROM commandes WHERE id = ? FOR UPDATE',
      [req.params.id],
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Commande introuvable.' });
    }

    const commande = rows[0];

    if (commande.statut === statut) {
      await conn.rollback();
      return res.status(200).json({ message: 'Statut déjà à jour.', statut });
    }

    const [articles] = await conn.query(
      `SELECT ca.id_piece, ca.quantite, ca.designation
       FROM commande_articles ca
       WHERE ca.id_commande = ? AND ca.id_piece IS NOT NULL`,
      [commande.id],
    );

    // ---------- CONFIRMATION : on retire du stock ----------
    if (statut === 'confirmee' && !commande.stock_decremente) {
      const ids = articles.map((a) => a.id_piece);

      if (ids.length > 0) {
        // Verrou sur les pièces concernées
        const [pieces] = await conn.query(
          'SELECT id, description, quantite FROM pieces WHERE id IN (?) FOR UPDATE',
          [ids],
        );
        const parId = new Map(pieces.map((p) => [p.id, p]));

        // Contrôle avant toute écriture : une seule ligne insuffisante bloque tout
        const manquants = [];
        for (const a of articles) {
          const p = parId.get(a.id_piece);
          const stock = p ? Number(p.quantite) || 0 : 0;
          if (stock < a.quantite) {
            manquants.push({
              id_piece: a.id_piece,
              designation: a.designation,
              demandee: a.quantite,
              stock,
              message: `« ${a.designation} » : ${stock} en stock pour ${a.quantite} commandée(s).`,
            });
          }
        }

        if (manquants.length > 0) {
          await conn.rollback();
          return res.status(409).json({
            message: 'Stock insuffisant pour confirmer cette commande.',
            conflits: manquants,
          });
        }

        for (const a of articles) {
          await conn.query('UPDATE pieces SET quantite = quantite - ? WHERE id = ?', [
            a.quantite,
            a.id_piece,
          ]);
        }
      }

      await conn.query('UPDATE commandes SET stock_decremente = 1 WHERE id = ?', [commande.id]);
      console.log(`✅ ${commande.reference} confirmée — ${articles.length} ligne(s) déstockée(s)`);
    }

    // ---------- ANNULATION : on remet en stock ----------
    if (statut === 'annulee' && commande.stock_decremente) {
      for (const a of articles) {
        await conn.query('UPDATE pieces SET quantite = quantite + ? WHERE id = ?', [
          a.quantite,
          a.id_piece,
        ]);
      }
      await conn.query('UPDATE commandes SET stock_decremente = 0 WHERE id = ?', [commande.id]);
      console.log(`↩️ ${commande.reference} annulée — ${articles.length} ligne(s) restituée(s)`);
    }

    await conn.query('UPDATE commandes SET statut = ? WHERE id = ?', [statut, commande.id]);
    await conn.commit();

    res.status(200).json({
      message: 'Statut mis à jour.',
      statut,
      reference: commande.reference,
    });
  } catch (error) {
    await conn.rollback();
    console.error('❌ Erreur mise à jour statut :', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour.', error: error.message });
  } finally {
    conn.release();
  }
};

// ==========================================================
//  GET /api/panier/commandes?statut=en_attente   (gestion)
//  `stock_suffisant` prévient le gestionnaire avant qu'il ne
//  tente une confirmation impossible.
// ==========================================================
exports.getCommandes = async (req, res) => {
  try {
    const { statut } = req.query;

    let sql = `
      SELECT
        c.id, c.reference, c.statut, c.mode_paiement, c.total, c.nb_articles,
        c.date_commande, c.telephone, c.email, c.adresse_livraison, c.commentaire,
        c.stock_decremente,
        CONCAT_WS(' ', c.prenom, c.nom) AS client,
        (c.id_user IS NOT NULL) AS avec_compte,
        NOT EXISTS (
          SELECT 1 FROM commande_articles ca
          LEFT JOIN pieces p ON p.id = ca.id_piece
          WHERE ca.id_commande = c.id
            AND (p.id IS NULL OR p.quantite < ca.quantite)
        ) AS stock_suffisant
      FROM commandes c
      WHERE 1 = 1`;
    const params = [];

    if (statut) {
      sql += ' AND c.statut = ?';
      params.push(statut);
    }

    sql +=
      " ORDER BY FIELD(c.statut, 'en_attente', 'confirmee', 'livree', 'annulee'), c.date_commande DESC";

    const [commandes] = await db.query(sql, params);

    if (commandes.length === 0) return res.status(200).json([]);

    // Articles de toutes les commandes en une seule requête
    const ids = commandes.map((c) => c.id);
    const [articles] = await db.query(
      `SELECT ca.*, p.quantite AS stock_actuel
       FROM commande_articles ca
       LEFT JOIN pieces p ON p.id = ca.id_piece
       WHERE ca.id_commande IN (?)
       ORDER BY ca.id`,
      [ids],
    );

    const parCommande = new Map(ids.map((id) => [id, []]));
    articles.forEach((a) => {
      parCommande.get(a.id_commande)?.push({
        ...a,
        prix_unitaire: Number(a.prix_unitaire),
        montant: Number(a.montant),
        quantite: Number(a.quantite),
        stock_actuel: a.stock_actuel === null ? null : Number(a.stock_actuel),
      });
    });

    res.status(200).json(
      commandes.map((c) => ({
        ...c,
        total: Number(c.total),
        nb_articles: Number(c.nb_articles),
        avec_compte: !!Number(c.avec_compte),
        stock_suffisant: !!Number(c.stock_suffisant),
        stock_decremente: !!Number(c.stock_decremente),
        articles: parCommande.get(c.id) || [],
      })),
    );
  } catch (error) {
    console.error('❌ Erreur liste commandes :', error);
    res.status(500).json({ message: 'Erreur lors de la récupération des commandes.' });
  }
};

// ==========================================================
//  GET /api/panier/stats   (gestion)
// ==========================================================
exports.getStatsCommandes = async (req, res) => {
  try {
    const [[s]] = await db.query(`
      SELECT
        COUNT(*) AS total,
        SUM(statut = 'en_attente') AS en_attente,
        SUM(statut = 'confirmee')  AS confirmees,
        SUM(statut = 'livree')     AS livrees,
        SUM(statut = 'annulee')    AS annulees,
        COALESCE(SUM(CASE WHEN statut IN ('confirmee','livree') THEN total ELSE 0 END), 0) AS chiffre_affaires,
        COALESCE(SUM(CASE WHEN statut = 'en_attente' THEN total ELSE 0 END), 0) AS en_attente_montant
      FROM commandes
    `);

    res.status(200).json({
      total: Number(s.total),
      en_attente: Number(s.en_attente),
      confirmees: Number(s.confirmees),
      livrees: Number(s.livrees),
      annulees: Number(s.annulees),
      chiffre_affaires: Number(s.chiffre_affaires),
      en_attente_montant: Number(s.en_attente_montant),
    });
  } catch (error) {
    console.error('❌ Erreur stats commandes :', error);
    res.status(500).json({ message: 'Erreur lors du calcul des statistiques.' });
  }
};
