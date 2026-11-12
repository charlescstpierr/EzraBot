# Règles des agents — EzraBot

Ces règles s’appliquent à tout le dépôt.

## Avant de commencer

- Lire le ticket, les instructions du dépôt et le code concerné.
- Reprendre un ticket existant. Si la demande n’a pas de ticket, en créer un avec son objectif et sa portée.
- Traiter une seule demande par PR. Écarter les changements sans lien avec cette demande.

## Portée et risque

- Décrire ce qui change et les effets possibles.
- Indiquer le risque : **faible**, **moyen** ou **élevé**. Donner une raison courte.
- Signaler les limites et les vérifications non faites. Ne pas annoncer un résultat non observé.

## Commits et titres de PR

- Utiliser un préfixe anglais en minuscules : `fix`, `feat`, `docs`, `test`, `refactor`, `build`, `ci` ou `chore`.
- Ajouter une portée si elle aide à comprendre le changement.
- Écrire le reste en français simple : phrases courtes, verbes directs, mots concrets, selon l’esprit ASD-STE100.
- Exemple : `fix(web): les nouveaux fils ne font plus monter le processeur`.

## Description de la PR

Présenter ces éléments dans cet ordre :

1. **Problème** : le besoin ou le défaut observé.
2. **Correction** : le comportement après le changement et la portée des fichiers modifiés.
3. **Vérification** : les commandes exécutées, leurs résultats et les preuves utiles.
4. **Taille** : recopier l’étiquette GitHub, de XS à XXL. Ne pas inventer la taille. Si aucune étiquette n’est attribuée, écrire « non attribuée » et le signaler. Dès que GitHub ajoute l’étiquette, mettre la description à jour.
5. **Risque** : faible, moyen ou élevé, avec sa raison.
6. **Modèle et outil** : indiquer le modèle et l’outil réellement utilisés.

Terminer par le lien au ticket, par exemple `Closes #12`.

## Vérification et preuves

- Exécuter les vérifications adaptées au changement. La compilation locale reste possible ; utiliser GitHub Actions selon la configuration du dépôt et les instructions du propriétaire.
- Pour un changement d’interface, fournir des images avant et après.
- Si le comportement visible bouge, fournir aussi une vidéo.
- Pour un bogue de logique, fournir un test qui échoue avant la correction et passe après.
- Téléverser les images et les vidéos sur GitHub, puis mettre leurs liens dans la PR. Ne jamais les commiter. Le code du test de régression reste dans le dépôt.
- Pour une modification de documentation seule, vérifier le contenu et le diff. Les images, la vidéo et le test de régression ne sont pas requis.
- Ne jamais inclure de secret, de base personnelle ou de donnée privée dans les preuves.

## Publication et suivi

- Vérifier les fichiers avant de pousser. Exclure les secrets, les bases locales, les données d’exécution et les dépendances installées.
- Lier chaque PR à son ticket avec `Closes #<numéro>`.
- Respecter l’attribution automatique des étiquettes de taille lorsqu’elle est configurée. Ne pas ajouter une automatisation hors de la demande en cours.
- Rapporter les échecs de compilation, de test ou de contrôle. Ne pas les masquer.

## Fusion

- Seul le propriétaire peut fusionner, après son approbation écrite pour cette PR.
- Les agents ne fusionnent jamais, même après cette approbation.
- Ne pas activer la fusion automatique. Ne pas pousser directement sur la branche principale.
