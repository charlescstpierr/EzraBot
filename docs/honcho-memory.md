# Mémoire Honcho

Le ticket #30 raccorde Honcho au chat. Un personnage qui a un projet de mémoire reçoit, pour chaque demande de sa conversation, une mémoire bornée faite de vos originaux relus. Honcho est alors sa seule mémoire longue. Cette fonction est désactivée tant que le serveur n'a pas de configuration, de budget et votre accord.

## Ce que voit la personne

Sans configuration Honcho, rien ne change : les souvenirs locaux d'un personnage restent envoyés au moteur.

Avec une configuration, la page d'un personnage propose « Passer à la mémoire Honcho ». Les limites sont dites avant l'accord. Vous nommez le projet, vous cochez l'accord, et le serveur prépare un espace Honcho neuf.

Ensuite :

- Vos demandes écrites dans la conversation du personnage et vos déclarations sont envoyées à Honcho. Les réponses des personnages et les fichiers joints ne le sont pas.
- Les souvenirs locaux ne sont plus envoyés au moteur. Vous choisissez ceux à importer. Chacun devient une déclaration et quitte la liste locale.
- Sous une réponse, « Mémoire utilisée : N sources » ouvre la liste exacte des sources. Une demande rappelée s'ouvre sur son message d'origine. Une déclaration affiche sa révision.
- Vous corrigez ou excluez une déclaration. Vous excluez une demande depuis la conversation.
- « Oublier » ferme la mémoire tout de suite. Le serveur demande ensuite le retrait à Honcho.
- Après un oubli, « Ouvrir un nouvel espace vide » repart d'un espace au nom neuf.

Le téléphone montre l'état de la mémoire. Toutes les commandes se font sur le PC.

## Configuration du serveur

| Variable | Rôle |
| --- | --- |
| `HONCHO_BASE_URL` | Adresse HTTPS du serveur Honcho. Un préfixe de chemin avant `/v3` est accepté. |
| `HONCHO_API_KEY` | Clé envoyée en `Authorization: Bearer`. |
| `HONCHO_WORKSPACE_PREFIX` | Préfixe des noms d'espace créés par ce serveur. Lettres, chiffres, `_` ou `-`, 40 au plus. |
| `HONCHO_TIMEOUT_MS` | Facultatif. Délai par requête, 8000 par défaut. |

Les trois premières variables se donnent ensemble. Si une seule manque ou est invalide, le serveur refuse de démarrer et dit pourquoi. Si aucune n'est donnée, la mémoire Honcho est absente et aucun appel n'est possible.

Le serveur lit ces variables une fois, puis retire toute variable `HONCHO_*` de son environnement avant de créer les moteurs. Les processus enfants ne les reçoivent jamais.

Un budget explicite est aussi requis :

```bash
MINO_BUDGETS='{"honcho":{"callsPerDay":300}}' npm start
```

Sans budget `honcho`, l'admission refuse chaque requête et la page le dit. Les plafonds Codex et Composio ne changent pas.

Pour régler ce plafond : ouvrir un projet coûte trois appels. Une demande dans la conversation en coûte trois aussi : une recherche, une ingestion et une relecture. Une déclaration en coûte deux.

## Chemin d'une demande

1. Vous envoyez une demande. Si la conversation a un projet ouvert, le store enregistre ce message comme source dans la même transaction.
2. Le guichet (`memory-desk.ts`) envoie la source à Honcho, une source par requête. Il compare la réponse à l'original : un seul message, même pair, même session, même texte. Il relit ensuite l'identifiant distant par un GET. Le mapping compte seulement après cette relecture.
3. Avant de prendre le tour, le worker demande au store ce que le prochain tour doit rappeler. Le store réserve une recherche. Le guichet l'envoie hors de toute transaction SQLite.
4. `claimNext` relit tout dans une seule transaction : projet, génération, mapping vérifié, état des sources. Il compose le texte une fois et calcule son empreinte une fois. Si le tour pris n'est pas celui du rappel, il répond `replan` et rien n'est pris. Après trois plans, le tour part sans rappel.
5. Le texte envoyé au moteur contient vos originaux locaux, jamais le texte renvoyé par Honcho. Il reçoit d'abord les déclarations vérifiées, puis les demandes trouvées. Le tout tient en 10 éléments et 4 000 unités UTF-16.
6. Le store vérifie de nouveau la mémoire avant le départ du tour, à chaque écriture de progression d'un document, et avant toute publication.

## Données SQLite

La migration 11 ajoute ces tables dans `mino.sqlite`. Aucun texte distant ni profil dérivé n'y est écrit.

| Table | Contenu |
| --- | --- |
| `memory_scopes` | Un projet par personnage : identifiant propre, nom saisi, génération, état, espace courant. |
| `memory_workspaces` | Les noms d'espace distants. Une ligne n'est jamais supprimée : un nom ne resert pas. |
| `memory_sessions` | Les sessions `declarations` et `conversation` de chaque espace. |
| `memory_sources` | Une ligne par version d'une source. Une déclaration porte son texte tant qu'elle est autorisée. Une demande renvoie à son message. |
| `memory_exports` | La copie d'une source dans un espace : en attente, ingérée, vérifiée, incertaine, refusée ou annulée, avec son identifiant distant. |
| `memory_requests` | Une ligne par requête HTTP, avec l'espace et la génération capturés à la réservation. |
| `attempt_memory`, `attempt_sources`, `attempt_replies` | Le manifeste d'un appel : son projet, sa génération, ses sources et les réponses antérieures que son texte contenait. |

États d'un projet : `preparing`, `active`, `withdrawal_pending`, `withdrawal_unverified`, `reset_pending`. Des triggers interdisent tout retour en arrière. Une source retirée ne redevient jamais autorisée.

## Admission

Chaque requête HTTP a sa propre réservation avant de partir. Les capacités sont `honcho.provision`, `honcho.ingest`, `honcho.read`, `honcho.search` et `honcho.withdraw`, toutes sur le budget `honcho`. Leur coût est indisponible : il est compté comme appel sans prix, jamais comme zéro.

La cible réservée porte la génération du projet. Une requête réservée avant une correction, une exclusion, un oubli ou un nouvel espace ne part pas : l'admission refuse son permis.

Le permis est pris dans le même tour d'exécution que le `fetch`. Le guichet ne réessaie rien.

## Correction, exclusion, oubli

Ces trois commandes avancent la génération du projet.

- **Correction.** Une nouvelle version est créée. L'ancienne perd son texte local. Les autres déclarations restent utilisables.
- **Exclusion.** La source n'est plus rappelée ni relue. Sa copie reste chez Honcho jusqu'à un oubli : Honcho n'offre pas de retrait par message. La conversation propose « Exclure de la mémoire » seulement sous une demande qui est encore une source du projet. Après un nouvel espace vide, une demande oubliée ou écrite pendant l'oubli ne le propose plus.
- **Oubli.** Le projet est fermé dans la même transaction, avant toute réponse de Honcho. Toutes ses sources sont retirées. Le serveur demande le retrait des deux sessions, puis de l'espace.

Un retrait est transitif. Un appel dont le texte contenait une source retirée est marqué. Un appel qui a reçu la réponse d'un appel marqué l'est aussi. Les réponses et les livrables de ces appels quittent tous les contextes suivants. Vos messages restent affichés dans la conversation.

Un tour en cours est arrêté. Le store enregistre un échec « La mémoire de cette conversation a changé » : aucun message, aucune version, aucune proposition n'est publié. Relancer la demande recompose tout.

Une action préparée par un tour dont la mémoire ne tient plus ne part pas. Dans la transaction du retrait, le registre des actions ferme les propositions encore ouvertes et annule les approbations pas encore envoyées. L'approbation et le dernier contrôle avant l'envoi relisent la mémoire du tour d'origine. Si elle ne tient plus, aucun appel ne part vers le service et le budget des services ne bouge pas. La carte dit qu'une source de la mémoire a été corrigée, exclue ou oubliée. Un envoi déjà parti garde son reçu et n'est jamais rejoué. Une action d'un autre projet, ou d'un tour sans mémoire, ne change pas.

Un accusé 202 ne prouve aucun effacement. Après un oubli, le projet reste fermé (`withdrawal_unverified`). Seul un nouvel espace vide, confirmé par vous, le rouvre. Rien d'ancien n'y est envoyé : ni déclaration, ni historique, ni requête en vol.

## Pannes et reprise

- Recherche en panne ou budget épuisé : le tour répond sans aucune mémoire, déclarations comprises. Le projet garde son état.
- Ingestion sans réponse : la source reste incertaine. Elle n'est jamais renvoyée.
- Arrêt du serveur : une requête partie devient incertaine, une requête réservée est libérée. Rien ne repart seul.
- « Reprendre » est le seul rapprochement. Pour une copie incertaine, le serveur cherche dans la session un message de même texte et de même pair. Il le retient seulement s'il est unique, puis le relit. Sinon la source reste incertaine.
- Un espace que Honcho connaissait déjà (réponse 200) est refusé. « Reprendre » essaie un nom neuf.

## Limites connues

- La mémoire sert dans la conversation du personnage. Les documents, les comptes rendus d'action et les réponses d'un personnage invité partent sans mémoire.
- Une recherche est payée avant la prise du tour. Si le plafond Codex refuse ensuite le tour, elle est perdue.
- Une correction ou une exclusion retire aussi du contexte les anciennes réponses composées avec la source. Un travail documentaire dont un appel a été retiré ne reçoit plus de nouvel appel.
- Une correction, une exclusion, un oubli ou un nouvel espace vide ferme toutes les actions du projet préparées avant et pas encore envoyées, même celles dont le tour n'avait pas reçu la source retirée : la génération du projet a avancé. Demandez de nouveau l'action.
- Un 201 atteste une création. Il ne prouve pas qu'un fournisseur hostile n'avait aucune donnée sous ce nom.
- Un personnage dont la mémoire est ouverte ne se supprime pas. Il faut d'abord l'oublier.
- EzraBot ne demande aucune conclusion dérivée à Honcho. Le pair `person` est créé sans observation.

## Vérifications

`server/test/memory-flow.test.ts` exerce le vrai store, le vrai worker, le vrai guichet et le vrai serveur HTTP devant un faux Honcho sur un port local et le faux App Server. `tests/honcho-parcours.spec.ts` exerce l'interface PC devant les mêmes faux.

```bash
npm run build --prefix server
node --test --test-concurrency=1 server/dist/test/memory-flow.test.js
npx playwright test tests/honcho-parcours.spec.ts
```

Aucun compte, aucune clé réelle et aucune instance Honcho n'ont été utilisés. La compatibilité avec une instance Honcho réelle n'est pas prouvée. Les routes viennent du code officiel épinglé cité dans [honcho-http.md](honcho-http.md).
