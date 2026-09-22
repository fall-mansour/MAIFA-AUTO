import {
  ChangeDetectorRef,
  Component,
  HostListener,
  OnInit,
  OnDestroy,
  AfterViewInit,
  Inject,
  PLATFORM_ID,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule, CurrencyPipe, isPlatformBrowser } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Piecevente, PiecesServicevente } from '../../Piecesvente';
import { IconePiece } from '../../icone-piece';
import { BoutonsFlottants } from '../../boutons-flottants';
import { SessionService } from '../../session.service';
import { PanierService } from '../../panier.service';
import { environment } from '../../environnement';

interface Vehicule {
  id: number;
  modele: string;
  id_marque: number;
  rappel_marque: string;
}

interface Categorie {
  nom: string;
  slug: string;
  nb: number;
}

interface SousCategorie {
  nom: string;
  slug: string;
  nb: number;
  /** true pour le groupe de repli « Autres <famille> » */
  autres?: boolean;
}

interface Famille {
  nom: string;
  slug: string;
  nb: number;
  sous: SousCategorie[];
}

@Component({
  selector: 'app-acceuil',
  standalone: true,
  imports: [FormsModule, CurrencyPipe, RouterLink, CommonModule, IconePiece, BoutonsFlottants],
  templateUrl: './acceuil.html',
  styleUrl: './acceuil.scss',
})
export class Acceuil implements OnInit, AfterViewInit, OnDestroy {
  pieces: Piecevente[] = [];
  allVehicules: Vehicule[] = [];
  marques: string[] = [];
  modelesFiltr: string[] = [];

  searchText: string = '';
  selectedMarque: string = '';
  selectedAnnee: string = '';
  selectedModele: string = '';
  selectedCategorie: string = '';

  // Filtre general (pastilles) et filtre detaille (grille du bas)
  categories: Categorie[] = [];
  familles: Famille[] = [];
  selectedSousCategorie = '';
  totalCatalogue = 0;

  /** Sous-categories affichees avant le « Voir plus » */
  readonly LIMITE_SOUS_CAT = 5;
  private depliees = new Set<string>();

  // Session et panier : signaux, donc pas de markForCheck necessaire
  session = inject(SessionService);
  panier = inject(PanierService);
  menuOuvert = false;

  // Mode zoneless : Angular doit etre prevenu apres chaque reponse asynchrone
  private cdr = inject(ChangeDetectorRef);

  constructor(
    private piecesServicevente: PiecesServicevente,
    private http: HttpClient,
    @Inject(PLATFORM_ID) private platformId: Object,
  ) {}

  ngOnInit(): void {
    this.loadPieces();
    this.loadModeles();
  }

  loadPieces(): void {
    this.piecesServicevente.getPieces().subscribe({
      next: (reponse: any) => {
        // Compatible avec les deux formats : tableau simple ou { pieces, total, categories }
        const liste: Piecevente[] = Array.isArray(reponse) ? reponse : reponse.pieces || [];
        this.pieces = liste;
        this.totalCatalogue = Array.isArray(reponse) ? liste.length : reponse.total || liste.length;
        this.categories = Array.isArray(reponse) ? [] : reponse.categories || [];
        this.familles = Array.isArray(reponse) ? [] : reponse.familles || [];
        this.cdr.markForCheck();
        console.log(
          `✅ Catalogue chargé : ${liste.length} pièces, ${this.categories.length} familles, ` +
            `${this.familles.length} familles détaillées`,
        );
      },
      error: (err: HttpErrorResponse) => {
        console.error('❌ Erreur de connexion au serveur Node :', err.message);
        this.cdr.markForCheck();
      },
    });
  }

  /**
   * NETTOYAGE : Plus besoin de getSafeUrl ou DomSanitizer !
   * Les URLs Cloudinary (https) sont acceptées nativement.
   */

  loadModeles(): void {
    this.http.get<Vehicule[]>(`${environment.apiUrl}/modeles/all`).subscribe({
      next: (data) => {
        this.allVehicules = data;
        this.marques = [...new Set(data.map((v) => v.rappel_marque))].sort();
        this.cdr.markForCheck();
      },
      error: (err) => console.error('❌ Erreur table modeles :', err),
    });
  }

  // ==========================================================
  //  MENU DU COMPTE
  // ==========================================================

  /** Initiales affichees a defaut de photo de profil */
  get initiales(): string {
    const u = this.session.utilisateur();
    if (!u) return '';
    return ((u.prenom?.[0] || '') + (u.nom?.[0] || '')).toUpperCase();
  }

  basculerMenu(event: Event): void {
    // Sans cela, le clic remonte jusqu'au document et referme aussitot
    event.stopPropagation();
    this.menuOuvert = !this.menuOuvert;
  }

  /** Un clic ailleurs dans la page referme le menu */
  @HostListener('document:click')
  fermerMenu(): void {
    if (this.menuOuvert) {
      this.menuOuvert = false;
      this.cdr.markForCheck();
    }
  }

  /** La touche Echap aussi */
  @HostListener('document:keydown.escape')
  fermerMenuClavier(): void {
    this.fermerMenu();
  }

  deconnecter(): void {
    this.menuOuvert = false;
    this.session.deconnecter();
    this.cdr.markForCheck();
  }

  // ==========================================================
  //  FILTRE PAR CATEGORIE
  // ==========================================================

  /**
   * Filtre general, depuis les pastilles du haut.
   * Recliquer sur la categorie active la desactive.
   */
  choisirCategorie(slug: string): void {
    this.selectedCategorie = this.selectedCategorie === slug ? '' : slug;
    this.selectedSousCategorie = ''; // le filtre fin ne s'applique plus
    this.remonterAuxResultats();
  }

  /**
   * Filtre detaille, depuis la grille du bas.
   * On positionne aussi la famille, pour que le titre reste lisible.
   */
  choisirSousCategorie(famille: string, slug: string): void {
    if (this.selectedSousCategorie === slug) {
      this.selectedSousCategorie = '';
      this.selectedCategorie = '';
    } else {
      this.selectedSousCategorie = slug;
      this.selectedCategorie = famille;
    }
    this.remonterAuxResultats();
  }

  /** Efface les deux niveaux de filtre */
  reinitialiserFiltres(): void {
    this.selectedCategorie = '';
    this.selectedSousCategorie = '';
    this.cdr.markForCheck();
  }

  private remonterAuxResultats(): void {
    if (isPlatformBrowser(this.platformId)) {
      document.getElementById('resultats')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    this.cdr.markForCheck();
  }

  /**
   * Sous-categories visibles : les premieres, ou toutes si depliee.
   * Les entrees peuplees passent devant, pour que le « Voir plus »
   * ne masque jamais une sous-categorie reellement disponible.
   */
  sousCategoriesVisibles(f: Famille): SousCategorie[] {
    if (this.estDepliee(f.slug)) return f.sous;

    const peuplees = f.sous.filter((sc) => sc.nb > 0);
    const vides = f.sous.filter((sc) => sc.nb === 0);
    return [...peuplees, ...vides].slice(0, this.LIMITE_SOUS_CAT);
  }

  estDepliee(slug: string): boolean {
    return this.depliees.has(slug);
  }

  basculerFamille(slug: string): void {
    if (this.depliees.has(slug)) this.depliees.delete(slug);
    else this.depliees.add(slug);
    this.cdr.markForCheck();
  }

  /** Libelle lisible de la categorie selectionnee */
  nomCategorie(slug: string): string {
    return this.categories.find((c) => c.slug === slug)?.nom || slug;
  }

  /** Libelle de la sous-categorie selectionnee */
  nomSousCategorie(slug: string): string {
    for (const f of this.familles) {
      const trouve = f.sous.find((sc) => sc.slug === slug);
      if (trouve) return trouve.nom;
    }
    return slug;
  }

  /** Titre affiche au-dessus des resultats */
  get titreResultats(): string {
    if (this.selectedSousCategorie) return this.nomSousCategorie(this.selectedSousCategorie);
    if (this.selectedCategorie) return this.nomCategorie(this.selectedCategorie);
    return 'Dernières pièces arrivées';
  }

  get aDesFiltres(): boolean {
    return !!(this.selectedCategorie || this.selectedSousCategorie);
  }

  onMarqueChange(): void {
    this.selectedModele = '';
    this.modelesFiltr = this.allVehicules
      .filter((v) => v.rappel_marque === this.selectedMarque)
      .map((v) => v.modele)
      .sort();
  }

  get filteredPieces(): Piecevente[] {
    return this.pieces.filter((piece) => {
      const search = this.searchText.toLowerCase();
      const matchesSearch =
        !this.searchText ||
        piece.marque?.toLowerCase().includes(search) ||
        piece.modele?.toLowerCase().includes(search) ||
        piece.description?.toLowerCase().includes(search);

      const matchesMarque =
        !this.selectedMarque || piece.marque?.toLowerCase() === this.selectedMarque.toLowerCase();

      const matchesAnnee = !this.selectedAnnee || piece.annee?.toString() === this.selectedAnnee;

      const matchesModele =
        !this.selectedModele || piece.modele?.toLowerCase() === this.selectedModele.toLowerCase();

      const matchesCategorie =
        !this.selectedCategorie ||
        (piece.categorie || '').toLowerCase().trim() === this.selectedCategorie;

      // Filtre fin : la piece doit porter exactement cette sous-categorie
      const matchesSousCategorie =
        !this.selectedSousCategorie ||
        ((piece as any).sous_categorie || '') === this.selectedSousCategorie;

      return (
        matchesSearch &&
        matchesMarque &&
        matchesAnnee &&
        matchesModele &&
        matchesCategorie &&
        matchesSousCategorie
      );
    });
  }

  ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.initSlideshow();
    }
  }

  ngOnDestroy(): void {
    // Sans cela, l'intervalle continue de tourner apres avoir quitte la page
    if (this.slideshowTimer) clearInterval(this.slideshowTimer);
  }

  private slideshowTimer?: any;

  private initSlideshow() {
    const imagePaths = ['assets/img1.jpg', 'assets/img2.jpg', 'assets/img3.jpg'];
    const slideshow = document.querySelector('.slideshow');
    if (!slideshow) return;

    imagePaths.forEach((src) => {
      const img = document.createElement('img');
      img.src = src;
      slideshow.appendChild(img);
    });

    const images = slideshow.querySelectorAll('img');
    if (images.length === 0) return;

    let current = 0;
    images[current].classList.add('active');

    this.slideshowTimer = setInterval(() => {
      images[current].classList.remove('active');
      current = (current + 1) % images.length;
      images[current].classList.add('active');
    }, 5000);
  }

  private routerLink = inject(Router);

  openPanier(): void {
    this.routerLink.navigate(['/Panier']);
  }
}
