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

## Pièces jointes du ticket 11

La branche des pièces jointes intègre `1e113fb` de la PR #12. Les bulles, les personnages et le style de cette PR restent la base de l'interface.

La recette utilise `MINO_QA_PORT=4401 MINO_QA_TOOLS_PORT=4402 npx playwright test`. Les données SQLite et les comptes de service sont synthétiques. Les ports de l'application installée et du chantier d'interface ne sont pas utilisés.

Les contrôles couvrent les images PNG, JPEG et WebP, le dossier mixte avec chemins relatifs, le retrait, un message sans texte, le rechargement d'une image conservée dans IndexedDB et la reprise d'une réponse perdue. Cette reprise compare la commande entière, y compris son identifiant et ses octets. La suppression est contrôlée dans deux onglets puis dans IndexedDB. Les fichiers PDF, les images corrompues et les images de plus de 4 Mio sont refusés sans modifier le brouillon.

Les tests serveur vérifient les formes historiques `{name,text}`, les limites, les chemins interdits, la migration et la réouverture SQLite, le conflit d'une reprise, la suppression, le hash du contexte et les entrées natives exactes de Codex. Un appareil jumelé envoie un lot au-delà de l'ancien plafond de 256 Kio. Son aperçu exige une authentification. La vue générale ne contient aucun base64.

Le Codex installé est `0.167.2`. Son schéma local `turn/start` accepte `image` avec `url`. Le catalogue réel annonce les images pour `gpt-6.1-sol`. Un seul tour réel de vision a reçu un PNG synthétique avec un carré bleu sur fond blanc, au travers de `createCodexEngine` et `composeContext`. Il a répondu « Je vois un carré bleu sur fond blanc. ». Aucun fichier privé ni conversation de la personne n'a été utilisé. Les permissions du moteur restent en lecture seule, sans accès réseau ni outil de fichiers.

La migration SQLite 7 ajoute `mime_type`, `base64` et `relative_path` à la table existante. Les textes historiques sont conservés sans ajout de discriminant. Les images gardent leur colonne `text` vide. La politique de contexte passe de 8 à 9, car le commit de départ utilisait déjà la version 8.

Le serveur contrôle le base64 canonique, la taille et la signature annoncée. Le navigateur contrôle aussi le décodage de l'image. Le serveur ne fait pas une analyse complète des codecs. Les fichiers PDF, DOCX, HEIC et SVG ne sont pas interprétés comme images. Aucune extraction PDF ni refonte du client mobile natif n'est incluse. Le collage et le dépôt concernent des fichiers, pas un parcours récursif des dossiers déposés. Les dossiers se choisissent avec le sélecteur dédié.

La validation finale passe les types, la compilation, la synchronisation des quatre contrats mobiles, 286 tests serveur et 67 tests d'interface. Le test de hash et de conflit vérifie aussi un changement des octets et de leur ordre. Une ancienne assertion d'interface attendait le refus de toute image ; elle attend maintenant le refus d'une image corrompue. Les premières exécutions rouges ont aussi permis de corriger le validateur base64 des gros fichiers et la notification du stockage entre onglets.
