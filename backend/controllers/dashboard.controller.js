const db = require('../db');

const SEUIL_DEFAUT = 3;

/** Les 12 derniers mois au format YYYY-MM, du plus ancien au plus récent */
const douzeDerniersMois = () => {
  const mois = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    mois.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return mois;
};

exports.getStats = async (req, res) => {
  try {
    const [
      [[stock]],
      [categories],
      [[clients]],
      [parcClients],
      [[referentiel]],
      [evolution],
      [topMarques],
      [dernieres],
      [[orphelines]],
      [[commandes]],
      [dernieresCommandes],
    ] = await Promise.all([
      // 1. Vue d'ensemble du stock
      db.query(`
        SELECT
          COUNT(*)                                          AS references_total,
          COALESCE(SUM(quantite), 0)                        AS unites,
          COALESCE(SUM(prix * quantite), 0)                 AS valeur,
          COALESCE(ROUND(AVG(prix)), 0)                     AS prix_moyen,
          SUM(CASE WHEN LOWER(etat) = 'neuf' THEN 1 ELSE 0 END)     AS neuf,
          SUM(CASE WHEN LOWER(etat) = 'occasion' THEN 1 ELSE 0 END) AS occasion,
          SUM(CASE WHEN quantite = 0 THEN 1 ELSE 0 END)             AS ruptures,
          SUM(CASE WHEN quantite > 0 AND quantite <= COALESCE(seuil_alerte, ${SEUIL_DEFAUT})
                   THEN 1 ELSE 0 END)                               AS stock_faible
        FROM pieces
      `),

      // 2. Répartition par catégorie
      db.query(`
        SELECT
          COALESCE(categorie, 'Non classée')  AS nom,
          COUNT(*)                            AS nb,
          COALESCE(SUM(quantite), 0)          AS unites,
          COALESCE(SUM(prix * quantite), 0)   AS valeur
        FROM pieces
        GROUP BY COALESCE(categorie, 'Non classée')
        ORDER BY nb DESC
      `),

      // 3. Clients
      db.query(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN date_creacomte >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS nouveaux_30j,
          SUM(CASE WHEN marque_vehicule IS NOT NULL AND marque_vehicule <> '' THEN 1 ELSE 0 END) AS avec_vehicule
        FROM users
      `),

      // 4. Parc automobile des clients, et couverture par le stock
      db.query(`
        SELECT
          UPPER(TRIM(u.marque_vehicule)) AS marque,
          COUNT(*)                       AS nb_clients,
          EXISTS (
            SELECT 1
            FROM pieces p
            JOIN piece_compatibilite pc ON pc.id_piece = p.id
            JOIN modeles mo ON mo.id = pc.id_modele
            JOIN marques ma ON ma.id = mo.id_marque
            WHERE ma.nom = UPPER(TRIM(u.marque_vehicule)) AND p.quantite > 0
          ) AS couverte
        FROM users u
        WHERE u.marque_vehicule IS NOT NULL AND TRIM(u.marque_vehicule) <> ''
        GROUP BY UPPER(TRIM(u.marque_vehicule))
        ORDER BY nb_clients DESC
        LIMIT 8
      `),

      // 5. Référentiel véhicules
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM marques)             AS marques,
          (SELECT COUNT(*) FROM modeles)             AS modeles,
          (SELECT COUNT(*) FROM piece_compatibilite) AS compatibilites,
          (SELECT COUNT(DISTINCT ma.id)
             FROM marques ma
             JOIN modeles mo ON mo.id_marque = ma.id
             JOIN piece_compatibilite pc ON pc.id_modele = mo.id) AS marques_couvertes
      `),

      // 6. Ajouts des 12 derniers mois
      db.query(`
        SELECT
          DATE_FORMAT(date_ajout, '%Y-%m')  AS mois,
          COUNT(*)                          AS nb,
          COALESCE(SUM(prix * quantite), 0) AS valeur
        FROM pieces
        WHERE date_ajout >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 11 MONTH)
        GROUP BY mois
        ORDER BY mois
      `),

      // 7. Marques les mieux fournies en stock
      db.query(`
        SELECT ma.nom AS marque, COUNT(DISTINCT p.id) AS nb
        FROM pieces p
        JOIN piece_compatibilite pc ON pc.id_piece = p.id
        JOIN modeles mo ON mo.id = pc.id_modele
        JOIN marques ma ON ma.id = mo.id_marque
        GROUP BY ma.nom
        ORDER BY nb DESC
        LIMIT 6
      `),

      // 8. Dernières pièces ajoutées
      db.query(`
        SELECT id, ref, description, categorie, prix, quantite, etat, img_principale, date_ajout
        FROM pieces
        ORDER BY date_ajout DESC, id DESC
        LIMIT 5
      `),

      // 9. Pièces sans véhicule rattaché
      db.query(`SELECT COUNT(*) AS nb FROM v_pieces_a_rattacher`),

      // 10. Activité commerciale
      db.query(`
        SELECT
          COUNT(*)                        AS total,
          SUM(statut = 'en_attente')      AS en_attente,
          SUM(statut = 'confirmee')       AS confirmees,
          SUM(statut = 'livree')          AS livrees,
          SUM(statut = 'annulee')         AS annulees,
          COALESCE(SUM(CASE WHEN statut = 'en_attente' THEN total ELSE 0 END), 0) AS montant_attente,
          COALESCE(SUM(CASE WHEN statut IN ('confirmee','livree') THEN total ELSE 0 END), 0) AS chiffre_affaires,
          SUM(date_commande >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS nouvelles_30j
        FROM commandes
      `),

      // 11. Dernières commandes reçues
      db.query(`
        SELECT
          c.id, c.reference, c.statut, c.total, c.nb_articles, c.date_commande,
          CONCAT_WS(' ', c.prenom, c.nom) AS client,
          c.telephone
        FROM commandes c
        ORDER BY c.date_commande DESC
        LIMIT 5
      `),
    ]);

    // --- Évolution : on comble les mois sans ajout ---
    const parMois = new Map(evolution.map((e) => [e.mois, e]));
    const serie = douzeDerniersMois().map((mois) => ({
      mois,
      nb: Number(parMois.get(mois)?.nb || 0),
      valeur: Number(parMois.get(mois)?.valeur || 0),
    }));

    // --- Compteurs par catégorie, format historique ---
    // L'ancien dashboard attend stats.motorisation, stats.freinage, etc.
    const legacy = {
      motorisation: 0,
      transmission: 0,
      freinage: 0,
      suspension: 0,
      carrosserie: 0,
      electronique: 0,
    };
    categories.forEach((c) => {
      const cat = String(c.nom).toLowerCase();
      const nb = Number(c.nb);
      if (cat.includes('motor') || cat.includes('moteur')) legacy.motorisation += nb;
      else if (cat.includes('transm')) legacy.transmission += nb;
      else if (cat.includes('frein')) legacy.freinage += nb;
      else if (cat.includes('suspens')) legacy.suspension += nb;
      else if (cat.includes('carros')) legacy.carrosserie += nb;
      else if (cat.includes('electro') || cat.includes('électro')) legacy.electronique += nb;
    });

    res.status(200).json({
      // --- Rétrocompatibilité avec l'ancienne interface StatsPieces ---
      total: Number(stock.references_total),
      ...legacy,

      // --- Vue d'ensemble ---
      stock: {
        references: Number(stock.references_total),
        unites: Number(stock.unites),
        valeur: Number(stock.valeur),
        prix_moyen: Number(stock.prix_moyen),
        neuf: Number(stock.neuf),
        occasion: Number(stock.occasion),
      },

      alertes: {
        ruptures: Number(stock.ruptures),
        stock_faible: Number(stock.stock_faible),
        sans_compatibilite: Number(orphelines.nb),
        seuil: SEUIL_DEFAUT,
      },

      clients: {
        total: Number(clients.total),
        nouveaux_30j: Number(clients.nouveaux_30j),
        avec_vehicule: Number(clients.avec_vehicule),
      },

      referentiel: {
        marques: Number(referentiel.marques),
        modeles: Number(referentiel.modeles),
        compatibilites: Number(referentiel.compatibilites),
        marques_couvertes: Number(referentiel.marques_couvertes),
      },

      categories: categories.map((c) => ({
        nom: c.nom,
        nb: Number(c.nb),
        unites: Number(c.unites),
        valeur: Number(c.valeur),
      })),

      evolution: serie,

      top_marques: topMarques.map((m) => ({ marque: m.marque, nb: Number(m.nb) })),

      parc_clients: parcClients.map((p) => ({
        marque: p.marque,
        nb_clients: Number(p.nb_clients),
        couverte: !!Number(p.couverte),
      })),

      dernieres: dernieres.map((p) => ({
        ...p,
        prix: Number(p.prix),
        quantite: Number(p.quantite),
      })),

      commandes: {
        total: Number(commandes.total),
        en_attente: Number(commandes.en_attente),
        confirmees: Number(commandes.confirmees),
        livrees: Number(commandes.livrees),
        annulees: Number(commandes.annulees),
        montant_attente: Number(commandes.montant_attente),
        chiffre_affaires: Number(commandes.chiffre_affaires),
        nouvelles_30j: Number(commandes.nouvelles_30j),
      },

      dernieres_commandes: dernieresCommandes.map((c) => ({
        ...c,
        total: Number(c.total),
        nb_articles: Number(c.nb_articles),
      })),
    });
  } catch (error) {
    console.error('Erreur Stats Dashboard:', error);
    res.status(500).json({ error: 'Erreur serveur lors du calcul des statistiques' });
  }
};
