# Validation des parcours React

Les vérifications ci-dessous concernent la reprise du ticket #4. Elles utilisent des données synthétiques et n’appellent aucun fournisseur IA.

## Résultats locaux

- `npm run typecheck` vérifie le client, les tests et le serveur.
- `npm test` compile puis exécute 229 tests serveur. Aucun échec.
- `npm run test:ui` compile puis exécute 49 contrôles Playwright, dont des tests de logique pure et des parcours Chromium.
- `node server/mobile/scripts/sync-contract.mjs --check` confirme les quatre copies de contrats mobiles.
- Le test de mémoire ajoute sept cas. Il refuse une base ancienne, conserve le client sans base et les requêtes rejouées, et couvre une horloge figée ou reculée et un redémarrage.

## Régressions avant et après

Une copie isolée du commit `fb4f305` reproduit les deux défauts du composeur avec les tests commis. Les six tests précédents y passent. Les deux nouveaux tests y échouent : le texte entouré d’espaces n’est pas acquitté, et une mention dans un bloc de code devient une invitation.

Ces deux tests passent dans la nouvelle version. Un test de placement a également échoué sur l’accueil décentré avant correction, puis passe après centrage et suppression du défilement initial sans messages.

La revue indépendante a reproduit quatre défauts supplémentaires. Les régressions vérifient maintenant la révision des missions après redémarrage, le premier démarrage d’une base historique et le recul de l’horloge, le Markdown sans image réseau, la reprise exacte des commandes après rechargement et l’actualisation des décomptes avant suppression.

La synchronisation de la boîte agents conserve aussi une commande étrangère visible si la purge arrive avant l’événement de stockage. Le renouvellement des décomptes de suppression efface la confirmation déjà saisie.

## Portée des scénarios

Les tests de documents démarrent un vrai magasin SQLite et un vrai serveur HTTP, avec un moteur contrôlé par le test. Ils couvrent fragments reçus, tâche sans version, édition pendant génération, conflit, restauration, reprise après coupure, publication exacte, rejet et aperçu HTML isolé.

La recette des personnages crée un compagnon synthétique. Elle ouvre deux éditeurs de son souvenir, vérifie le refus de la seconde base, puis supprime ce compagnon et constate la purge des brouillons dans les deux onglets.

Les tests de missions et projets utilisent des réponses HTTP fabriquées et typées. Ils prouvent les commandes et états présentés par le client. Les tests serveur séparés couvrent le registre, ses autorisations, sa déduplication et ses budgets. Les nouvelles régressions de reprise envoient aussi de vraies commandes au serveur, coupent la réponse après acceptation, puis vérifient le rejeu et l’absence de mission dupliquée. Aucun scénario ne fait appel à un fournisseur IA.

Le test de preuves visuelles remplace `/api/view` par un espace synthétique vide. Ses images montrent la mise en page et son test vérifie aussi le centrage et l’absence de débordement à 390 pixels. Les vidéos Playwright montrent les parcours de recette. Aucune image ni vidéo n’est commise.

## Limites

Le navigateur partagé T3 a perdu sa connexion pour la capture interactive. La recette et les preuves exploitables proviennent donc de Playwright. Aucune vérification physique sur téléphone, aucune distribution native et aucune connexion à un service externe n’a été faite.

Les commandes inconnues du composeur, des projets et des missions restent persistantes après rechargement si le stockage du navigateur est disponible. Les commandes agents sont enregistrées avant l’envoi, puis rejouées uniquement sur demande avec le même identifiant. Une commande incertaine bloque les autres commandes agents jusqu’à sa confirmation, sauf l’arrêt d’une mission. Si le service répond toujours par une erreur technique, ce blocage persiste. Un stockage indisponible est signalé et la reprise reste limitée à la page ouverte. Les commandes documentaires et celles des personnages restent en mémoire tant que leur panneau est ouvert. Le serveur conserve les travaux acceptés après fermeture du navigateur. Un résultat inconnu ne doit pas être considéré comme un échec sans effet.

Les clients historiques qui n’envoient pas `baseUpdatedAt` gardent la dernière écriture gagnante pour les souvenirs. Le client React envoie toujours cette base pour une édition.

## Preuves téléversées

Les [images, vidéos et journaux du ticket 4](https://github.com/charlescstpierr/EzraBot/releases/tag/preuves-ticket-4-20261112) sont publiés comme pièces de preuve. Cette publication ne déploie pas l’application. Elle cible le commit de code `a6ffb6703ac0ae1c30702ea1e818dda8e36024fd`.

Le ZIP des journaux contient aussi les trois conceptions comparées et le contrat retenu. Les artefacts GitHub Actions conservent les résultats de chaque nouvelle recette sur GitHub.


## Corrections de revue et compilation GitHub

Les [preuves des corrections](https://github.com/charlescstpierr/EzraBot/releases/tag/preuves-revue-4-20261112) ciblent le commit `2a62a5ef0641ea530036b38f4606ca61799934de`. Elles contiennent les captures mobiles avant et après, une vidéo de reprise, les résultats des 48 contrôles et les journaux rouges et verts.

La [recette GitHub Actions du même commit](https://github.com/charlescstpierr/EzraBot/actions/runs/43164995715) a réussi. Types, synchronisation mobile, compilation, tests serveur, tests d’interface et téléversement des preuves y passent.

## Continuité du travail et contexte de la politique 12

`server/test/context.test.ts` vérifie les deux récents, les attributions séparées, les graphèmes, les trois enveloppes, les sources du livrable séparé et la lecture des plans historiques. `server/test/memory-flow.test.ts` retire un original présent dans un extrait ancien pendant un appel contrôlé et vérifie l'absence de publication. Les tests du store et des outils vérifient l'identité après redémarrage et le refus de renvoyer un effet inconnu.

Les parcours `continuité29` dans `tests/documents-parcours.spec.ts` utilisent SQLite et un moteur contrôlé. Ils montrent les coupes et la reprise après rechargement, puis le refus de relancer un travail lié à une action inconnue. `CONTINUITY_MOBILE=1` ajoute la capture du composant natif `Work` rendu par React Native Web. Cette preuve exige les dépendances mobiles installées. Elle ne représente pas un essai sur téléphone physique.
