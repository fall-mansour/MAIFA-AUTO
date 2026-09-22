import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';

export interface Utilisateur {
  id: number;
  nom: string;
  prenom: string;
  mail: string;
  role: 'client' | 'gestionnaire';
  telephone?: string;
  adresse?: string;
  vehicule?: string;
  avatar?: string;
}

interface SessionStockee {
  token: string;
  expiration: number; // millisecondes
  user: Utilisateur;
}

/**
 * Session authentifiée par jeton signé côté serveur.
 *
 * Le jeton porte sa propre date d'expiration, vérifiée par le serveur
 * à chaque requête. Ce service en tient une copie pour deux usages :
 * afficher l'état de connexion, et déconnecter automatiquement à échéance
 * plutôt que de laisser l'utilisateur découvrir le problème sur une erreur.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly CLE = 'teranga_session';

  /** Avertissement affiché ce nombre de minutes avant l'échéance */
  private readonly ALERTE_MINUTES = 5;

  private readonly platformId = inject(PLATFORM_ID);
  private readonly router = inject(Router);

  private _session = signal<SessionStockee | null>(null);
  private _bientotExpiree = signal(false);
  private minuteur?: any;
  private minuteurAlerte?: any;

  readonly utilisateur = computed(() => this._session()?.user ?? null);
  readonly estConnecte = computed(() => this._session() !== null);
  readonly estGestionnaire = computed(() => this._session()?.user.role === 'gestionnaire');
  readonly prenom = computed(() => this._session()?.user.prenom ?? '');
  readonly bientotExpiree = this._bientotExpiree.asReadonly();

  /** Minutes restantes avant expiration, pour l'affichage */
  readonly minutesRestantes = computed(() => {
    const exp = this._session()?.expiration;
    if (!exp) return 0;
    return Math.max(0, Math.round((exp - Date.now()) / 60000));
  });

  constructor() {
    this.restaurer();
  }

  private get navigateur(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  // ==========================================================
  //  CONNEXION / DÉCONNEXION
  // ==========================================================

  /** Appelé après une réponse de /api/connexion */
  connecter(reponse: { token: string; expiration: number; user: Utilisateur }): void {
    const session: SessionStockee = {
      token: reponse.token,
      // Repli à 2h si le serveur n'a pas renvoyé l'échéance
      expiration: reponse.expiration || Date.now() + 2 * 60 * 60 * 1000,
      user: reponse.user,
    };

    this._session.set(session);
    this._bientotExpiree.set(false);

    if (this.navigateur) {
      try {
        localStorage.setItem(this.CLE, JSON.stringify(session));
      } catch (e) {
        console.warn('Session non conservée :', e);
      }
      this.programmerExpiration(session.expiration);
    }
  }

  /** @param expiree true si la déconnexion vient de l'échéance du jeton */
  deconnecter(expiree = false): void {
    this._session.set(null);
    this._bientotExpiree.set(false);
    this.annulerMinuteurs();

    if (this.navigateur) {
      localStorage.removeItem(this.CLE);

      if (expiree) {
        // On ne redirige que si la page en cours nécessitait une session
        const protegee = ['/Dashboard', '/stock', '/ajoutpieces', '/commandes'].some((p) =>
          this.router.url.startsWith(p),
        );
        if (protegee) this.router.navigate(['/login'], { queryParams: { expiree: 1 } });
      }
    }
  }

  /** Jeton pour l'en-tête Authorization, null si absent ou périmé */
  get jeton(): string | null {
    const s = this._session();
    if (!s) return null;

    if (s.expiration <= Date.now()) {
      this.deconnecter(true);
      return null;
    }
    return s.token;
  }

  // ==========================================================
  //  EXPIRATION
  // ==========================================================

  /** Deux minuteurs : un avertissement, puis la déconnexion */
  private programmerExpiration(expiration: number): void {
    this.annulerMinuteurs();

    const restant = expiration - Date.now();
    if (restant <= 0) return this.deconnecter(true);

    const avant = restant - this.ALERTE_MINUTES * 60 * 1000;
    if (avant > 0) {
      this.minuteurAlerte = setTimeout(() => this._bientotExpiree.set(true), avant);
    } else {
      this._bientotExpiree.set(true);
    }

    this.minuteur = setTimeout(() => this.deconnecter(true), restant);
  }

  private annulerMinuteurs(): void {
    if (this.minuteur) clearTimeout(this.minuteur);
    if (this.minuteurAlerte) clearTimeout(this.minuteurAlerte);
    this.minuteur = undefined;
    this.minuteurAlerte = undefined;
  }

  /** Relit la session au démarrage. Sans effet côté serveur (SSR). */
  private restaurer(): void {
    if (!this.navigateur) return;

    try {
      const brut = localStorage.getItem(this.CLE);
      if (!brut) return;

      const session: SessionStockee = JSON.parse(brut);

      // Jeton déjà périmé : on nettoie sans rediriger
      if (!session.token || session.expiration <= Date.now()) {
        localStorage.removeItem(this.CLE);
        return;
      }

      this._session.set(session);
      this.programmerExpiration(session.expiration);
    } catch {
      localStorage.removeItem(this.CLE);
    }
  }
}
