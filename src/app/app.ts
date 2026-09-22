import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Ajoutpieces } from './Gestion/ajoutpieces/ajoutpieces';
import { Dashboard } from './Gestion/dashboard/dashboard';
import { Stock } from './Gestion/stock/stock';
import { Acceuil } from './Client/acceuil/acceuil';
import { PieceDetail } from './Client/piece/piece';
import { PanierPage } from './Client/panier/panier';
import { Commandes } from './Gestion/commandes/commandes';
import { DemandeComponent } from './Client/demande/demande';

@Component({
  selector: 'app-root',
  imports: [
    Acceuil,
    RouterOutlet,
    Ajoutpieces,
    Dashboard,
    Stock,
    PieceDetail,
    PanierPage,
    Commandes,
    DemandeComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = signal('gestion');
}
