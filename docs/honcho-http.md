# Transport HTTP Honcho

`server/src/honcho-http.ts` prépare la première phase de #30. Il n'a aucun appelant produit. Le raccord chat, mémoire et admission reste à construire après les contrats partagés de #31. Ce module ne constitue pas une implémentation de `HonchoPort`.

## API serveur

`new HonchoHttpClient(config)` reçoit explicitement `baseUrl`, `apiKey`, `workspaceId`, `timeoutMs` et `maxResponseBytes`. Aucun accès à l'environnement. HTTPS est requis. L'option `allowLoopbackHttpForTests` autorise HTTP uniquement sur les adresses littérales `127.0.0.1` et `::1`. Authentification dans l'URL, requête et fragment sont refusés. Un préfixe de chemin d'hébergement est accepté avant `/v3`.

Chaque méthode accepte un `AbortSignal` final facultatif et effectue au plus une requête. Le constructeur ne fait aucun appel. Aucune méthode ne réessaie ni ne provisionne une autre ressource.

| Méthode | Requête | Résultat utile |
| --- | --- | --- |
| `provisionWorkspace(signal?)` | POST `/v3/workspaces`, `{id}` | Identifiant du workspace confirmé |
| `provisionSession({sessionId, peers}, signal?)` | POST `/v3/workspaces/{w}/sessions`, `{id, peers}` | Identifiant de session confirmé |
| `ingestMessages({sessionId, messages}, signal?)` | POST `/v3/workspaces/{w}/sessions/{s}/messages`, `{messages}` | Messages distants validés |
| `searchMessages({query, limit, sessionId?}, signal?)` | POST `/v3/workspaces/{w}/search`, `{query, limit, filters?}` | Candidats distants bornés |
| `getMessage({sessionId, remoteId}, signal?)` | GET `/v3/workspaces/{w}/sessions/{s}/messages/{m}` | Message distant relu |
| `requestWithdrawal(scope, signal?)` | DELETE session ou workspace | Acquittement, purge non vérifiée |

Le provisionnement utilise les routes serveur get-or-create explicites. Les noms provisionnés suivent `[a-zA-Z0-9_-]`, de 1 à 512 caractères. Les pairs sont choisis par l'appelant serveur et portent chacun `peerId`, `observeMe` et `observeOthers`. Le client refuse une liste vide ou dupliquée. Leur autorisation appartient au futur service mémoire.

L'ingestion accepte de 1 à 100 messages avec `peerId`, `text`, puis `metadata` et `createdAt` facultatifs. Les métadonnées d'entrée sont limitées ici aux chaînes. Le transport fixe un plafond local de 100 000 caractères par message, distinct du plafond configurable du serveur Honcho. La recherche accepte de 1 à 100 résultats et peut filtrer une session. Une recherche vide n'atteste pas l'absence de messages, car l'indexation peut être différée.

Les schémas Zod privés valident les champs utiles et la portée de réponse. Les messages retournent `remoteId`, `workspaceId`, `sessionId`, `peerId`, `text` et `createdAt`. Le texte distant et les métadonnées ne prouvent aucune référence locale. Le futur service mémoire doit conserver le mapping SQLite, vérifier la génération, relire les originaux autorisés et établir la provenance. Aucun `sourceId` local n'est fabriqué ici.

## Erreurs et effets distants

Les résultats portent `kind`. `ok` contient la valeur validée. `rejected` indique une entrée refusée, une annulation avant départ ou un refus HTTP. `unavailable` indique une lecture inutilisable. `uncertain` conserve l'incertitude d'une écriture après départ, notamment après délai, annulation, erreur réseau, réponse 5xx, redirection ou réponse illisible. Les catégories ne contiennent ni corps brut, ni clé, ni URL, ni identifiant distant. Aucun journal n'est émis.

Le délai couvre les en-têtes et le corps. Il doit être compris entre 1 et 120 000 millisecondes. Le corps lu est limité par `maxResponseBytes`, de 1 à 4 194 304 octets, y compris sur un flux sans longueur déclarée. Les redirections ne sont jamais suivies. Une écriture incertaine exige un rapprochement par la couche supérieure, jamais une répétition automatique.

`requestWithdrawal({kind: 'message', sessionId, remoteId})` retourne `unsupported` sans requête. Aucune suppression individuelle ni modification de contenu n'est supposée disponible. Pour une session ou un workspace, un 202 valide donne `{kind: 'acknowledged', purge: 'unverified'}`. Ce résultat ne prouve pas la purge des dérivés et n'autorise pas la réouverture d'une portée suspendue. Le transport ne supprime pas automatiquement les sessions d'un workspace qui répond 409.

Le raccord produit DOIT réserver durablement chaque requête avant son départ par l'admission commune de #25. Provisionnement, ingestion, recherche, relecture et retrait nécessitent chacun leur réservation. Aucun callback d'autorisation ni compteur parallèle n'est livré ici. Consentement, mapping, génération, exclusions, environnement enfant et garde de publication restent à la charge du raccord.

## Sources et preuves

Les signatures sont vérifiées dans le code officiel épinglé au commit `5c7d24b32d275bce38daedbe81feaebc31393587` de plastic-labs/honcho.

- [Routes des messages](https://github.com/plastic-labs/honcho/blob/5c7d24b32d275bce38daedbe81feaebc31393587/src/routers/messages.py).
- [Routes des workspaces](https://github.com/plastic-labs/honcho/blob/5c7d24b32d275bce38daedbe81feaebc31393587/src/routers/workspaces.py).
- [Routes des sessions](https://github.com/plastic-labs/honcho/blob/5c7d24b32d275bce38daedbe81feaebc31393587/src/routers/sessions.py).
- [Schémas API](https://github.com/plastic-labs/honcho/blob/5c7d24b32d275bce38daedbe81feaebc31393587/src/schemas/api.py) et [configuration des pairs](https://github.com/plastic-labs/honcho/blob/5c7d24b32d275bce38daedbe81feaebc31393587/src/schemas/configuration.py).

`server/test/honcho-http.test.ts` exerce le vrai `fetch` contre des serveurs synthétiques sur ports dynamiques. Les tests vérifient les requêtes, les réponses malformées, les erreurs HTTP, les limites, les annulations et les redirections. Aucun compte, fournisseur, modèle ou contenu personnel n'est utilisé. La compatibilité avec une instance Honcho réelle reste non prouvée.

Depuis la racine, exécuter `npm run build --prefix server`, puis `node --test server/dist/test/honcho-http.test.js`.
