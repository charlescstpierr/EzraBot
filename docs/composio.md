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

**État de la preuve : parcours Composio simulés et transport d’outil vérifié avec le vrai Codex. Aucune connexion réelle à Composio n’est prouvée.**
Aucune clé n’a été fournie pendant ce travail. Voir les sections 4 et 8.

## 2. Ce qui est installé

### Côté serveur

| Fichier | Rôle |
|---|---|
| `server/src/tools-protocol.ts` | Contrat réservé au PC : commandes, vues et réponses. Il n’est pas copié vers le client mobile. |
| `server/src/tool-ledger.ts` | Grand livre SQLite : comptes, liens, droits, propositions, reçus. Il utilise la base du store. Il ne fait aucun appel réseau. |
| `server/src/source.ts` | Version de document figée avec une demande : relecture, empreinte du contenu, comparaison avec la dernière version. |
| `server/src/connection.ts` | Demande de connexion proposée par un personnage : une ligne par tour, le service nommé et le lien lancé depuis la carte. Aucun état de compte, aucun appel réseau. |
| `server/src/composio.ts` | Seul fichier qui importe `@composio/core`. Il rend des données simples et des catégories d’erreur. |
| `server/src/tool-desk.ts` | Guichet : il lit le fournisseur, puis il demande la décision au grand livre. Il porte les routes `/api/tools/*`. |
| `server/src/child-env.ts` | Retire les variables `COMPOSIO_*` de l’environnement des processus Codex. |
| `server/src/engine.ts` | Le moteur du chat accepte les appels `item/tool/call` de ses propres outils. Tout le reste est refusé comme avant. |
| `server/src/context.ts` | Règles du tour avec outils, règles du tour de compte rendu, et champ `connection` de la réponse quand une clé est configurée. |

Le paquet `@composio/core` est fixé à la version exacte `0.29.0`. `ajv` est fixé à `8.20.0`.

### Côté React

| Endroit | Ce que vous y faites |
|---|---|
| Préférences, section « Services connectés » | Relier un compte d’un service du catalogue. Vérifier sa connexion. |
| Page d’un personnage, section « Services connectés » | Choisir un compte et les outils que ce personnage peut proposer. Retirer un droit. |
| Fil de conversation | Lire la carte exacte de l’action. Approuver ou refuser. Lire le reçu. Relancer un compte rendu en échec. Relier un compte depuis la carte de connexion qu’un personnage propose. Voir la section 5. |
| Composeur | Le choix « Utiliser les services connectés » apparaît seulement si le personnage a des droits. |
| Page d’un document | Préparer une action depuis la version que vous lisez. Voir la section 3. |

### Ce qui ne change pas

- Le moteur des documents et le moteur des missions n’ont aucun outil Composio.
- MCP, la recherche web et les outils natifs de Codex restent désactivés.
- Le client mobile ne voit pas les services. Il ne peut ni donner un droit, ni approuver, ni relancer, ni relier un compte. Il lit seulement le texte du personnage, qui renvoie au PC.
- Le personnage ne reçoit aucun outil de connexion. Il nomme un service dans sa réponse, rien de plus.
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
| Périmée | Le droit, le compte, l’outil ou le document source a changé. Rien n’a été envoyé. |
| Annulée avant l’envoi | Une vérification a échoué après l’approbation. Rien n’a été envoyé. |
| Le service confirme l’exécution | Le fournisseur a répondu `completed`. |
| Le service signale un échec | Le fournisseur a répondu `failed`. |
| Bloquée | Le fournisseur a bloqué l’action, ou il demande une saisie. EzraBot ne répond pas à sa place. |
| Résultat inconnu | La réponse n’est pas arrivée, ou EzraBot s’est arrêté pendant l’envoi. L’action a peut-être eu lieu. EzraBot ne la renvoie jamais. |

Un compte rendu en échec se relance avec un bouton. Ce bouton relance seulement le résumé. Il ne renvoie pas l’action.

### Préparer une action depuis une version de document

1. Ouvrez un document et lisez la version voulue. Une ancienne version convient : choisissez **Lire la version N** dans l’historique.
2. Dans **Action sur un service connecté**, choisissez **Préparer une action avec la version N**. La conversation du document s’ouvre. Un bandeau nomme la version source.
3. Écrivez votre demande et envoyez. Le serveur relit la version et la fige avec la demande : son identité, l’empreinte de son contenu et la dernière version du document à cet instant.
4. Le personnage reçoit le texte complet de cette version, comme une donnée. La carte de l’action montre le service, le compte, l’action, le contenu exact et la version source.
5. Vous approuvez. Le serveur relit la source à l’approbation, puis une dernière fois dans la transaction qui note l’envoi.

Ce bouton ne donne aucun droit. Il utilise les droits que le personnage de la conversation a déjà. Sans clé, ou si ce personnage n’a aucun droit, le bouton est désactivé et la raison est écrite dessous. Le serveur refuse aussi la demande, et rien n’est créé.

Seule une version enregistrée peut servir de source. La demande porte deux identifiants, jamais un texte. Une saisie non enregistrée désactive le bouton.

Si vous choisissez la version 1 alors que la version 2 est la dernière, la carte le dit : « ancienne version : la version actuelle était la 2 ». Le serveur ne remplace jamais la version choisie par la dernière.

Dès que le document reçoit une nouvelle version (modification, restauration, résultat adopté), toute action préparée depuis ce document et pas encore partie est fermée :

- une proposition en attente devient **Périmée : le document source a changé depuis votre demande** ;
- une action approuvée mais pas encore envoyée est **Annulée avant l’envoi**.

Cela vaut aussi pour une ancienne version choisie exprès : son texte n’a pas changé, mais le document a avancé depuis votre décision. Préparez de nouveau l’action depuis le lecteur. Une action déjà envoyée, ou de résultat inconnu, ne change pas et ne repart jamais.

Limites de ce parcours :

- La version source et la demande sont dans la même conversation. Une source ne se combine pas avec des @ ni avec le mode document.
- Le lien porte sur la demande et sur l’empreinte approuvée. Il ne prouve pas que le contenu de l’action recopie la version : le personnage peut la résumer ou la reformuler. Relisez le contenu exact sur la carte.
- Une version enregistrée après que le serveur a noté l’envoi n’arrête pas cet envoi.
- Le client mobile ne peut pas envoyer de version source. Le serveur des téléphones refuse la commande.

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

1. Ouvrez **Préférences**, section **Services connectés**. Le catalogue se charge automatiquement.
2. Choisissez le service, puis **Connecter**. Le nom du service sert de nom de compte par défaut. Pour distinguer plusieurs comptes, ouvrez **Nom du compte (facultatif)**.
3. Terminez la connexion dans la fenêtre du fournisseur. Si le navigateur bloque la fenêtre, utilisez **Ouvrir la page de connexion**.
4. Revenez dans EzraBot. La vérification reprend au retour et continue pendant deux minutes au maximum. Seule la relecture du compte chez le fournisseur rend le compte connecté.
5. Si la connexion attend encore ou échoue, **Réessayer la vérification** contrôle la même demande. Ce bouton ne crée pas une autre connexion. Après rechargement ou réouverture des préférences, les demandes en attente restent dans la liste. Choisissez **Vérifier la connexion** pour reprendre celle voulue. Une ancienne demande ne bloque pas **Connecter** et ne déclenche aucun contrôle automatique.
6. Ouvrez la page du personnage, section **Services connectés**.
7. Choisissez le compte, puis **Voir les outils de ce compte**.
8. Cochez les outils. Enregistrez. Les droits du personnage sur ce service deviennent exactement cette sélection.

L’adresse de connexion reste transitoire dans la page qui l’a demandée. Elle ne va pas au stockage du navigateur ni à la vue durable. Un rechargement permet de vérifier le lien existant, mais ne permet pas de rouvrir son ancienne adresse.
Aucun droit n’est donné par la connexion. Les parcours Composio sont testés avec un fournisseur simulé, sans clé réelle. La validation du transport avec le vrai Codex ne prouve pas une connexion réelle à Composio.

### Relier un compte depuis le fil

Quand votre demande exige un service que le personnage ne peut pas utiliser, il peut proposer une **carte de connexion** sous sa réponse.

1. Lisez la carte. Elle nomme le service proposé. Rien n’a encore été demandé au fournisseur.
2. Choisissez **Connecter**. La fenêtre du fournisseur s’ouvre, comme dans les préférences. Si le navigateur la bloque, utilisez **Ouvrir la page de connexion**.
3. Revenez dans EzraBot. La carte relit le compte chez le fournisseur pendant deux minutes au maximum. **Vérifier maintenant** relit tout de suite.
4. Quand la carte affiche « Compte connecté », choisissez **Voir les droits** pour ouvrir la page du personnage. Donnez-y les droits voulus, comme aux étapes 6 à 8.

Après un rechargement ou un redémarrage, la carte retrouve son état. Elle ne contrôle rien toute seule : **Vérifier la connexion** reprend le lien existant, **Relancer la connexion** en crée un nouveau. Une erreur du fournisseur laisse la carte telle quelle.

Le nom du service vient du personnage. EzraBot le compare seulement au catalogue de ce serveur, au moment du clic. Un service absent du catalogue, non connectable, ou présent avec plusieurs configurations n’est pas relié depuis la carte ; la carte l’indique.

### Demande de connexion, compte connecté, droit attribué

Ces trois choses sont distinctes. Aucune n’entraîne la suivante.

| Chose | Qui la crée | Ce qu’elle permet |
|---|---|---|
| Demande de connexion | Le personnage, dans sa réponse. | Rien. C’est une proposition affichée dans le fil. |
| Compte connecté | Vous, dans la fenêtre du fournisseur. EzraBot le constate seulement en relisant le fournisseur. | Rien pour le personnage. Le compte devient disponible dans les pages des personnages. |
| Droit attribué | Vous, dans la page du personnage. | Le personnage peut proposer cette action. Chaque action attend encore votre confirmation. |

Un personnage sans droit reste sans droit après la connexion. Une action refusée reste refusée. Aucun tour du personnage ne part quand un compte devient connecté.

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
| `server/test/source-flow.test.ts` | Les mêmes pièces, plus le vrai moteur de documents | Version source figée : 0 envoi avant l’approbation, 1 après. Ancienne version choisie exprès. Nouvelle version ou droit retiré après la préparation, puis après l’approbation : 0 envoi. Texte modifié ou source disparue hors d’EzraBot : 0 envoi. Budget épuisé. Arrêt et délai dépassé sans second envoi. Refus du serveur sans rien créer. |
| `server/test/connection.test.ts` | Vrai store SQLite | Une demande par tour sous la bonne réponse, sans lien, compte ni droit. Nom de service invalide ou interne ignoré. Rien sans clé, ni en compte rendu, ni en document. État suivi sur le lien seulement. Gardes de la base. Suppression. Migration. |
| `server/test/connection-flow.test.ts` | Vrai store, vrai worker, vrai HTTP, vrai moteur, faux Codex, faux fournisseur | 0 appel au fournisseur avant le clic. Connecté seulement après relecture. Aucun droit après connexion. Deux onglets : un seul lancement. Clic périmé refusé. Panne, service inconnu ou ambigu : demande intacte. Reprise après redémarrage. Adresse absente de la base, de la vue et des journaux. Origine et jeton. |
| `server/test/devices.test.ts` | Vrai serveur des téléphones | Un téléphone associé reçoit 422 pour chaque commande `tools.*`. Sa vue n’a pas de champ `tools`. |
| `tests/composio-parcours.spec.ts` | Navigateur, serveur de recette 4398 | Parcours React complet, résultat inconnu, relance du compte rendu, reprise après rechargement, absence de clé (port 4399). |
| `tests/connexion-fil-parcours.spec.ts` | Navigateur, serveur de recette 4398 | Carte sous la réponse sans appel au fournisseur. Double clic : une fenêtre, un lancement. État connecté après le retour. Droits toujours vides. Fenêtre bloquée, attente après rechargement sans contrôle automatique, échec puis relance, largeur 390. Service hors catalogue. Compte déjà connecté. Droits déjà donnés. |
| `tests/source-parcours.spec.ts` | Navigateur, serveur de recette 4398 | Depuis le lecteur : état sans droit, saisie non enregistrée, ancienne version, bandeau du composeur, carte avec sa version source, approbation, carte périmée après une nouvelle version. |

Commandes :

```bash
npm run typecheck
npm test
node server/mobile/scripts/sync-contract.mjs --check
npm run test:ui
```

La recette finale passe : typage, 352 tests serveur, quatre contrats mobiles identiques et 70 tests navigateur.

### Transport avec le vrai modèle

Le 12 novembre 2026, Codex `0.167.2` avec `gpt-6.1-sol` a appelé une fois un outil local neutre. Le test vérifie les arguments et un accusé aléatoire que seul l’outil retourne. Il ne contacte pas Composio.

La première sonde a échoué : les fonctions enregistrées sans espace de noms restaient invisibles au modèle. Le moteur les regroupe maintenant dans `ezrabot_services`, avec `features.code_mode.direct_only_tool_namespaces`. Le moteur de code reste désactivé. Les appels d’un autre espace de noms sont refusés. Ce réglage suit le [code officiel de Codex 0.167.2](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/core/src/config/mod.rs).

Pour refaire ce contrôle avec votre connexion Codex existante :

```bash
npm run build
node server/tools/verify-dynamic-tools.mjs --live
```

Cette commande utilise un vrai tour de modèle. Sans `--live`, elle s’arrête avant de lancer Codex. Le résultat attendu contient `verified: true`, `calls: 1` et `composioCalled: false`. Ce dernier champ est une constante : le script ne charge aucun code Composio.

## 8. Ce qui n’est pas vérifié

Ces points demandent une clé réelle et un compte autorisé. Ils n’ont pas été exécutés.

- Une connexion OAuth réelle et un compte `ACTIVE` chez Composio.
- Une exécution réelle d’outil.
- Le champ `connection` rempli par le vrai modèle. Les tests utilisent un faux Codex. Le schéma reprend la forme du champ `handoff` déjà envoyé au vrai moteur, mais aucun tour réel n’a été lancé avec lui. Le choix du nom de service par le modèle n’est donc pas observé.
- Une connexion OAuth réelle lancée depuis la carte du fil.
- La chaîne complète entre le vrai modèle et un vrai outil Composio. La sonde ci-dessus vérifie seulement le transport vers un outil local neutre.
- La présence d’une version dans le catalogue brut réel. Si Composio n’en rend pas, aucun outil ne peut être donné. Il faudrait alors une décision écrite du propriétaire.
- L’acceptation par Composio d’une adresse de retour locale `http://127.0.0.1`. Le bouton **Vérifier la connexion** fonctionne sans ce retour.
- Les autres demandes que Codex peut envoyer quand son API expérimentale est active (heure courante, attestation). EzraBot les refuse et arrête le tour. La sonde réelle n’en a rencontré aucune ; les autres situations restent non observées.

### Contrôle réel, par le propriétaire seulement

Ce script contacte le vrai service. Il lit le catalogue, les comptes et les outils. La liste des outils crée des sessions chez Composio. Il ne lance aucun parcours OAuth et n’exécute aucun outil.

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

- **Délai dépassé :** le serveur annule la requête du SDK. Une exécution déjà envoyée reste de résultat inconnu et ne repart pas. Annuler la requête ne peut pas annuler un effet déjà produit chez le service.
- **Pas de verrou de version chez le fournisseur.** `session.execute` ne prend pas de version. EzraBot relit le catalogue de la session qui va exécuter et compare la version et le schéma. Entre cette lecture et l’exécution, le fournisseur peut encore changer.
- **Pas d’exécution unique garantie chez le fournisseur.** EzraBot n’envoie jamais deux fois. Il ne peut pas empêcher un doublon interne au service.
- **Une approbation enregistrée juste avant un arrêt est envoyée une fois au redémarrage.** Les vérifications sont refaites à ce moment.
- **Fournisseur injoignable après l’approbation :** l’action est annulée avant l’envoi. Il n’y a pas de nouvel essai automatique.
- **OAuth 2 seulement** pour relier un compte depuis EzraBot.
- **Un service par réponse.** Un personnage propose au plus une connexion par tour.
- **Plusieurs configurations d’un même service :** la carte du fil ne choisit pas. Reliez ce compte depuis les préférences.
- **Compte supprimé chez le fournisseur après la connexion :** la vérification d’un lien ne change rien quand le fournisseur ne connaît plus le compte. La carte et les préférences peuvent donc encore afficher « connecté ». Une approbation relit le compte et périme alors la proposition.
- **Lancement interrompu :** si EzraBot s’arrête entre la demande au fournisseur et l’enregistrement du lien, le fournisseur garde une demande sans suite. L’adresse n’a jamais été remise au navigateur, donc aucun compte ne peut en naître. La carte revient à son état et vous relancez.
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
- Une demande de connexion garde le nom du service et le lien lancé. L’adresse de connexion existe seulement dans la réponse HTTP du lancement et dans la page qui l’a reçue. Elle n’est jamais écrite dans un message, le contexte du modèle, la base ou un journal.
- Le modèle ne reçoit ni catalogue, ni compte, ni lien, ni état de connexion.
- Les routes `/api/tools/*` demandent le jeton de session du PC. Les écritures demandent aussi l’origine exacte. Seul le retour de connexion `/api/tools/callback` est ouvert ; il ne fait que relire le compte chez le fournisseur.


## Journal de décisions

Les premières entrées de `composio-decisions.tsv` sont rétrospectives. Leur colonne `recorded_at` indique le premier commit qui les contient, `8f6c93b`, à 14:55:57 UTC. Les heures initialement saisies ne provenaient pas d’un relevé et certaines étaient futures. Elles ont été retirées. Les dates des commits et les journaux de commandes restent les preuves d’exécution.
