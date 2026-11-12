# Services connectés avec Composio

Ce document décrit l’intégration Composio d’EzraBot (ticket #6).
Il sépare quatre choses : ce qui est installé, ce que les tests simulés prouvent, la configuration, et ce qui n’est pas vérifié avec le vrai service.

## 1. Résumé

Un personnage peut proposer une action sur un service relié, par exemple l’envoi d’un courriel.
Vous voyez le service, le compte, l’action et le contenu exacts.
Vous approuvez ou vous refusez sur le PC.
Le serveur envoie l’action une seule fois.
Le personnage reçoit le résultat et vous en rend compte dans le même fil.

Rien n’est exécuté sans votre confirmation. Cela vaut aussi pour les lectures.

**État de la preuve : doublures seulement. Aucune connexion réelle à Composio n’est prouvée.**
Aucune clé n’a été fournie pendant ce travail. Voir les sections 4 et 8.

## 2. Ce qui est installé

### Côté serveur

| Fichier | Rôle |
|---|---|
| `server/src/tools-protocol.ts` | Contrat réservé au PC : commandes, vues et réponses. Il n’est pas copié vers le client mobile. |
| `server/src/tool-ledger.ts` | Grand livre SQLite : comptes, liens, droits, propositions, reçus. Il utilise la base du store. Il ne fait aucun appel réseau. |
| `server/src/composio.ts` | Seul fichier qui importe `@composio/core`. Il rend des données simples et des catégories d’erreur. |
| `server/src/tool-desk.ts` | Guichet : il lit le fournisseur, puis il demande la décision au grand livre. Il porte les routes `/api/tools/*`. |
| `server/src/child-env.ts` | Retire les variables `COMPOSIO_*` de l’environnement des processus Codex. |
| `server/src/engine.ts` | Le moteur du chat accepte les appels `item/tool/call` de ses propres outils. Tout le reste est refusé comme avant. |
| `server/src/context.ts` | Règles du tour avec outils, et règles du tour de compte rendu. |

Le paquet `@composio/core` est fixé à la version exacte `0.29.0`. `ajv` est fixé à `8.20.0`.

### Côté React

| Endroit | Ce que vous y faites |
|---|---|
| Préférences, section « Services connectés » | Relier un compte d’un service du catalogue. Vérifier sa connexion. |
| Page d’un personnage, section « Services connectés » | Choisir un compte et les outils que ce personnage peut proposer. Retirer un droit. |
| Fil de conversation | Lire la carte exacte de l’action. Approuver ou refuser. Lire le reçu. Relancer un compte rendu en échec. |
| Composeur | Le choix « Utiliser les services connectés » apparaît seulement si le personnage a des droits. |

### Ce qui ne change pas

- Le moteur des documents et le moteur des missions n’ont aucun outil Composio.
- MCP, la recherche web et les outils natifs de Codex restent désactivés.
- Le client mobile ne voit pas les services. Il ne peut ni donner un droit, ni approuver, ni relancer.
- Sans clé, EzraBot fonctionne comme avant.

## 3. Comment une action se déroule

1. Vous écrivez au personnage. Le serveur fige ses droits pour ce tour.
2. Le personnage appelle un outil. Le serveur enregistre une **proposition** et répond tout de suite. Rien n’est envoyé.
3. Le personnage termine sa réponse. La carte apparaît sous son message.
4. Vous approuvez. Le serveur relit le compte et l’outil chez le fournisseur. Si quelque chose a changé, la proposition est périmée et rien n’est envoyé.
5. Le serveur note l’envoi dans la base **avant** l’appel réseau. Puis il envoie une fois.
6. Le serveur enregistre le reçu. Le même travail lance un tour de compte rendu, sans outil.
7. Le personnage écrit le compte rendu dans le même fil.

### États visibles sur la carte

| État | Sens |
|---|---|
| En attente de votre décision | Rien n’est envoyé. |
| Refusée | Rien n’a été envoyé. |
| Périmée | Le droit, le compte ou l’outil a changé. Rien n’a été envoyé. |
| Annulée avant l’envoi | Une vérification a échoué après l’approbation. Rien n’a été envoyé. |
| Le service confirme l’exécution | Le fournisseur a répondu `completed`. |
| Le service signale un échec | Le fournisseur a répondu `failed`. |
| Bloquée | Le fournisseur a bloqué l’action, ou il demande une saisie. EzraBot ne répond pas à sa place. |
| Résultat inconnu | La réponse n’est pas arrivée, ou EzraBot s’est arrêté pendant l’envoi. L’action a peut-être eu lieu. EzraBot ne la renvoie jamais. |

Un compte rendu en échec se relance avec un bouton. Ce bouton relance seulement le résumé. Il ne renvoie pas l’action.

### Règles fixes

- Une seule proposition par tour.
- Une proposition ne change jamais après son enregistrement.
- Une approbation donne au plus un envoi. La base refuse tout retour en arrière.
- Les outils internes de Composio (`COMPOSIO_*` : recherche, exécution groupée, proxy, code, connexions) ne sont jamais donnés à un personnage.
- Un outil sans version annoncée ne peut pas être donné. La raison est affichée.
- Un personnage a un seul compte par service.
- Le résultat externe est une donnée non fiable. Il n’est jamais une consigne pour le personnage.

## 4. Configurer la clé

La clé se donne au serveur seulement, par la variable d’environnement `COMPOSIO_API_KEY`.

```bash
COMPOSIO_API_KEY=... npm start
```

- Le serveur lit la clé une fois au démarrage, puis il la retire de son environnement.
- La clé ne va jamais au navigateur, au modèle, au client mobile, aux journaux ou à la base.
- Ne mettez pas la clé dans un fichier suivi par Git.
- Sans clé, les préférences affichent « Aucune clé Composio n’est configurée ». Aucun personnage ne reçoit d’outil.

Dans le projet Composio, il faut au moins une configuration d’authentification activée de type OAuth 2 pour le service voulu.
Les autres méthodes (clé d’API, par exemple) sont listées comme indisponibles dans EzraBot.

## 5. Relier un compte et donner des droits

1. Ouvrez **Préférences**, section **Services connectés**.
2. Choisissez **Relier un service**. La liste vient du catalogue réel du projet Composio.
3. Donnez un nom au compte. Ce nom apparaît ensuite sur les cartes d’action.
4. Choisissez **Préparer la connexion**, puis **Ouvrir la page de connexion**. La page s’ouvre chez le fournisseur.
5. Revenez dans EzraBot. Choisissez **Vérifier la connexion**.
   Le serveur relit le compte chez Composio. Seule cette relecture rend un compte actif.
6. Ouvrez la page du personnage, section **Services connectés**.
7. Choisissez le compte, puis **Voir les outils de ce compte**.
8. Cochez les outils. Enregistrez. Les droits du personnage sur ce service deviennent exactement cette sélection.

L’adresse de connexion est donnée une fois, à la page qui l’a demandée. Elle n’est pas enregistrée.

## 6. Le choix du composeur

Quand un personnage a des droits, le composeur affiche « Utiliser les services connectés ». Il est coché au départ.

- **Coché** : le message reste dans la conversation. Le personnage peut proposer une action.
- **Décoché** : l’envoi habituel s’applique. Une demande de document part en mode document, sans service.

Un personnage sans droit garde l’envoi habituel. Ce choix n’existe pas pour lui.

## 7. Ce que les tests simulés prouvent

Tous ces tests utilisent des doublures. Tous les comptes, actions, adresses et résultats sont synthétiques.

| Suite | Ce qu’elle utilise | Ce qu’elle prouve |
|---|---|---|
| `server/test/child-env.test.ts` | Vrais moteurs, faux Codex | Aucun processus Codex ne reçoit une variable `COMPOSIO_*`. |
| `server/test/tool-ledger.test.ts` | Vrai store SQLite | Migration, droits vides au départ, proposition unique et immuable, approbation exacte, un seul permis d’envoi, reprise après arrêt, compte rendu, suppression. |
| `server/test/composio.test.ts` | Faux SDK avec les signatures du paquet publié | Session épinglée, contrôle du catalogue de la session qui exécute, un seul appel `execute`, catégories d’erreur. Un test construit le vrai client du SDK avec une clé synthétique et intercepte la requête : elle va à l’adresse fixe avec la clé explicite. |
| `server/test/engine.test.ts` | Vrai moteur, faux Codex | Aller-retour `item/tool/call`, identifiant texte ou nombre, appel précoce, mauvais tour, mauvais fil, espace de noms, outil inconnu, demande native refusée. |
| `server/test/tools-flow.test.ts` | Vrai store, vrai worker, vrai HTTP, vrai moteur, faux Codex, faux fournisseur | Toute la chaîne : 0 envoi avant l’approbation, 1 envoi après. Origine et jeton. Schéma périmé. Révocation. Arrêt pendant l’envoi. Compte rendu en échec. |
| `server/test/devices.test.ts` | Vrai serveur des téléphones | Un téléphone associé reçoit 422 pour chaque commande `tools.*`. Sa vue n’a pas de champ `tools`. |
| `tests/composio-parcours.spec.ts` | Navigateur, serveur de recette 4398 | Parcours React complet, résultat inconnu, relance du compte rendu, reprise après rechargement, absence de clé (port 4399). |

Commandes :

```bash
npm run typecheck
npm test
node server/mobile/scripts/sync-contract.mjs --check
npm run test:ui
```

## 8. Ce qui n’est pas vérifié

Ces points demandent une clé réelle et un compte autorisé. Ils n’ont pas été exécutés.

- Une connexion OAuth réelle et un compte `ACTIVE` chez Composio.
- Une exécution réelle d’outil.
- Un aller-retour `item/tool/call` avec le vrai Codex et un vrai modèle. Seul l’enregistrement des outils est prouvé sur le Codex installé.
- La présence d’une version dans le catalogue brut réel. Si Composio n’en rend pas, aucun outil ne peut être donné. Il faudrait alors une décision écrite du propriétaire.
- L’acceptation par Composio d’une adresse de retour locale `http://127.0.0.1`. Le bouton **Vérifier la connexion** fonctionne sans ce retour.
- Les demandes que Codex peut envoyer quand son API expérimentale est active (heure courante, attestation). EzraBot les refuse et arrête le tour. L’effet réel n’est pas observé.

### Contrôle réel, par le propriétaire seulement

Ce script contacte le vrai service. Il lit seulement. Il ne lance aucune connexion et n’exécute aucun outil.

```bash
# Arrêtez EzraBot d’abord.
npm run build
COMPOSIO_API_KEY=... node server/tools/verify-composio.mjs --owner-run
```

Il affiche des nombres et des booléens : services du catalogue, comptes reconnus, outils listés, outils avec version.

Pour vérifier la chaîne complète, le propriétaire :

1. démarre EzraBot avec la clé ;
2. relie un compte de test ;
3. donne un outil de lecture à un personnage ;
4. demande une action dans le chat, lit la carte, approuve ;
5. compare le reçu avec le journal du service chez Composio.

## 9. Limites connues

- **Pas de verrou de version chez le fournisseur.** `session.execute` ne prend pas de version. EzraBot relit le catalogue de la session qui va exécuter et compare la version et le schéma. Entre cette lecture et l’exécution, le fournisseur peut encore changer.
- **Pas d’exécution unique garantie chez le fournisseur.** EzraBot n’envoie jamais deux fois. Il ne peut pas empêcher un doublon interne au service.
- **Une approbation enregistrée juste avant un arrêt est envoyée une fois au redémarrage.** Les vérifications sont refaites à ce moment.
- **Fournisseur injoignable après l’approbation :** l’action est annulée avant l’envoi. Il n’y a pas de nouvel essai automatique.
- **OAuth 2 seulement** pour relier un compte depuis EzraBot.
- **Pas de suppression de compte** depuis EzraBot. Retirez les droits, puis supprimez le compte chez Composio.
- **Le nom du compte** est celui que vous donnez. EzraBot ne lit pas l’adresse du compte chez le service.
- **Les schémas d’outil viennent du fournisseur.** Un schéma illisible ou trop grand rend l’outil indisponible.
- **Une demande de document avec le choix coché** reste dans la conversation. Décochez le choix pour le mode document.

## 10. Secrets et données

- La clé et les objets du SDK restent dans `server/src/composio.ts`.
- Le SDK reçoit la clé explicitement et une adresse fixe. Ses autres sources (environnement, fichier du dossier personnel) sont désactivées. Sa télémétrie est désactivée.
- Les erreurs du fournisseur deviennent des catégories : `unauthorized`, `not_found`, `rate_limited`, `timeout`, `unavailable`. Le texte brut n’est pas gardé.
- Le résumé d’un résultat est limité à 16 Kio. Les champs dont le nom ressemble à un secret sont retirés.
- L’identité du propriétaire chez Composio est un UUID privé, créé dans la base. Il n’est jamais affiché.
- Les journaux du guichet contiennent une action, un succès et une catégorie. Rien d’autre.
- Les routes `/api/tools/*` demandent le jeton de session du PC. Les écritures demandent aussi l’origine exacte. Seul le retour de connexion `/api/tools/callback` est ouvert ; il ne fait que relire le compte chez le fournisseur.
