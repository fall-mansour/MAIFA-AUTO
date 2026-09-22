import { ChangeDetectorRef, Component, HostListener, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { PiecesServicegestion } from '../../piecesgestion';
import { environment } from '../../environnement';

interface Marque {
  id: number;
  nom: string;
}
interface Modele {
  id: number;
  modele: string;
}
interface Categorie {
  id: number;
  nom: string;
  slug: string;
}

/** Champs modifiables dans la fenetre d'edition */
interface EditionPiece {
  id: number;
  description: string;
  prix: number | null;
  quantite: number;
  seuil_alerte: number;
  etat: string;
  fournisseur: string;
  equipementier: string;
  ref: string;
  ref_oe: string;
  visible_catalogue: boolean;
}

@Component({
  selector: 'app-stock',
  standalone: true,
  imports: [FormsModule, CommonModule, RouterModule],
  templateUrl: './stock.html',
  styleUrl: './stock.scss',
})
export class Stock implements OnInit {
  pieces: any[] = [];

  // --- Filtres ---
  searchText = '';
  selectedMarque = ''; // id de marque
  selectedModele = ''; // id de modèle
  selectedAnnee = '';
  selectedCategorie = '';
  onlyAlerts = false;
  onlySansCompat = false;
  sortBy: 'recent' | 'stock' | 'prix-asc' | 'prix-desc' | 'marque' = 'recent';

  view: 'grid' | 'list' = 'grid';

  // --- Référentiel ---
  marques: Marque[] = [];
  modelesDisponibles: Modele[] = [];
  categories: Categorie[] = [];
  annees: number[] = [];
  chargementModeles = false;

  readonly SEUIL_DEFAUT = 3;
  readonly ETATS = ['Neuf', 'Occasion', 'Reconditionné'];

  // --- Ajustement rapide du stock ---
  /** Pieces dont la quantite est en cours d'enregistrement */
  private enCours = new Set<number>();

  // --- Fenetre d'edition ---
  edition: EditionPiece | null = null;
  enregistrement = false;
  erreurEdition: string | null = null;

  // --- Notification discrete ---
  notification: { texte: string; type: 'ok' | 'ko' } | null = null;
  private minuteurNotif?: any;

  // Mode zoneless : Angular doit etre prevenu apres chaque reponse asynchrone
  private cdr = inject(ChangeDetectorRef);

  constructor(
    private piecesService: PiecesServicegestion,
    private http: HttpClient,
    private router: Router,
  ) {}

  ngOnInit(): void {
    const actuelle = new Date().getFullYear();
    for (let a = actuelle + 1; a >= 1990; a--) this.annees.push(a);

    this.chargerStock();
    this.chargerReferentiel();
  }

  // ==========================================================
  //  CHARGEMENT
  // ==========================================================
  chargerStock(): void {
    this.piecesService.getPieces().subscribe({
      next: (data: any[]) => {
        this.pieces = data.map((piece) => this.normaliser(piece));
        console.log(`✅ Stock chargé : ${this.pieces.length} pièces`);
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('❌ Erreur de récupération du stock:', err);
        this.cdr.markForCheck();
      },
    });
  }

  /** Forme commune d'une piece, a la reception comme apres modification */
  private normaliser(piece: any): any {
    return {
      ...piece,
      img: piece.img_principale || 'assets/logo.jpeg',
      compatibilites: piece.compatibilites || [],
      references: piece.references || [],
    };
  }

  private chargerReferentiel(): void {
    this.http.get<Marque[]>(`${environment.apiUrl}/modeles/marques`).subscribe({
      next: (data) => {
        this.marques = data;
        this.cdr.markForCheck();
      },
      error: (err) => console.error('❌ Chargement des marques :', err),
    });

    this.http.get<Categorie[]>(`${environment.apiUrl}/modeles/categories`).subscribe({
      next: (data) => {
        this.categories = data;
        this.cdr.markForCheck();
      },
      error: (err) => console.error('❌ Chargement des catégories :', err),
    });
  }

  onMarqueChange(idMarque: string): void {
    this.selectedModele = '';
    this.modelesDisponibles = [];
    if (!idMarque) return;

    this.chargementModeles = true;
    this.http.get<Modele[]>(`${environment.apiUrl}/modeles/marques/${idMarque}/modeles`).subscribe({
      next: (data) => {
        this.modelesDisponibles = data;
        this.chargementModeles = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('❌ Chargement des modèles :', err);
        this.chargementModeles = false;
        this.cdr.markForCheck();
      },
    });
  }

  // ==========================================================
  //  AJUSTEMENT RAPIDE DU STOCK (boutons − et +)
  //
  //  Mise a jour optimiste : l'affichage change immediatement,
  //  puis on aligne sur la valeur renvoyee par le serveur. En
  //  cas d'echec, on revient a la valeur precedente.
  // ==========================================================
  ajusterStock(piece: any, delta: number, event?: Event): void {
    event?.stopPropagation();

    const id = Number(piece.id);
    const avant = Number(piece.quantite) || 0;
    const apres = avant + delta;

    if (apres < 0 || this.enCours.has(id)) return;

    this.enCours.add(id);
    piece.quantite = apres;
    this.cdr.markForCheck();

    this.http.patch<any>(`${environment.apiUrl}/stock/${id}/quantite`, { delta }).subscribe({
      next: (res) => {
        piece.quantite = res.quantite;
        this.enCours.delete(id);
        this.cdr.markForCheck();
      },
      error: (err) => {
        piece.quantite = avant;
        this.enCours.delete(id);
        this.notifier(err.error?.message || 'Quantité non enregistrée.', 'ko');
        this.cdr.markForCheck();
      },
    });
  }

  estEnCours(piece: any): boolean {
    return this.enCours.has(Number(piece.id));
  }

  // ==========================================================
  //  FENETRE D'EDITION
  // ==========================================================

  /** Ouvre la fenetre sur une COPIE : rien ne change tant qu'on n'enregistre pas */
  ouvrirEdition(piece: any): void {
    this.erreurEdition = null;
    this.edition = {
      id: Number(piece.id),
      description: piece.description || '',
      prix: piece.prix ?? null,
      quantite: Number(piece.quantite) || 0,
      seuil_alerte: Number(piece.seuil_alerte ?? this.SEUIL_DEFAUT),
      etat: piece.etat || 'Neuf',
      fournisseur: piece.fournisseur || '',
      equipementier: piece.equipementier || '',
      ref: piece.ref || '',
      ref_oe: piece.ref_oe || '',
      visible_catalogue:
        piece.visible_catalogue === undefined ? true : !!Number(piece.visible_catalogue),
    };
  }

  fermerEdition(): void {
    if (this.enregistrement) return;
    this.edition = null;
    this.erreurEdition = null;
  }

  /** Echap ferme la fenetre */
  @HostListener('document:keydown.escape')
  surEchap(): void {
    if (this.edition) {
      this.fermerEdition();
      this.cdr.markForCheck();
    }
  }

  /** Validation cote client, doublee cote serveur */
  private validerEdition(e: EditionPiece): string | null {
    if (!e.description.trim()) return 'La désignation est obligatoire.';
    if (e.prix === null || e.prix === undefined || Number(e.prix) < 0) {
      return 'Le prix doit être un nombre positif.';
    }
    if (!Number.isInteger(Number(e.quantite)) || Number(e.quantite) < 0) {
      return 'La quantité doit être un entier positif.';
    }
    if (!Number.isInteger(Number(e.seuil_alerte)) || Number(e.seuil_alerte) < 0) {
      return "Le seuil d'alerte doit être un entier positif.";
    }
    return null;
  }

  enregistrerEdition(): void {
    if (!this.edition || this.enregistrement) return;

    const erreur = this.validerEdition(this.edition);
    if (erreur) {
      this.erreurEdition = erreur;
      return;
    }

    const e = this.edition;
    this.enregistrement = true;
    this.erreurEdition = null;
    this.cdr.markForCheck();

    const charge = {
      description: e.description.trim(),
      prix: Number(e.prix),
      quantite: Number(e.quantite),
      seuil_alerte: Number(e.seuil_alerte),
      etat: e.etat,
      fournisseur: e.fournisseur,
      equipementier: e.equipementier,
      ref: e.ref,
      ref_oe: e.ref_oe,
      visible_catalogue: e.visible_catalogue,
    };

    this.http.patch<any>(`${environment.apiUrl}/stock/${e.id}`, charge).subscribe({
      next: (res) => {
        // Le serveur renvoie la piece complete : on remplace la copie locale
        const index = this.pieces.findIndex((p) => Number(p.id) === e.id);
        if (index !== -1) this.pieces[index] = this.normaliser(res.piece);

        this.enregistrement = false;
        this.edition = null;
        this.notifier('Pièce mise à jour.', 'ok');
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.enregistrement = false;
        this.erreurEdition = err.error?.message || 'Enregistrement impossible.';
        this.cdr.markForCheck();
      },
    });
  }

  private notifier(texte: string, type: 'ok' | 'ko'): void {
    this.notification = { texte, type };
    if (this.minuteurNotif) clearTimeout(this.minuteurNotif);
    this.minuteurNotif = setTimeout(() => {
      this.notification = null;
      this.cdr.markForCheck();
    }, 3500);
  }

  // ==========================================================
  //  SUPPRESSION
  // ==========================================================
  supprimerPiece(id: string | number | undefined): void {
    if (id === undefined) return;
    const idToDelete = id.toString();

    if (confirm('Voulez-vous vraiment retirer cette pièce du stock définitivement ?')) {
      this.piecesService.deletePiece(idToDelete).subscribe({
        next: (res: any) => {
          this.pieces = this.pieces.filter((p) => p._id !== idToDelete && p.id !== id);
          this.notifier(`Pièce retirée${res?.ref ? ' (' + res.ref + ')' : ''}.`, 'ok');
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error('❌ Erreur lors de la suppression:', err);
          this.notifier('Impossible de supprimer la pièce.', 'ko');
          this.cdr.markForCheck();
        },
      });
    }
  }

  // ==========================================================
  //  ÉTAT DU STOCK
  // ==========================================================
  stockStatus(piece: any): 'rupture' | 'faible' | 'ok' {
    const q = Number(piece.quantite) || 0;
    const seuil = Number(piece.seuil_alerte ?? this.SEUIL_DEFAUT);
    if (q === 0) return 'rupture';
    if (q <= seuil) return 'faible';
    return 'ok';
  }

  stockLabel(piece: any): string {
    const status = this.stockStatus(piece);
    if (status === 'rupture') return 'en rupture';
    if (status === 'faible') return 'à réapprovisionner';
    return 'en stock';
  }

  // ==========================================================
  //  CHIFFRES CLÉS
  // ==========================================================
  get totalUnites(): number {
    return this.pieces.reduce((sum, p) => sum + (Number(p.quantite) || 0), 0);
  }

  get valeurStock(): number {
    return this.pieces.reduce(
      (sum, p) => sum + (Number(p.prix) || 0) * (Number(p.quantite) || 0),
      0,
    );
  }

  get nbAlertes(): number {
    return this.pieces.filter((p) => this.stockStatus(p) !== 'ok').length;
  }

  get nbSansCompat(): number {
    return this.pieces.filter((p) => !p.compatibilites?.length).length;
  }

  // ==========================================================
  //  FILTRAGE ET TRI
  // ==========================================================
  get hasFilters(): boolean {
    return !!(
      this.searchText ||
      this.selectedMarque ||
      this.selectedModele ||
      this.selectedAnnee ||
      this.selectedCategorie ||
      this.onlyAlerts ||
      this.onlySansCompat
    );
  }

  resetFilters(): void {
    this.searchText = '';
    this.selectedMarque = '';
    this.selectedModele = '';
    this.selectedAnnee = '';
    this.selectedCategorie = '';
    this.onlyAlerts = false;
    this.onlySansCompat = false;
    this.modelesDisponibles = [];
  }

  get filteredPieces(): any[] {
    const search = this.searchText.trim().toLowerCase();
    const marqueNom = this.marques.find((m) => m.id === +this.selectedMarque)?.nom;

    const list = this.pieces.filter((piece) => {
      const compat = piece.compatibilites || [];

      const matchesSearch =
        !search ||
        piece.ref?.toLowerCase().includes(search) ||
        piece.ref_oe?.toLowerCase().includes(search) ||
        piece.description?.toLowerCase().includes(search) ||
        piece.fournisseur?.toLowerCase().includes(search) ||
        compat.some(
          (c: any) =>
            c.marque?.toLowerCase().includes(search) || c.modele?.toLowerCase().includes(search),
        ) ||
        (piece.references || []).some((r: any) => r.reference?.toLowerCase().includes(search));

      const matchesMarque = !marqueNom || compat.some((c: any) => c.marque === marqueNom);

      const matchesModele =
        !this.selectedModele || compat.some((c: any) => c.id_modele === +this.selectedModele);

      const annee = +this.selectedAnnee;
      const matchesAnnee =
        !this.selectedAnnee ||
        compat.some((c: any) => annee >= (c.annee_min || 0) && annee <= (c.annee_max || 9999));

      const matchesCategorie =
        !this.selectedCategorie || piece.categorie === this.selectedCategorie;

      const matchesAlerte = !this.onlyAlerts || this.stockStatus(piece) !== 'ok';

      const matchesSansCompat = !this.onlySansCompat || compat.length === 0;

      return (
        matchesSearch &&
        matchesMarque &&
        matchesModele &&
        matchesAnnee &&
        matchesCategorie &&
        matchesAlerte &&
        matchesSansCompat
      );
    });

    return this.sortList(list);
  }

  private sortList(list: any[]): any[] {
    const sorted = [...list];

    switch (this.sortBy) {
      case 'stock':
        return sorted.sort((a, b) => (Number(a.quantite) || 0) - (Number(b.quantite) || 0));
      case 'prix-asc':
        return sorted.sort((a, b) => (Number(a.prix) || 0) - (Number(b.prix) || 0));
      case 'prix-desc':
        return sorted.sort((a, b) => (Number(b.prix) || 0) - (Number(a.prix) || 0));
      case 'marque':
        return sorted.sort((a, b) =>
          (a.compatibilites?.[0]?.marque || '').localeCompare(b.compatibilites?.[0]?.marque || ''),
        );
      default:
        return sorted.sort((a, b) => {
          const da = a.date_ajout ? new Date(a.date_ajout).getTime() : Number(a.id) || 0;
          const db = b.date_ajout ? new Date(b.date_ajout).getTime() : Number(b.id) || 0;
          return db - da;
        });
    }
  }

  trackById(_index: number, piece: any): string | number {
    return piece._id ?? piece.id ?? _index;
  }

  goconnexion(): void {
    this.router.navigate(['/login']);
  }
}
