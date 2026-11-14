# Contrat de sélection Honcho

Le ticket #26 a préparé le raccord choisi dans #15 et suivi dans #16. Ce module ne fait aucun appel et n'écrit rien. Le raccord livré par #30 est décrit dans [honcho-memory.md](honcho-memory.md). Honcho est la seule mémoire longue.

## Schémas

`server/src/honcho-contract.ts` définit les schémas d'une source, d'une portée, d'une requête et d'une réponse de rappel, et la fonction de sélection. L'interface `HonchoPort` de #26 est supprimée : le raccord a besoin d'une réservation durable par requête, qu'un port asynchrone unique aurait cachée. Le registre `memory-ledger.ts` et le guichet `memory-desk.ts` tiennent ce rôle.

Les origines admises sont un message local identifié ou une déclaration locale enregistrée. Une déclaration du panneau mémoire ne devient pas un faux message. Le module accepte seulement des références d'originaux. Il ne traite ni profils ni inférences ni synthèses libres du fournisseur.

## Contrôle local

`selectHonchoRecall` est une fonction pure. Son entrée contient la portée courante, la requête initiale, la réponse distante, les originaux relus et les exclusions courantes. L'appelant est l'autorité locale. Les originaux et la portée ne doivent jamais venir du fournisseur ou du modèle.

La fonction refuse un schéma invalide, une portée suspendue, un autre projet ou workspace, une génération périmée, une indisponibilité ou des identifiants locaux ambigus. Elle écarte les références absentes, exclues, remplacées, de mauvaise révision ou d'un autre projet. Le texte retourné vient uniquement de l'original autorisé. Une origine et une révision accompagnent chaque extrait.

Une correction marque l'ancienne source `corrected`, conserve son lien `replacedBy` et avance la génération. Les déclarations actuelles et les autres sources restent utilisables. Un oubli avance aussi la génération, conserve les exclusions et place la portée en `withdrawal_pending`. Sans preuve suffisante, elle reste `withdrawal_unverified`. `reset_pending` suspend le rappel pendant la préparation d'un workspace différent et vide. Aucun ACK ne change ces états dans ce module. Aucune fonction ne prétend vérifier la purge fournisseur.

Chaque requête admet de 1 à 10 extraits et de 1 à 4 000 unités UTF-16 au total pour leurs textes. Une réponse contient au plus 100 références. Les extraits suivent leur ordre, sans doublon. La coupe conserve les paires UTF-16 et signale `truncated`. Les métadonnées ne sont pas comprises dans cette enveloppe de texte. Ce plafond reste distinct du budget des derniers tours.

## Ce que la sélection ne fait pas

La sélection ne réserve rien et ne protège pas seule une réponse déjà composée. Le store relit droits, originaux, exclusions et génération avant la composition, au départ du tour et avant toute publication. Il tient aussi les transitions durables : correction, exclusion, oubli, confirmation d'un workspace vide et import volontaire. Voir [honcho-memory.md](honcho-memory.md).

Les tests `server/test/honcho-contract.test.ts` utilisent des sources synthétiques et la vraie fonction pure. Ils ne prouvent aucune capacité fournisseur. Aucun profil dérivé local n'est créé.
