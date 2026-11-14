# EzraBot · React + Three.js

Client web React 19 et TypeScript, servi par le moteur PC fourni dans le dossier de spécifications. Les personnages utilisent les SVG originaux ; Three.js anime une texture issue des mêmes tracés, avec repli SVG sans WebGL. Les animations s’arrêtent en arrière-plan et suivent le mouvement réduit du système.

## Démarrer sur le PC

Node.js 24 ou supérieur et la commande officielle `codex` avec une session locale autorisée sont nécessaires pour les réponses réelles.

```bash
npm ci
npm ci --prefix server
npm start
```

Ouvrir http://127.0.0.1:4317. Les bases de cette copie sont créées dans `server/data/` ; elles sont ignorées par Git. La session Codex est utilisée par le moteur existant, sans lecture ou copie de ses fichiers d’authentification. Aucune clé API n’est ajoutée au client.

Pour utiliser un autre port : `MINO_PORT=4328 npm start`. Ne pas exposer ce port directement sur Internet.

## Compilation et validation locales

```bash
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:ui
```

La compilation produit `server/dist/` et inclut le bundle React et son CSS. `npm start --prefix server` reconstruit également React ; installer les dépendances racine et serveur avant d’utiliser cette commande.

Les tests navigateur démarrent un service temporaire sur 127.0.0.1:4399 avec de nouvelles bases SQLite et un moteur volontairement indisponible. Aucun appel fournisseur n’est effectué. Les tests serveur emploient leurs moteurs contrôlés. Le workflow GitHub Actions compile et exécute les tests serveur sur chaque push et pull request. Les essais navigateur et les copies de protocoles mobiles sont aussi vérifiés dans GitHub Actions. Les captures et vidéos restent dans ses artefacts.

## Services connectés (Composio)

Un personnage peut proposer une action sur un service relié. Vous confirmez chaque action exacte sur le PC, puis le serveur l’envoie une seule fois. La clé se donne au serveur avec `COMPOSIO_API_KEY`. Sans clé, cette fonction est désactivée et le reste ne change pas. Voir [docs/composio.md](docs/composio.md) pour la configuration, les preuves simulées et ce qui n’est pas vérifié avec le vrai service.

Les tests navigateur de cette fonction utilisent un second service temporaire sur 127.0.0.1:4398, avec un faux fournisseur et un faux moteur. Toutes ses données sont synthétiques.

## Plafonds d’appels

Chaque appel Codex et chaque action Composio réserve sa place avant de partir. Par défaut, le serveur admet 1000 appels Codex et 200 actions Composio par jour UTC. Quand un plafond est atteint, l’appel ne part pas et le travail affiche la raison. Pour changer un plafond : `MINO_BUDGETS='{"codex":{"callsPerDay":300}}' npm start`. Voir [docs/admission.md](docs/admission.md) pour les origines des travaux, les états d’une réservation, la reprise après un arrêt et les limites connues.

## Ce que cette version apporte

- Chat Mino, Markdown sans HTML exécutable, invitations @, fils séparés et retours aux messages récents.
- Brouillons isolés par espace et personnage, préservation pendant un envoi, reprise réseau avec le même identifiant, refus serveur explicites.
- Projets avec dossier explicitement autorisé, propositions de mission avec leur message d’origine, choix de responsable pour la coordination, suivi et actions admises par le serveur.
- Documents éditables, versions et restauration, publication exacte dans le carnet local avec confirmation.
- Personnalisation des noms/couleurs et gestion des souvenirs de chaque personnage.
- Interface adaptative, clavier IME, dialogues avec gestion du focus et navigation clavier.

Le serveur, SQLite, les règles d’autorisation et les moteurs Codex proviennent du code `ac097512081dd2a2e73d81d42a7ffa3483a3a493` fourni. Les adaptations serveur exposent la page React et le type de réponse de mission. La mémoire accepte une base de modification pour refuser les écritures concurrentes périmées. La fixture historique `schema-v0.sql`, absente du ZIP, a été récupérée dans le dépôt local source mentionné par PROVENANCE.json.

## Limites explicites

Ce lot livre le client web PC. Le client natif Expo de référence reste dans `server/mobile/`. La page `/devices` conserve l’association PC/téléphone existante ; le nouveau React utilise les routes privées PC `/api/*`, et ne remplace pas le client HTTPS appairé `/m/*`. Aucune application Android/iPhone physique ni paquet natif n’a été compilé dans ce lot.

Les tests contrôlés ne prouvent ni une réponse réelle de Codex ni une connexion physique de téléphone. Les erreurs de moteur sont visibles. La présente copie ne configure pas Tailscale ou les certificats HTTPS et n’effectue aucune migration d’une installation personnelle existante.

Les six parcours sont disponibles dans React : envoi et invitations par identité, tâches et conflits documentaires, missions et décisions, projets avec contrôle, personnages avec mémoire protégée, recherche globale et lecture isolée des résultats. Les réglages du moteur, les formes, la suppression confirmée et le nettoyage des brouillons sont accessibles depuis Personnages. Le client de référence reste disponible sur `/advanced`.

Les réponses IA réelles, les appareils physiques et les accès externes restent hors de la recette automatique. Les commandes incertaines des panneaux restent reprenables tant que leur panneau est ouvert. Le composeur conserve aussi son envoi après rechargement. Une validation ne publie pas un résultat sur Internet.

Les apports retenus et les exclusions sont décrits dans [Apports et reste à vérifier](docs/apports-et-reste.md). Le journal de cette reprise est dans [Décisions](docs/decisions.tsv).
