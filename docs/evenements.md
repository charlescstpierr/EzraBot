# Événements de service

Un abonnement relie un déclencheur Composio à un personnage. Quand le service annonce un événement signé, Mino crée au plus une demande dans le fil de ce personnage, marquée « Événement ». Elle passe par la même admission et le même worker que le chat.

## Configuration du serveur

La réception est éteinte par défaut. Pour l’allumer, donnez ensemble :

- `MINO_EVENTS_TRANSPORT` : nom stable du projet Composio qui signe, en minuscules, chiffres, `_` ou `-`, 40 au plus. Les identifiants d’événements sont gardés sous ce nom, même après un changement de secret.
- `MINO_EVENTS_PORT` : port de l’écouteur, de 1024 à 65535, distinct de `MINO_PORT` et du téléphone.
- `COMPOSIO_WEBHOOK_SECRET` : le secret de signature du webhook, 16 caractères visibles au moins.
- `COMPOSIO_WEBHOOK_SECRET_PREVIOUS` (facultatif) : l’ancien secret pendant une rotation. Retirez-le quand le fournisseur n’en signe plus.
- `MINO_EVENTS_BIND` (facultatif) : adresse IP d’écoute. Par défaut `127.0.0.1`.

Une configuration incomplète arrête Mino avec un message. Les deux secrets sont lus puis retirés de l’environnement avant le démarrage du moteur. Aucun secret, signature ou corps reçu n’entre dans la base, les vues, le téléphone, le modèle ou le journal.

L’écouteur sert une seule route, `POST /events/composio`. Il ne partage ni cookie, ni origine, ni session avec le PC ou le téléphone. Mino ne crée rien chez Composio : le webhook, son URL publique et le déclencheur se configurent chez le fournisseur. Rendre ce port joignable (tunnel, relais) reste à la charge de la personne qui administre le PC.

## Ce que Mino vérifie avant d’écrire

Sur les octets bruts, avant toute lecture du JSON :

- un seul en-tête `webhook-id`, `webhook-timestamp`, `webhook-signature` et `x-composio-webhook-version` ;
- une signature `v1` HMAC-SHA256 sur `id.horodatage.corps`, avec le secret courant ou le précédent, comparée en temps constant ;
- un horodatage en secondes décimales, à 300 secondes au plus de l’horloge du PC ;
- la version `V3`, un corps de 64 Kio au plus, reçu en 10 secondes au plus.

Puis : l’`id` du corps égal à `webhook-id`, le type `composio.trigger.message`, et l’utilisateur du fournisseur égal au propriétaire local des comptes. Le parseur du SDK n’est pas utilisé : il remplace l’identifiant de l’événement par celui du déclencheur.

Une signature fausse donne 401. Une forme, une portée ou une heure invalide donne 400. Un corps trop long donne 413. Aucune de ces réponses n’écrit quoi que ce soit.

## Un événement, une décision

Chaque événement porte un `webhook-id`, stable entre les nouvelles tentatives du fournisseur. Mino garde un reçu par transport et identifiant, pour toujours.

- Le reçu est lu avant l’abonnement. Le même identifiant reçoit la même réponse, même après une pause, une révocation, un redémarrage ou la perte d’un acquittement.
- Le même identifiant avec un autre corps donne 409. Rien n’est remplacé ; un compteur le montre.
- Un déclencheur qu’aucun abonnement ne nomme est acquitté et seulement compté.
- Le reçu et la demande sont écrits dans la même transaction, avant la réponse HTTP. Un échec avant la fin n’écrit rien ; le fournisseur renvoie, et une seule demande naît.
- Au-delà de 10 000 identifiants gardés pour un transport, un nouvel identifiant reçoit 503 sans rien écrire. Les identifiants déjà gardés répondent toujours.

Un abonnement connu peut refuser : inactif, en pause, révoqué, personnage supprimé, autre type d’événement, autre compte, compte dont le dernier état connu n’est pas actif, limite du jour, ou 3 demandes de cet abonnement pas encore terminées. Le refus est un reçu : il reste visible et ne se rejoue pas.

Ces chiffres sont des règles produit, pas des capacités mesurées.

## L’abonnement

Sur le PC, page « Événements de service », ouverte depuis la page Routines ou depuis une demande d’événement dans le fil. Le personnage, le compte, le déclencheur et le transport ne changent jamais. Un abonnement créé est inactif. L’activation exige la réception configurée et un compte dont le dernier état connu est `ACTIVE`.

On règle la consigne, les champs copiés et la limite par jour (1 à 50, 20 au départ). Chaque modification, pause, reprise ou révocation fait avancer la révision. Un deuxième onglet resté sur l’ancienne révision est refusé.

Au plus 20 abonnements par transport, révoqués compris. Un déclencheur révoqué reste lié à son abonnement : pour un autre usage, configurez un nouveau déclencheur chez le fournisseur.

## Ce que la demande contient

La consigne entière, le type d’événement, l’alias du compte, puis seulement les champs de premier niveau nommés par l’abonnement. Aucun champ par défaut. Chaque valeur est coupée à 500 caractères, 4 000 au total, avec une marque visible. Une valeur composée (objet, liste) n’est pas importée et la demande le dit. Le corps brut n’est jamais gardé, seulement son empreinte, effacée à la révocation.

Le contenu reçu reste une donnée non fiable. Il ne choisit ni le personnage, ni un droit, ni un destinataire.

## Droits, départ et mémoire

- Une demande d’événement n’accorde aucun droit et n’approuve rien. Elle reçoit une réponse ou un livrable proposé. Aucun outil de service ne lui est offert, ni offre de connexion, ni mission, même si le moteur les renvoie.
- Avant le rappel mémoire, le claim, le départ du modèle et la publication, Mino vérifie que le reçu existe, que l’abonnement est actif à la même révision, que la réception est configurée et que le compte est actif. Sinon rien ne part et rien n’est publié.
- La pause et la révocation annulent les demandes pas encore parties, dans la même transaction, et arrêtent un appel en cours. Un appel déjà parti garde son usage ; rien n’est relancé. Une réponse déjà terminée reste.
- « Relancer » est refusé quand l’abonnement a bougé. Une nouvelle demande écrite par la personne reste possible.
- Pas de recherche ni d’export Honcho pour cette demande.
- Chaque demande compte dans le budget Codex commun. Codex n’annonce aucun prix : le coût est indisponible, jamais compté comme zéro. Aucun budget n’est augmenté et la réception ne fait aucun appel au fournisseur.

## Téléphone

Le téléphone voit les abonnements de chaque personnage : type, état, compte, compteurs du jour et dernière décision. Cette liste ne contient ni la consigne configurée, ni la liste des champs, ni les identifiants du fournisseur. Le téléphone peut seulement mettre un abonnement en pause. Les demandes admises restent visibles dans son fil, avec leur consigne et les valeurs copiées, comme sur le PC.

## Personnage supprimé

L’abonnement devient révoqué. Sa consigne, ses champs, les empreintes de corps et les empreintes de ses commandes sont effacés. L’identité de l’abonnement et les décisions restent, pour qu’un événement rejoué ne recrée rien. Le lien vers une demande effacée devient vide.

## Preuves locales

Les tests serveur (`server/test/events.test.ts`, `server/test/devices.test.ts`) utilisent une vraie base SQLite temporaire, le store, le worker et des requêtes HTTP signées. Le test navigateur `tests/evenements-parcours.spec.ts` utilise le service temporaire de 127.0.0.1:4397, avec un transport, un secret et un compte synthétiques. Dans ce seul service de test, l’écouteur signé partage le port du PC, faute de port de test libre ; le vrai serveur lui donne son propre port.

## Limites connues

- Les preuves utilisent un faux fournisseur qui signe comme la documentation l’indique. Aucun webhook Composio réel n’a été reçu. La compatibilité avec le vrai service n’est pas démontrée.
- L’état du compte est le dernier observé par ce serveur. Une révocation faite chez le fournisseur et pas encore vue n’est pas connue.
- La durée des nouvelles tentatives du fournisseur et le chevauchement des secrets lors d’une rotation ne sont pas documentés : Mino ne suppose ni l’un ni l’autre.
- Les valeurs composées et les chemins dans le corps ne sont pas importés dans cette version.
