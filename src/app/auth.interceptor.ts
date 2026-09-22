import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { SessionService } from './session.service';
import { environment } from './environnement';

/**
 * Ajoute le jeton aux requêtes vers notre API et gère les 401.
 *
 * À enregistrer dans app.config.ts :
 *   provideHttpClient(withFetch(), withInterceptors([authInterceptor]))
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const session = inject(SessionService);

  // On n'envoie le jeton qu'à notre propre API, jamais à Cloudinary ou ailleurs
  const versNotreApi = req.url.startsWith(environment.apiUrl);
  const jeton = versNotreApi ? session.jeton : null;

  const requete = jeton ? req.clone({ setHeaders: { Authorization: `Bearer ${jeton}` } }) : req;

  return next(requete).pipe(
    catchError((err: HttpErrorResponse) => {
      // Jeton expiré ou invalide : on ferme proprement la session
      if (err.status === 401 && versNotreApi) {
        const code = err.error?.code;
        if (code === 'JETON_EXPIRE' || code === 'JETON_INVALIDE') {
          session.deconnecter(true);
        }
      }
      return throwError(() => err);
    }),
  );
};
