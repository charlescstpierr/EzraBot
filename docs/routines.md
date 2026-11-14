# Routines

Une routine envoie un texte fixe à un personnage, à une heure de votre fuseau. Chaque envoi crée une demande dans le fil, comme un message que vous auriez tapé, mais marquée « Routine ». Elle passe par la même admission et le même worker que le chat.

## Ce que la personne règle

- Le personnage. Il ne change plus après la création. Pour un autre personnage, créez une autre routine.
- Le texte. Texte seul : ni pièce jointe, ni invitation @, ni mode document, ni source choisie.
- L’heure locale `HH:MM` et les jours de la semaine.
- Le fuseau. Une zone nommée, par exemple `America/Toronto`, ou `UTC`. Un décalage fixe comme `+05:00` ou `Etc/GMT+5` est refusé.
- Le dernier jour, au plus 366 jours après aujourd’hui dans ce fuseau.
- Le plafond : de 1 à 366 demandes sur toute la vie de la routine.

Une routine créée est inactive. Avant de l’activer, la page montre les cinq prochains créneaux avec leur décalage UTC. Rien ne part avant « Activer ».

## Quand une demande part

Mino vérifie toutes les 30 secondes, tant que le PC est allumé et que Mino tourne.

- Un créneau est admis jusqu’à 5 minutes de retard. Au-delà, la date est sautée.
- Un créneau manqué pendant que Mino était arrêté est sauté. Au redémarrage, une seule date sautée est inscrite. Aucune rafale de rattrapage.
- L’activation, la reprise et la modification ne regardent que les créneaux futurs, même un créneau passé depuis une minute.
- Une date ne reçoit qu’une décision. Une modification ne la redemande jamais.
- Deux demandes d’une même routine sont séparées d’au moins 60 minutes réelles, même après un changement d’heure ou de fuseau.
- Le compteur de demandes ne revient jamais à zéro. Au plafond, la routine se termine.

Ces chiffres sont des règles produit. Ce ne sont pas des capacités mesurées.

## Changement d’heure

Les jours se comptent sur le calendrier, jamais en ajoutant 24 heures.

- Heure absente au printemps (par exemple 02:30 le 8 mars 2026 à Toronto) : la date est sautée. La demande ne glisse pas à 03:30.
- Heure répétée à l’automne (01:30 le 1er novembre 2026 à Toronto) : une seule demande, au premier passage.

Chaque décision garde l’instant UTC et le décalage utilisés. Une mise à jour de la base des fuseaux ne réécrit pas le passé et ne relance aucune date déjà décidée.

## Ce qui saute une date ou arrête la routine

Mino lit les registres existants, sans en copier l’état.

La date est sautée quand une demande précédente de la routine :

- attend, tourne ou attend une validation ;
- a une publication proposée sans décision ;
- a une action de service proposée, approuvée sans envoi, ou dont le reçu est en cours ;
- a ouvert une mission encore active.

La routine attend votre vérification quand un effet précédent est incertain : un appel du modèle parti sans fin enregistrée, une action de service sans réponse fiable, ou une mission arrêtée sans résultat confirmé. Pour reprendre, confirmez cet effet précis sur le PC. La reprise ne relance rien, ne change pas l’ancien travail, sa réservation ni son approbation. Elle autorise seulement les dates futures. Un nouvel effet incertain demande une nouvelle confirmation, même si la même mission ou une de ses étapes est interrompue une seconde fois.

Un échec certain et terminé, par exemple un budget du jour épuisé, ne bloque pas. Le jour suivant crée une nouvelle demande. L’ancienne n’est jamais remise en file.

## Droits, budget et mémoire

- Une routine n’accorde aucun droit et n’approuve rien. Une action proposée attend votre approbation exacte.
- Chaque demande compte dans le budget Codex commun du jour. Codex n’annonce aucun prix : le coût est indisponible, jamais compté comme zéro. Aucun budget n’est augmenté.
- Pas de recherche ni d’export Honcho pour cette demande. Le fil peut encore fournir les échanges précédents que vous avez autorisés. Après un oubli, ils n’y sont plus.

## Pause, suppression et personnage supprimé

- Une routine en attente de vérification garde cette attente après une demande de pause.
- La pause arrête les prochaines demandes. Elle n’arrête pas un appel déjà parti : utilisez les commandes du travail.
- Supprimer une routine efface ses textes, ses décisions et les empreintes de ses commandes. Les demandes déjà envoyées restent dans le fil.
- Supprimer un personnage efface ses routines avec son fil. La confirmation affiche leur nombre.

## Téléphone

Le téléphone appairé voit les routines et peut mettre en pause ou reprendre une routine en pause. Créer, modifier, activer, supprimer et confirmer un effet incertain se font sur le PC. Le serveur refuse ces commandes du téléphone.

## Limites connues

- Aucun créneau ne part si le PC est éteint ou en veille.
- Une seule heure par jour choisi. Pas d’intervalle, pas de cron libre, pas d’exécution dans le cloud.
- Une mission n’est reliée à une routine que si elle a été ouverte depuis une réponse de cette routine.
