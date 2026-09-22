import { NgIf, NgFor, DecimalPipe } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environnement';

interface Marque {
  id: number;
  nom: string;
  nb_modeles?: number;
}
interface Modele {
  id: number;
  modele: string;
  annee_debut?: number;
  annee_fin?: number;
}
interface Categorie {
  id: number;
  nom: string;
  slug: string;
}
interface SousCategorie {
  id: number;
  nom: string;
  slug: string;
}
interface Compatibilite {
  id_modele: number;
  marque: string;
  modele: string;
  annee_min: number | null;
  annee_max: number | null;
  motorisation: string | null;
}

@Component({
  selector: 'app-ajoutpieces',
  standalone: true,
  imports: [FormsModule, NgIf, NgFor, DecimalPipe],
  templateUrl: './ajoutpieces.html',
  styleUrl: './ajoutpieces.scss',
})
export class Ajoutpieces implements OnInit {
  // Modèle initial pour réinitialisation facile
  private readonly initialData = {
    description: '',
    categorie: '',
    sous_categorie: '',
    reference: '',
    ref_oe: '',
    etat: '',
    prix: null,
    quantite: null,
    fournisseur: '',
    equipementier: '',
  };

  pieceData: any = { ...this.initialData };

  // ---------- Référentiel ----------
  marques: Marque[] = [];
  modelesDisponibles: Modele[] = [];
  categories: Categorie[] = [];
  sousCategories: SousCategorie[] = [];
  chargementSousCat = false;
  annees: number[] = [];
  etats = ['Neuf', 'Occasion'];
  chargementModeles = false;

  // ---------- Compatibilités ----------
  selection = {
    id_marque: '',
    id_modele: '',
    annee_min: '',
    annee_max: '',
    motorisation: '',
  };
  compatibilites: Compatibilite[] = [];

  // ---------- Images ----------
  private readonly slots = ['img_principale', 'img1', 'img2', 'img3', 'img4'];
  selectedFiles: { [key: string]: File } = {};
  previews: { [key: string]: string } = {};
  fileNames: { [key: string]: string } = {};
  gallery: string[] = [];
  activeImage: string | null = null;
  dragTarget: string | null = null;
  saving = false;

  private readonly MAX_SIZE = 2 * 1024 * 1024; // 2 Mo

  // Mode zoneless : Angular doit etre prevenu apres chaque reponse asynchrone
  private cdr = inject(ChangeDetectorRef);

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    const actuelle = new Date().getFullYear();
    for (let a = actuelle + 1; a >= 1990; a--) this.annees.push(a);

    this.chargerMarques();
    this.chargerCategories();
  }

  // ==========================================================
  //  RÉFÉRENTIEL
  // ==========================================================
  private chargerMarques(): void {
    this.http.get<Marque[]>(`${environment.apiUrl}/modeles/marques`).subscribe({
      next: (data) => {
        this.marques = data;
        this.cdr.markForCheck();
      },
      error: (err) => console.error('❌ Chargement des marques :', err),
    });
  }

  private chargerCategories(): void {
    this.http.get<Categorie[]>(`${environment.apiUrl}/modeles/categories`).subscribe({
      next: (data) => {
        this.categories = data;
        this.cdr.markForCheck();
      },
      error: (err) => console.error('❌ Chargement des catégories :', err),
    });
  }

  /** Le choix d'une marque recharge la liste de ses modèles */
  onMarqueChange(idMarque: string): void {
    this.selection.id_modele = '';
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
  //  CATÉGORIES EN CASCADE
  // ==========================================================

  /** Le choix d'une famille recharge ses sous-catégories */
  onCategorieChange(slug: string): void {
    this.pieceData.sous_categorie = '';
    this.sousCategories = [];
    if (!slug) return;

    this.chargementSousCat = true;
    this.http
      .get<SousCategorie[]>(`${environment.apiUrl}/modeles/categories/${slug}/sous-categories`)
      .subscribe({
        next: (data) => {
          this.sousCategories = data;
          this.chargementSousCat = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error('❌ Chargement des sous-catégories :', err);
          this.chargementSousCat = false;
          this.cdr.markForCheck();
        },
      });
  }

  /** Libellés lisibles pour l'aperçu */
  nomCategorie(): string {
    return this.categories.find((c) => c.slug === this.pieceData.categorie)?.nom || '';
  }

  nomSousCategorie(): string {
    return this.sousCategories.find((c) => c.slug === this.pieceData.sous_categorie)?.nom || '';
  }

  // ==========================================================
  //  COMPATIBILITÉS
  // ==========================================================
  ajouterCompatibilite(): void {
    const modele = this.modelesDisponibles.find((m) => m.id === +this.selection.id_modele);
    const marque = this.marques.find((m) => m.id === +this.selection.id_marque);
    if (!modele || !marque) return;

    const idModele = modele.id;
    if (this.compatibilites.some((c) => c.id_modele === idModele)) {
      alert('⚠️ Ce véhicule est déjà dans la liste.');
      return;
    }

    const min = this.selection.annee_min ? +this.selection.annee_min : null;
    const max = this.selection.annee_max ? +this.selection.annee_max : null;

    if (min && max && min > max) {
      alert("⚠️ L'année de début doit précéder l'année de fin.");
      return;
    }

    this.compatibilites.push({
      id_modele: idModele,
      marque: marque.nom,
      modele: modele.modele,
      annee_min: min,
      annee_max: max,
      motorisation: this.selection.motorisation.trim() || null,
    });

    // On garde la marque sélectionnée : on ajoute souvent plusieurs modèles de suite
    this.selection.id_modele = '';
    this.selection.motorisation = '';
  }

  retirerCompatibilite(index: number): void {
    this.compatibilites.splice(index, 1);
  }

  // ==========================================================
  //  IMAGES
  // ==========================================================
  onFileSelect(event: any, fieldName: string): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.handleFile(file, fieldName);
    input.value = '';
  }

  onDragOver(event: DragEvent, fieldName: string): void {
    event.preventDefault();
    this.dragTarget = fieldName;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragTarget = null;
  }

  onDrop(event: DragEvent, fieldName: string): void {
    event.preventDefault();
    this.dragTarget = null;
    const file = event.dataTransfer?.files?.[0];
    if (file) this.handleFile(file, fieldName);
  }

  private handleFile(file: File, fieldName: string): void {
    if (!file.type.startsWith('image/')) {
      alert('⚠️ Seules les images JPG ou PNG sont acceptées.');
      return;
    }
    if (file.size > this.MAX_SIZE) {
      alert('⚠️ Image trop lourde : 2 Mo maximum.');
      return;
    }

    this.selectedFiles[fieldName] = file;
    this.fileNames[fieldName] = file.name;

    const reader = new FileReader();
    reader.onload = () => {
      this.previews[fieldName] = reader.result as string;
      this.syncGallery();
      this.cdr.markForCheck(); // FileReader est asynchrone : meme probleme
    };
    reader.readAsDataURL(file);
  }

  removeImage(fieldName: string): void {
    delete this.selectedFiles[fieldName];
    delete this.previews[fieldName];
    delete this.fileNames[fieldName];
    this.syncGallery();
  }

  private syncGallery(): void {
    this.gallery = this.slots.map((s) => this.previews[s]).filter((src): src is string => !!src);

    if (!this.activeImage || !this.gallery.includes(this.activeImage)) {
      this.activeImage = this.gallery[0] ?? null;
    }
  }

  // ==========================================================
  //  INDICATEURS
  // ==========================================================
  get totalFields(): number {
    return Object.keys(this.initialData).length + 1; // +1 pour les compatibilités
  }

  get filledCount(): number {
    const champs = Object.values(this.pieceData).filter(
      (v) => v !== null && v !== undefined && v !== '',
    ).length;
    return champs + (this.compatibilites.length > 0 ? 1 : 0);
  }

  get completion(): number {
    return Math.round((this.filledCount / this.totalFields) * 100);
  }

  get isLowStock(): boolean {
    const q = Number(this.pieceData.quantite);
    return q > 0 && q < 3;
  }

  // ==========================================================
  //  ENVOI
  // ==========================================================
  onSubmit(): void {
    if (!this.pieceData.description) {
      alert('⚠️ La désignation de la pièce est obligatoire.');
      return;
    }

    if (this.compatibilites.length === 0) {
      alert('⚠️ Ajoutez au moins un véhicule compatible.');
      return;
    }

    if (
      !this.selectedFiles['img_principale'] ||
      !this.selectedFiles['img1'] ||
      !this.selectedFiles['img2']
    ) {
      alert("⚠️ Attention : L'image principale et les images 1 et 2 sont obligatoires !");
      return;
    }

    const formData = new FormData();

    // Champs simples
    Object.keys(this.pieceData).forEach((key) => {
      const value = this.pieceData[key];
      formData.append(key, value !== null && value !== undefined ? value.toString() : '');
    });

    // Colonnes historiques de `pieces` : on y met le premier véhicule,
    // ce qui garde la page d'accueil client fonctionnelle.
    const principal = this.compatibilites[0];
    formData.append('marque', principal.marque);
    formData.append('modele', principal.modele);
    formData.append('annee', principal.annee_min ? String(principal.annee_min) : '');

    // Compatibilités structurées, lues par le contrôleur
    formData.append(
      'compatibilites',
      JSON.stringify(
        this.compatibilites.map((c) => ({
          id_modele: c.id_modele,
          annee_min: c.annee_min,
          annee_max: c.annee_max,
          motorisation: c.motorisation,
        })),
      ),
    );

    Object.keys(this.selectedFiles).forEach((key) => {
      formData.append(key, this.selectedFiles[key]);
    });

    console.log('🚀 Envoi vers Cloudinary et la base de données...');
    this.saving = true;

    this.http.post(`${environment.apiUrl}/pieces/ajouter`, formData).subscribe({
      next: (res: any) => {
        console.log('✅ Succès :', res);
        this.saving = false;
        this.resetForm();
        this.cdr.markForCheck();
        alert(`Succès : ${res.message} (${res.compatibilites} véhicule(s) rattaché(s))`);
      },
      error: (err) => {
        console.error("❌ Erreur lors de l'envoi :", err);
        this.saving = false;
        this.cdr.markForCheck();
        const errorMsg =
          err.error?.message || 'Le serveur ne répond pas. Vérifiez votre connexion.';
        alert('Erreur : ' + errorMsg);
      },
    });
  }

  resetForm(): void {
    this.pieceData = { ...this.initialData };
    this.compatibilites = [];
    this.selection = {
      id_marque: '',
      id_modele: '',
      annee_min: '',
      annee_max: '',
      motorisation: '',
    };
    this.modelesDisponibles = [];
    this.sousCategories = [];
    this.selectedFiles = {};
    this.previews = {};
    this.fileNames = {};
    this.gallery = [];
    this.activeImage = null;
  }
}
