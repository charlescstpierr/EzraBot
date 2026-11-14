# Admission des appels

Chaque appel payant ou à effet externe réserve sa place avant de partir. Le registre vit dans `mino.sqlite`, table `reservations`. Le chat, les documents, les missions et l'envoi Composio l'utilisent tous.

## Origine d'un travail

Un travail est créé par une seule fonction du store, `admitWork`. Elle enregistre son origine dans la table `origins` : `human`, `routine`, `event`, `voice` ou `checkin`.

- Le message d'une personne arrive par `store.dispatch`. Son occurrence est le `requestId` de la commande.
- Une origine automatique arrive par `store.admit`. Son occurrence est fournie par l'appelant, par exemple l'identifiant d'une routine et l'heure prévue.

La même occurrence, pour le même personnage, crée un seul travail. La redemander avec le même contenu retourne le premier travail. La redemander avec un autre contenu est refusé.

Une origine automatique est une donnée pour le tour. Elle n'accorde aucun droit et n'approuve aucune proposition. Le texte envoyé au modèle le dit, et une action Composio exige toujours l'approbation exacte de la personne sur le PC.

## Plafonds livrés

Le compteur est remis à zéro à minuit UTC.

| Budget | Capacités | Plafond par jour | Coût par appel |
| --- | --- | --- | --- |
| `codex` | `codex.chat`, `codex.document`, `codex.mission` | 1000 appels | indisponible : l'abonnement ChatGPT n'annonce aucun prix |
| `composio` | `composio.action` | 200 actions | indisponible : Composio n'annonce aucun prix par action |

Un coût est `known`, `estimated` ou `unavailable`. Un coût indisponible n'est jamais compté comme zéro. Il exige un plafond d'appels. Un coût connu ou estimé exige en plus un plafond de dépense dans la même devise.

Une capacité absente de cette table n'admet aucun appel. Lui donner un budget ne suffit pas : le code du serveur doit aussi la déclarer.

Quand le serveur a une configuration Honcho, il déclare aussi `honcho.provision`, `honcho.ingest`, `honcho.read`, `honcho.search` et `honcho.withdraw` sur le budget `honcho`. Ce budget n'a aucun plafond par défaut : tant que `MINO_BUDGETS` ne le nomme pas, aucune requête Honcho ne part. Voir [honcho-memory.md](honcho-memory.md).

## Régler un plafond

Donnez `MINO_BUDGETS` au serveur. La valeur est un objet JSON. Chaque clé est un budget.

```bash
MINO_BUDGETS='{"codex":{"callsPerDay":300}}' npm start
```

Un plafond de dépense s'écrit en millionièmes de l'unité de la devise :

```json
{"recherche":{"callsPerDay":50,"spendPerDay":{"currency":"USD","micros":2000000}}}
```

Si la valeur est invalide, le serveur refuse de démarrer et dit pourquoi. Au démarrage, la ligne de journal `budgets` donne l'usage du jour.

## Vie d'une réservation

1. `reserved` : la place est prise. Une transaction a vérifié le plafond.
2. `started` : le permis est utilisé. Le moteur le prend dans le même instant que la requête `turn/start`. Pour Composio, il est pris dans la transaction qui écrit `dispatching`, avant l'envoi.
3. `settled` : l'appel a une fin enregistrée.

Deux autres fins existent :

- `released` : le permis n'a jamais servi. La place est rendue.
- `unknown` : le permis a servi et aucune fin n'est enregistrée. La place reste prise.

Le permis est refusé si le travail est annulé, si un arrêt est demandé, ou si l'objectif a changé depuis la réservation. Un permis utilisé ne se redonne pas. La base refuse tout retour en arrière.

Une réservation ne sert que le jour UTC où elle est prise. Si le jour change avant le départ, le permis non utilisé est libéré et l'appel est refusé. Une reprise explicite réserve dans le budget du nouveau jour.

Quand le plafond est atteint, l'appel ne part pas. Le travail ou la tentative échoue avec la raison. Relancez-le quand le plafond le permet.

## Après un arrêt brutal

Au démarrage, le store traite ses propres appels : un permis non utilisé est libéré, un permis utilisé devient `unknown`.

Les missions vivent dans `missions.sqlite`. Le registre des missions rapproche les deux bases :

- Une réservation dont la tentative n'a jamais démarré de tour est libérée.
- Un permis utilisé dont la tentative a une fin enregistrée est réglé.
- Tout autre cas devient `unknown`.

Rien ne repart seul. Une reprise demande une action de la personne et crée une nouvelle tentative, avec une nouvelle réservation.

## Limites connues

- Les lectures Composio (catalogue, compte, outils) ne sont pas comptées. Seul l'envoi d'une action l'est.
- Si `mino.sqlite` et `missions.sqlite` sont restaurées depuis une copie prise au même instant, une réservation peut être libérée alors que son appel est parti après la copie. Le serveur ne détecte pas ce cas.
- Aucun écran n'affiche les compteurs. Une action Composio annulée par le plafond s'affiche « une vérification a échoué ».
- Aucune routine, aucun événement, aucune voix et aucun bilan n'appelle encore `store.admit`. Le fil n'affiche pas encore l'origine d'une demande.
- Aucune capacité livrée n'a de prix. Les coûts connus et estimés sont vérifiés avec des capacités de test.
- Le moteur du chat n'a ni shell, ni outil de fichier, ni réseau. Le moteur des missions peut lire des fichiers hors du dossier du projet : ses lectures ne sont pas confinées.
